/**
 * @module configure
 *
 * File-level configuration for Glubean tests.
 *
 * `configure()` lets you declare shared dependencies (vars, secrets, HTTP config)
 * once at the top of a test file (or in a shared `configure.ts`), eliminating
 * repetitive `ctx.vars.require()` / `ctx.secrets.require()` calls in every test.
 *
 * All returned values are **lazy** — they are not resolved until a test function
 * actually accesses them at runtime. This means:
 * - Safe to call at module top-level (scanner won't trigger resolution)
 * - Safe to share across files via re-exports
 * - Each test execution gets the correct runtime values
 *
 * @example Single file usage
 * ```ts
 * import { test, configure } from "@glubean/sdk";
 *
 * const { vars, secrets, http } = configure({
 *   vars: { baseUrl: "{{BASE_URL}}" },
 *   secrets: { apiKey: "{{API_KEY}}" },
 *   http: {
 *     prefixUrl: "{{BASE_URL}}",
 *     headers: { Authorization: "Bearer {{API_KEY}}" },
 *   },
 * });
 *
 * export const listUsers = test("list-users", async (ctx) => {
 *   const res = await http.get("users").json();
 *   ctx.assert(res.length > 0, "has users");
 * });
 * ```
 *
 * @example Shared across files (tests/configure.ts)
 * ```ts
 * // tests/configure.ts
 * export const { vars, http } = configure({
 *   vars: { baseUrl: "{{BASE_URL}}" },
 *   http: { prefixUrl: "{{BASE_URL}}" },
 * });
 *
 * // tests/users.test.ts
 * import { http } from "./configure.js";
 * export const listUsers = test("list-users", async (ctx) => {
 *   const res = await http.get("users").json();
 * });
 * ```
 */

import type {
  ConfigureOptions,
  ConfigureResult,
  PluginFactory,
  ReservedConfigureKeys,
  ResolvePlugins,
} from "../types.js";
import { buildLazyVars, buildLazySecrets } from "./vars.js";
import { buildLazyHttp, buildPassthroughHttp } from "./http.js";
import { buildLazyPlugins } from "./plugin.js";

export type { InternalRuntime } from "./runtime.js";
export { resolveTemplate } from "./template.js";

/**
 * Declare file-level dependencies on vars, secrets, and HTTP configuration.
 *
 * Returns lazy accessors that resolve at test runtime, not at import time.
 * All declared vars and secrets are **required** — missing values cause the test
 * to fail immediately with a clear error message.
 *
 * @param options Configuration declaring vars, secrets, and HTTP defaults
 * @returns Lazy accessors for vars, secrets, and a pre-configured HTTP client
 */
export function configure<
  V extends Record<string, string> = Record<string, string>,
  S extends Record<string, string> = Record<string, string>,
  P extends Record<string, PluginFactory<any>> = Record<string, never>,
>(
  options: ConfigureOptions & {
    vars?: { [K in keyof V]: string };
    secrets?: { [K in keyof S]: string };
    plugins?: P & { [K in ReservedConfigureKeys]?: never };
  },
):
  & ConfigureResult<{ [K in keyof V]: string }, { [K in keyof S]: string }>
  & ResolvePlugins<P> {
  const vars = options.vars
    ? buildLazyVars<{ [K in keyof V]: string }>(options.vars)
    : ({} as Readonly<{ [K in keyof V]: string }>);

  const secrets = options.secrets
    ? buildLazySecrets<{ [K in keyof S]: string }>(options.secrets)
    : ({} as Readonly<{ [K in keyof S]: string }>);

  const http = options.http ? buildLazyHttp(options.http) : buildPassthroughHttp();

  const base = { vars, secrets, http };

  if (options.plugins) {
    Object.assign(base, buildLazyPlugins(options.plugins));
  }

  return base as
    & ConfigureResult<{ [K in keyof V]: string }, { [K in keyof S]: string }>
    & ResolvePlugins<P>;
}
