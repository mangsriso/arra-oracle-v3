/**
 * Shared CLI server fixture. Always owns a dedicated temp server; never reuses
 * the production endpoint or another developer process.
 */
import {
  startIsolatedHttpServer,
  type IsolatedHttpServer,
} from "../support/isolated-http-server.ts";

export let BASE_URL = "http://127.0.0.1:9";
let fixture: IsolatedHttpServer | null = null;

export async function ensureServer(): Promise<void> {
  if (fixture) return;
  fixture = await startIsolatedHttpServer("oracle-cli-http");
  BASE_URL = fixture.baseUrl;
  process.env.ORACLE_API = BASE_URL;
}

export async function stopServer(): Promise<void> {
  if (!fixture) return;
  await fixture.stop();
  fixture = null;
  BASE_URL = "http://127.0.0.1:9";
  process.env.ORACLE_API = BASE_URL;
}
