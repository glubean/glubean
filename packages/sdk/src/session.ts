import type { SessionDefinition } from "./types.js";

/**
 * Define a session setup/teardown lifecycle for cross-file state sharing.
 *
 * Place in `session.ts` at your test root. The runner auto-discovers it.
 *
 * @example
 * ```ts
 * import { defineSession } from "@glubean/sdk";
 *
 * export default defineSession({
 *   async setup(ctx) {
 *     const { access_token } = await ctx.http
 *       .post("/auth/login", {
 *         json: { user: ctx.vars.require("USER"), pass: ctx.secrets.require("PASS") },
 *       })
 *       .json();
 *     ctx.session.set("token", access_token);
 *   },
 *   async teardown(ctx) {
 *     await ctx.http.post("/auth/logout", {
 *       headers: { Authorization: `Bearer ${ctx.session.get("token")}` },
 *     });
 *   },
 * });
 * ```
 */
export function defineSession(def: SessionDefinition): SessionDefinition {
  return def;
}

// =============================================================================
// Global session accessor — read-only, lazy, for use outside test functions
// =============================================================================

function getRuntimeSession(): Record<string, unknown> {
  const runtime = (globalThis as any).__glubeanRuntime;
  if (!runtime) {
    throw new Error(
      "session can only be accessed during test execution. " +
        "Did you try to read a session value at module load time? " +
        "Move the access inside a test function or a ky beforeRequest hook.",
    );
  }
  return runtime.session ?? {};
}

/**
 * Global read-only accessor for session values.
 *
 * Use this when you need session data **outside** of a test function body —
 * for example, in a `configure()` ky `beforeRequest` hook that dynamically
 * switches auth headers based on session state.
 *
 * For reading/writing session inside test functions, use `ctx.session` instead.
 *
 * @example Dynamic token in beforeRequest hook
 * ```ts
 * import { configure, session } from "@glubean/sdk";
 *
 * export const { http: api } = configure({
 *   http: {
 *     prefixUrl: "{{BASE_URL}}",
 *     hooks: {
 *       beforeRequest: [(req) => {
 *         const token = session.get("AUTH_TOKEN") as string;
 *         if (token) req.headers.set("Authorization", `Bearer ${token}`);
 *       }],
 *     },
 *   },
 * });
 * ```
 */
export const session = {
  /** Returns the value if present, otherwise undefined. */
  get<T = unknown>(key: string): T | undefined {
    return getRuntimeSession()[key] as T | undefined;
  },

  /** Returns the value or throws if missing. */
  require<T = unknown>(key: string): T {
    const data = getRuntimeSession();
    const value = data[key];
    if (value === undefined) {
      throw new Error(
        `Missing required session key: "${key}". ` +
          "Ensure it was set in session.ts setup() or via ctx.session.set().",
      );
    }
    return value as T;
  },

  /**
   * Set a session value. Visible immediately within the current subprocess.
   *
   * Note: this does NOT emit a `session:set` event, so the value does not
   * propagate to subsequent test subprocesses. For cross-test propagation,
   * use `ctx.session.set()` inside a test function instead.
   */
  set(key: string, value: unknown): void {
    getRuntimeSession()[key] = value;
  },

  /** Check whether a key exists. */
  has(key: string): boolean {
    return key in getRuntimeSession();
  },

  /** Returns a snapshot of all session key-value pairs. */
  entries(): Record<string, unknown> {
    return { ...getRuntimeSession() };
  },
} as const;
