export interface TestNetworkRegistry {
  allow: (port: number) => void;
  release: (port: number) => void;
}

type TestServer = ReturnType<typeof Bun.serve>;

const activeServers: TestServer[] = [];

function networkRegistry(): TestNetworkRegistry {
  const registry = (globalThis as typeof globalThis & {
    __oracleTestNetworkRegistry?: TestNetworkRegistry;
  }).__oracleTestNetworkRegistry;
  if (!registry) throw new Error('Oracle test network registry is unavailable');
  return registry;
}

export function startProxyFixture(
  handler: (request: Request) => Response | Promise<Response>,
  timeoutMs = 100,
): { baseUrl: string; timeoutMs: number } {
  const registry = networkRegistry();
  const bindErrors: unknown[] = [];
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const port = 49_152 + Math.floor(Math.random() * (65_535 - 49_152));
    let server: TestServer;
    try {
      server = Bun.serve({ hostname: '127.0.0.1', port, fetch: handler });
    } catch (error) {
      bindErrors.push(error);
      continue;
    }
    try {
      registry.allow(server.port);
    } catch (error) {
      server.stop(true);
      throw error;
    }
    activeServers.push(server);
    return { baseUrl: `http://127.0.0.1:${server.port}`, timeoutMs };
  }
  throw new AggregateError(bindErrors, 'could not allocate a safe test port after 8 attempts');
}

export function cleanupProxyFixtures(): void {
  const registry = networkRegistry();
  const errors: unknown[] = [];
  for (const server of activeServers.splice(0)) {
    try {
      server.stop(true);
    } catch (error) {
      errors.push(error);
    }
    try {
      registry.release(server.port);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'proxy fixture cleanup failed');
}
