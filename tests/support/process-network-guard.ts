const realFetch = globalThis.fetch.bind(globalThis);
const forbiddenPorts = new Set([47778, 47779, 11434]);
const allowedPorts = new Set(
  (process.env.ORACLE_TEST_ALLOWED_PORTS || '')
    .split(',')
    .filter(Boolean)
    .map(Number),
);

for (const port of allowedPorts) {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535 || forbiddenPorts.has(port)) {
    throw new Error(`[test-safety] refusing unsafe subprocess port: ${port}`);
  }
}

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(
    typeof input === 'string' || input instanceof URL ? input : input.url,
  );
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!loopback || forbiddenPorts.has(port) || !allowedPorts.has(port)) {
    throw new Error(`[test-safety] subprocess network access is disabled: ${url.origin}`);
  }
  return realFetch(input as RequestInfo | URL, init);
}) as typeof fetch;
