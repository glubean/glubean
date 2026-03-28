import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { generateCodeVerifier, generateCodeChallenge, oauthCode } from "./index.js";
import { createServer, type Server } from "node:http";
import { readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";

// ── PKCE ─────────────────────────────────────────────────────────────────────

describe("PKCE", () => {
  it("generates a base64url code verifier", () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(v.length).toBeGreaterThanOrEqual(43);
  });

  it("generates a valid S256 code challenge", () => {
    const v = generateCodeVerifier();
    const c = generateCodeChallenge(v);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(c.length).toBe(43);
  });

  it("produces different challenges for different verifiers", () => {
    const c1 = generateCodeChallenge(generateCodeVerifier());
    const c2 = generateCodeChallenge(generateCodeVerifier());
    expect(c1).not.toBe(c2);
  });
});

// ── oauthCode() return shape ─────────────────────────────────────────────────

describe("oauthCode()", () => {
  it("returns ConfigureHttpOptions with correct prefixUrl", () => {
    const result = oauthCode({
      prefixUrl: "https://api.example.com",
      authorizeUrl: "https://example.com/oauth/authorize",
      tokenUrl: "https://example.com/oauth/token",
      clientId: "my-client",
    });
    expect(result.prefixUrl).toBe("https://api.example.com");
  });

  it("sets marker headers for template resolution", () => {
    const result = oauthCode({
      prefixUrl: "https://api.example.com",
      authorizeUrl: "https://example.com/oauth/authorize",
      tokenUrl: "https://example.com/oauth/token",
      clientId: "{{CLIENT_ID}}",
      clientSecret: "{{CLIENT_SECRET}}",
    });
    expect(result.headers).toMatchObject({
      "X-Glubean-OAuthCode-AuthUrl": "https://example.com/oauth/authorize",
      "X-Glubean-OAuthCode-TokenUrl": "https://example.com/oauth/token",
      "X-Glubean-OAuthCode-ClientId": "{{CLIENT_ID}}",
      "X-Glubean-OAuthCode-ClientSecret": "{{CLIENT_SECRET}}",
    });
  });

  it("omits client secret marker when not provided", () => {
    const result = oauthCode({
      prefixUrl: "https://api.example.com",
      authorizeUrl: "https://example.com/oauth/authorize",
      tokenUrl: "https://example.com/oauth/token",
      clientId: "my-client",
    });
    expect(result.headers?.["X-Glubean-OAuthCode-ClientSecret"]).toBeUndefined();
  });

  it("includes beforeRequest and afterResponse hooks", () => {
    const result = oauthCode({
      prefixUrl: "https://api.example.com",
      authorizeUrl: "https://example.com/oauth/authorize",
      tokenUrl: "https://example.com/oauth/token",
      clientId: "my-client",
    });
    expect(result.hooks?.beforeRequest).toHaveLength(1);
    expect(result.hooks?.afterResponse).toHaveLength(1);
  });
});

// ── Hook-level integration tests ─────────────────────────────────────────────

describe("beforeRequest hook", () => {
  let tokenServer: Server;
  let tokenPort: number;
  let cacheDir: string;
  let receivedParams: URLSearchParams;

  beforeEach(async () => {
    receivedParams = new URLSearchParams();
    tokenServer = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        receivedParams = new URLSearchParams(body);
        const grantType = receivedParams.get("grant_type");

        if (grantType === "authorization_code" && receivedParams.get("code")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            access_token: "test-access-token",
            refresh_token: "test-refresh-token",
            expires_in: 3600,
          }));
        } else if (grantType === "refresh_token" && receivedParams.get("refresh_token")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            access_token: "refreshed-access-token",
            expires_in: 3600,
          }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
        }
      });
    });

    await new Promise<void>((resolve) => {
      tokenServer.listen(0, "127.0.0.1", () => {
        tokenPort = (tokenServer.address() as { port: number }).port;
        resolve();
      });
    });

    cacheDir = `/tmp/glubean-oauth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(async () => {
    tokenServer?.close();
    await rm(cacheDir, { recursive: true, force: true });
  });

  /** Track openBrowser calls and capture the authorize URL for simulating callback. */
  function createBrowserStub() {
    const calls: string[] = [];
    return {
      open: (url: string) => { calls.push(url); },
      calls,
    };
  }

  /**
   * Simulate the browser callback by extracting redirect_uri and state from
   * the captured authorize URL, then making a GET to the local callback server.
   */
  async function simulateCallback(authorizeUrlStr: string, code = "auth-code-123") {
    const authorizeUrl = new URL(authorizeUrlStr);
    const redirectUri = authorizeUrl.searchParams.get("redirect_uri")!;
    const state = authorizeUrl.searchParams.get("state")!;
    await fetch(`${redirectUri}?code=${code}&state=${state}`);
  }

  function makeRequest(tokenPortOverride?: number) {
    return new Request("https://api.example.com/test", {
      headers: {
        "X-Glubean-OAuthCode-AuthUrl": "https://example.com/oauth/authorize",
        "X-Glubean-OAuthCode-TokenUrl": `http://127.0.0.1:${tokenPortOverride ?? tokenPort}/token`,
        "X-Glubean-OAuthCode-ClientId": "test-client",
      },
    });
  }

  function createPlugin(extra?: Record<string, unknown>) {
    const stub = createBrowserStub();
    const opts = oauthCode({
      prefixUrl: "https://api.example.com",
      authorizeUrl: "https://example.com/oauth/authorize",
      tokenUrl: `http://127.0.0.1:${tokenPort}/token`,
      clientId: "test-client",
      cacheDir,
      openBrowser: stub.open,
      ...extra,
    });
    const hook = opts.hooks!.beforeRequest![0] as (req: Request) => Promise<Request>;
    return { opts, hook, stub };
  }

  it("acquires token via browser flow and sets Authorization header", async () => {
    const { hook, stub } = createPlugin();

    // Start hook — it will open browser and wait for callback
    const hookPromise = hook(makeRequest());
    await new Promise((r) => setTimeout(r, 50));

    expect(stub.calls).toHaveLength(1);
    await simulateCallback(stub.calls[0]);

    const result = await hookPromise;
    expect(result.headers.get("Authorization")).toBe("Bearer test-access-token");
    // Marker headers should be stripped
    expect(result.headers.get("X-Glubean-OAuthCode-ClientId")).toBeNull();
  });

  it("caches token to disk after browser flow", async () => {
    const { hook, stub } = createPlugin();

    const hookPromise = hook(makeRequest());
    await new Promise((r) => setTimeout(r, 50));
    await simulateCallback(stub.calls[0]);
    await hookPromise;

    const files = await readdir(cacheDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.json$/);

    const content = JSON.parse(await readFile(join(cacheDir, files[0]), "utf-8"));
    expect(content.accessToken).toBe("test-access-token");
    expect(content.refreshToken).toBe("test-refresh-token");
    expect(content.expiresAt).toBeGreaterThan(Date.now());
  });

  it("reuses memory-cached token on second request without browser", async () => {
    const { hook, stub } = createPlugin();

    // First: browser flow
    const p1 = hook(makeRequest());
    await new Promise((r) => setTimeout(r, 50));
    await simulateCallback(stub.calls[0]);
    await p1;

    // Second: should use cache, no browser
    const result = await hook(makeRequest());
    expect(result.headers.get("Authorization")).toBe("Bearer test-access-token");
    expect(stub.calls).toHaveLength(1); // still only 1 browser open
  });

  it("sends code_verifier when PKCE is enabled", async () => {
    const { hook, stub } = createPlugin({ pkce: true });

    const hookPromise = hook(makeRequest());
    await new Promise((r) => setTimeout(r, 50));

    // Verify authorize URL has code_challenge
    const authUrl = new URL(stub.calls[0]);
    expect(authUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");

    await simulateCallback(stub.calls[0]);
    await hookPromise;

    // Token exchange should have included code_verifier
    expect(receivedParams.get("code_verifier")).toBeTruthy();
    expect(receivedParams.get("code_verifier")!.length).toBeGreaterThanOrEqual(43);
  });

  it("serializes concurrent requests — only one browser flow", async () => {
    const { hook, stub } = createPlugin();

    // Fire 3 concurrent requests
    const p1 = hook(makeRequest());
    const p2 = hook(makeRequest());
    const p3 = hook(makeRequest());

    await new Promise((r) => setTimeout(r, 50));

    // Only one browser open
    expect(stub.calls).toHaveLength(1);

    await simulateCallback(stub.calls[0]);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    // All three get the same token
    expect(r1.headers.get("Authorization")).toBe("Bearer test-access-token");
    expect(r2.headers.get("Authorization")).toBe("Bearer test-access-token");
    expect(r3.headers.get("Authorization")).toBe("Bearer test-access-token");
  });
});

// ── Cache key scope sensitivity ──────────────────────────────────────────────

describe("cache key includes scopes", () => {
  it("different scopes produce different cache keys", async () => {
    const { createHash } = await import("node:crypto");
    const key = (scopes: string) =>
      createHash("sha256").update(`client:https://auth.example.com:${scopes}`).digest("hex").slice(0, 12);

    const k1 = key("read");
    const k2 = key("read write");
    const k3 = key("");

    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k2).not.toBe(k3);
  });
});
