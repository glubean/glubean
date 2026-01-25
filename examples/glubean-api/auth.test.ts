/**
 * Glubean API Authentication Tests
 *
 * Tests the authentication endpoints of the Glubean server.
 *
 * Prerequisites:
 * - Glubean server running at BASE_URL (default: http://localhost:3002)
 * - API_KEY set in .env.secrets (see .env.example for instructions)
 *
 * Run with:
 *   cd examples/glubean-api && deno task test:auth
 */

import ky, { type KyInstance, HTTPError } from "npm:ky";
import { test } from "@glubean/sdk";

/**
 * Create a ky client for API requests
 */
function createClient(
  ctx: { vars: { get(key: string): string | undefined }; secrets: { get(key: string): string | undefined } }
): KyInstance {
  const baseUrl = ctx.vars.get("BASE_URL") || "http://localhost:3002";
  const apiKey = ctx.secrets.get("API_KEY");

  return ky.create({
    prefixUrl: baseUrl,
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    // Don't throw on non-2xx responses - we want to check status codes
    throwHttpErrors: false,
  });
}

/**
 * Test: Check auth status without credentials
 * Expected: Should return { authenticated: false }
 */
export const authStatusUnauthenticated = test(
  {
    id: "auth-status-unauthenticated",
    name: "Auth status without credentials",
    tags: ["auth", "smoke"],
  },
  async (ctx) => {
    const baseUrl = ctx.vars.get("BASE_URL") || "http://localhost:3002";
    ctx.log(`Testing auth status at: ${baseUrl}/auth/status`);

    // Create client without auth
    const client = ky.create({
      prefixUrl: baseUrl,
      throwHttpErrors: false,
    });

    const startTime = Date.now();
    const res = await client.get("auth/status");
    const duration = Date.now() - startTime;
    const data = await res.json();

    ctx.trace({
      method: "GET",
      url: `${baseUrl}/auth/status`,
      status: res.status,
      duration,
      responseBody: data,
    });

    // Without credentials, should return unauthenticated
    ctx.assert(res.status === 200, "Status endpoint should return 200", {
      actual: res.status,
      expected: 200,
    });

    ctx.assert(
      (data as any).authenticated === false,
      "Should report unauthenticated without credentials",
      { actual: (data as any).authenticated, expected: false }
    );
  }
);

/**
 * Test: Check auth status with API key
 * Expected: Should return { authenticated: true, user: {...} }
 */
export const authStatusAuthenticated = test(
  {
    id: "auth-status-authenticated",
    name: "Auth status with API key",
    tags: ["auth", "api-key"],
  },
  async (ctx) => {
    const apiKey = ctx.secrets.get("API_KEY");

    if (!apiKey) {
      ctx.log("⚠️ Skipping: API_KEY not set in .env.secrets");
      ctx.assert(true, "Test skipped - no API key");
      return;
    }

    const baseUrl = ctx.vars.get("BASE_URL") || "http://localhost:3002";
    ctx.log(`Testing authenticated status at: ${baseUrl}/auth/status`);

    const client = createClient(ctx);

    const startTime = Date.now();
    const res = await client.get("auth/status");
    const duration = Date.now() - startTime;
    const data = await res.json();

    ctx.trace({
      method: "GET",
      url: `${baseUrl}/auth/status`,
      status: res.status,
      duration,
      responseBody: data,
    });

    ctx.assert(res.status === 200, "Status endpoint should return 200", {
      actual: res.status,
      expected: 200,
    });

    ctx.assert(
      (data as any).authenticated === true,
      "Should report authenticated with valid API key",
      { actual: (data as any).authenticated, expected: true }
    );

    ctx.assert(!!(data as any).user, "Should return user object");

    if ((data as any).user) {
      ctx.log("Authenticated as:", { email: (data as any).user.email, id: (data as any).user.id });
    }
  }
);

/**
 * Test: Get user profile with API key
 * Expected: Should return user profile data
 */
export const getProfile = test(
  {
    id: "auth-profile",
    name: "Get user profile",
    tags: ["auth", "api-key"],
  },
  async (ctx) => {
    const apiKey = ctx.secrets.get("API_KEY");

    if (!apiKey) {
      ctx.log("⚠️ Skipping: API_KEY not set in .env.secrets");
      ctx.assert(true, "Test skipped - no API key");
      return;
    }

    const baseUrl = ctx.vars.get("BASE_URL") || "http://localhost:3002";
    ctx.log(`Getting profile at: ${baseUrl}/auth/profile`);

    const client = createClient(ctx);

    const startTime = Date.now();
    const res = await client.get("auth/profile");
    const duration = Date.now() - startTime;
    const data = await res.json();

    ctx.trace({
      method: "GET",
      url: `${baseUrl}/auth/profile`,
      status: res.status,
      duration,
    });

    ctx.assert(res.status === 200, "Profile endpoint should return 200", {
      actual: res.status,
      expected: 200,
    });

    ctx.log("Profile data:", data);

    ctx.assert(!!(data as any).email, "Profile should have email");
    ctx.assert(!!(data as any).id, "Profile should have id");
  }
);

/**
 * Test: Access protected endpoint without auth
 * Expected: Should return 401
 */
export const protectedEndpointNoAuth = test(
  {
    id: "protected-no-auth",
    name: "Protected endpoint without auth returns 401",
    tags: ["auth", "security"],
  },
  async (ctx) => {
    const baseUrl = ctx.vars.get("BASE_URL") || "http://localhost:3002";
    ctx.log(`Testing protected endpoint without auth: ${baseUrl}/auth/profile`);

    // Create client without auth
    const client = ky.create({
      prefixUrl: baseUrl,
      throwHttpErrors: false,
    });

    const startTime = Date.now();
    const res = await client.get("auth/profile");
    const duration = Date.now() - startTime;

    ctx.trace({
      method: "GET",
      url: `${baseUrl}/auth/profile`,
      status: res.status,
      duration,
    });

    ctx.assert(
      res.status === 401,
      "Protected endpoint should return 401 without auth",
      { actual: res.status, expected: 401 }
    );
  }
);
