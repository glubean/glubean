import type { TestContext } from "@glubean/sdk";

/**
 * Shared HTTP client for the Glubean demo's mock backend.
 *
 * Reads config from the TestContext (NOT process.env) because Glubean
 * loads `.env` / `.env.secrets` into `ctx.vars` / `ctx.secrets`, not the
 * harness subprocess's environment:
 *   - MOCK_BACKEND_URL        → .env          → ctx.vars
 *   - DEMO_BACKEND_CALLER_KEY → .env.secrets  → ctx.secrets
 *
 * The caller key marks our traffic as a "verified caller" to the
 * backend's rate limiter (60 req/min vs 10 req/min anonymous). It
 * authenticates to the MOCK BACKEND only — unrelated to the Glubean
 * Cloud upload token (GLUBEAN_TOKEN), which is a different request path.
 */

export interface MockBackendResponse<T = unknown> {
  status: number;
  ok: boolean;
  body: T;
}

function baseUrl(ctx: TestContext): string {
  return (
    ctx.vars.get("MOCK_BACKEND_URL") ?? "https://demo-backend.example.com"
  ).replace(/\/$/, "");
}

/**
 * GET a path on the mock backend. `path` is relative to the backend
 * root (e.g. "/api/stable/users"). Returns parsed JSON + status.
 * Never throws on non-2xx — callers assert on `.status` / `.ok` so a
 * 503 from a flaky endpoint is observed, not swallowed as an error.
 */
export async function mockGet<T = unknown>(
  ctx: TestContext,
  path: string,
): Promise<MockBackendResponse<T>> {
  const headers: Record<string, string> = { accept: "application/json" };
  const callerKey = ctx.secrets.get("DEMO_BACKEND_CALLER_KEY");
  if (callerKey) headers["x-demo-caller-key"] = callerKey;

  const res = await fetch(`${baseUrl(ctx)}${path}`, { headers });
  let body: T;
  try {
    body = (await res.json()) as T;
  } catch {
    body = undefined as unknown as T;
  }
  return { status: res.status, ok: res.ok, body };
}
