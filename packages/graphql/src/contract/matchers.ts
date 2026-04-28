/**
 * GraphQL custom matchers for `ctx.expect()`.
 *
 * Installed on `Expectation.prototype` when `installPlugin(graphqlPlugin)`
 * runs (typically via `glubean.setup.ts` → `bootstrap()`). The
 * `declare module "@glubean/sdk/expect"` block below publishes ambient
 * types so `ctx.expect(res).toHaveGraphqlData(...)` is fully typed wherever
 * `@glubean/graphql` is referenced, even if the actual runtime install
 * happens elsewhere in the project.
 *
 * Matchers work on any object that carries GraphQL response shape, including:
 *   - `GraphQLResult<T>` from `@glubean/graphql` transport
 *     (`gql.query(...)` / `gql.mutate(...)`)
 *   - `GraphqlCaseResult<T>` from the contract adapter
 *     (verify callback / flow `out` lens input)
 *
 * Both expose:
 *   {
 *     data: T | null,
 *     errors?: GraphQLError[],
 *     extensions?: Record<string, unknown>,
 *     httpStatus: number,
 *     headers: Record<string, string | string[]>,
 *     rawBody: string | null,
 *     ...
 *   }
 *
 * The HTTP `toHaveStatus` built-in matcher reads `actual.status`, which the
 * GraphQL envelope does NOT expose (it's `httpStatus` — a deliberate rename
 * in CG-10 to avoid shadowing the native `Response.status` semantics). The
 * `toHaveHttpStatus` matcher added here reads the envelope's `httpStatus`
 * field so GraphQL users have a symmetric transport-level assertion.
 */

import { Expectation, inspect, type MatcherResult } from "@glubean/sdk/expect";
import type { GraphQLError } from "../index.js";

// =============================================================================
// Type augmentation (ambient, no user-side `declare module` required)
// =============================================================================

declare module "@glubean/sdk/expect" {
  interface CustomMatchers<T> {
    /**
     * Assert the transport-level HTTP status on a `GraphQLResult` /
     * `GraphqlCaseResult`. Reads `actual.httpStatus`.
     *
     * Use this (not `toHaveStatus`) for GraphQL responses — the envelope
     * field is `httpStatus`, not `status`.
     *
     * @example ctx.expect(res).toHaveHttpStatus(200);
     * @example ctx.expect(res).toHaveHttpStatus(401, "missing token");
     */
    toHaveHttpStatus(code: number, message?: string): Expectation<T>;

    /**
     * Partial-match the GraphQL `data` field (like `toMatchObject`).
     *
     * Fails if `data` is null or the subset is not contained in `data`.
     *
     * @example ctx.expect(res).toHaveGraphqlData({ user: { name: "Alice" } });
     */
    toHaveGraphqlData(
      subset: Record<string, unknown>,
      message?: string,
    ): Expectation<T>;

    /**
     * Assert the `errors` array is absent or empty (strict success).
     *
     * @example ctx.expect(res).toHaveGraphqlNoErrors();
     */
    toHaveGraphqlNoErrors(message?: string): Expectation<T>;

    /**
     * Assert at least one entry in `errors` has matching
     * `extensions.code` (case-insensitive).
     *
     * @example ctx.expect(res).toHaveGraphqlErrorCode("UNAUTHENTICATED");
     */
    toHaveGraphqlErrorCode(code: string, message?: string): Expectation<T>;

    /**
     * Assert a key exists in `extensions` (server-side tracing / cost),
     * optionally matching an exact value.
     *
     * @example ctx.expect(res).toHaveGraphqlExtension("tracing");
     * @example ctx.expect(res).toHaveGraphqlExtension("version", "v2");
     */
    toHaveGraphqlExtension(
      key: string,
      value?: unknown,
      message?: string,
    ): Expectation<T>;
  }
}

// =============================================================================
// Helpers
// =============================================================================

interface HttpStatusShape {
  httpStatus?: number;
}

interface GraphqlEnvelopeShape {
  data?: unknown;
  errors?: GraphQLError[];
  extensions?: Record<string, unknown>;
}

function readHttpStatus(actual: unknown): number | undefined {
  const s = (actual as HttpStatusShape | null | undefined)?.httpStatus;
  return typeof s === "number" ? s : undefined;
}

function readEnvelope(actual: unknown): GraphqlEnvelopeShape | undefined {
  if (!actual || typeof actual !== "object") return undefined;
  return actual as GraphqlEnvelopeShape;
}

/** Minimal partial-match helper — checks that every key/value in subset
 *  is deep-equal to the corresponding path in target. Keeps this file
 *  dependency-free from the sdk internal `matchesObject`. */
function matchesSubset(
  target: Record<string, unknown>,
  subset: Record<string, unknown>,
): boolean {
  for (const [k, expected] of Object.entries(subset)) {
    const actual = target[k];
    if (
      expected !== null &&
      typeof expected === "object" &&
      !Array.isArray(expected)
    ) {
      if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
        return false;
      }
      if (
        !matchesSubset(
          actual as Record<string, unknown>,
          expected as Record<string, unknown>,
        )
      ) {
        return false;
      }
    } else if (Array.isArray(expected)) {
      if (!Array.isArray(actual) || actual.length !== expected.length) {
        return false;
      }
      for (let i = 0; i < expected.length; i++) {
        if (JSON.stringify(actual[i]) !== JSON.stringify(expected[i])) {
          return false;
        }
      }
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

// =============================================================================
// Matcher implementations
// =============================================================================

const toHaveHttpStatus = (
  actual: unknown,
  ...args: unknown[]
): MatcherResult => {
  const code = args[0] as number;
  const actualCode = readHttpStatus(actual);

  if (actualCode === undefined) {
    return {
      passed: false,
      message:
        `to have HTTP status ${code} — actual has no \`.httpStatus\` (got ${inspect(actual)})`,
      actual,
      expected: code,
    };
  }

  return {
    passed: actualCode === code,
    message: `to have HTTP status ${code}`,
    actual: actualCode,
    expected: code,
  };
};

const toHaveGraphqlData = (
  actual: unknown,
  ...args: unknown[]
): MatcherResult => {
  const subset = args[0] as Record<string, unknown>;
  const env = readEnvelope(actual);

  if (!env) {
    return {
      passed: false,
      message: `to have GraphQL data matching ${inspect(subset)} — actual is not an envelope`,
      actual,
      expected: subset,
    };
  }

  const data = env.data;
  if (data == null) {
    return {
      passed: false,
      message: `to have GraphQL data matching ${inspect(subset)} — \`.data\` is null`,
      actual: data,
      expected: subset,
    };
  }

  if (typeof data !== "object" || Array.isArray(data)) {
    return {
      passed: false,
      message: `to have GraphQL data matching ${inspect(subset)} — \`.data\` is not an object`,
      actual: data,
      expected: subset,
    };
  }

  const passed = matchesSubset(data as Record<string, unknown>, subset);
  return {
    passed,
    message: `to have GraphQL data matching ${inspect(subset)}`,
    actual: data,
    expected: subset,
  };
};

const toHaveGraphqlNoErrors = (actual: unknown): MatcherResult => {
  const env = readEnvelope(actual);
  const errs = env?.errors;
  const count = Array.isArray(errs) ? errs.length : 0;
  const summary =
    count > 0
      ? errs!.map((e) => e.message).slice(0, 3).join("; ") +
        (count > 3 ? ` (+${count - 3} more)` : "")
      : "";

  return {
    passed: count === 0,
    message:
      count > 0
        ? `to have no GraphQL errors (got ${count}: ${summary})`
        : `to have no GraphQL errors`,
    actual: errs ?? [],
    expected: [],
  };
};

const toHaveGraphqlErrorCode = (
  actual: unknown,
  ...args: unknown[]
): MatcherResult => {
  const code = args[0] as string;
  const env = readEnvelope(actual);
  const errs = env?.errors;

  if (!Array.isArray(errs) || errs.length === 0) {
    return {
      passed: false,
      message: `to have GraphQL error code ${inspect(code)} — no errors on envelope`,
      actual: errs ?? [],
      expected: { "extensions.code": code },
    };
  }

  const lower = code.toUpperCase();
  const match = errs.find((e) => {
    const c = e.extensions?.code;
    return typeof c === "string" && c.toUpperCase() === lower;
  });

  return {
    passed: !!match,
    message: `to have GraphQL error code ${inspect(code)}`,
    actual: errs.map((e) => e.extensions?.code ?? null),
    expected: code,
  };
};

const toHaveGraphqlExtension = (
  actual: unknown,
  ...args: unknown[]
): MatcherResult => {
  const key = args[0] as string;
  const expectedValue = args[1] as unknown;
  const env = readEnvelope(actual);
  const ext = env?.extensions;

  if (!ext || typeof ext !== "object") {
    return {
      passed: false,
      message: `to have GraphQL extension \`${key}\` — actual has no \`.extensions\``,
      actual: ext,
      expected: expectedValue !== undefined ? { [key]: expectedValue } : key,
    };
  }

  if (!(key in ext)) {
    return {
      passed: false,
      message: `to have GraphQL extension \`${key}\``,
      actual: Object.keys(ext),
      expected: expectedValue !== undefined ? { [key]: expectedValue } : key,
    };
  }

  if (expectedValue === undefined) {
    return {
      passed: true,
      message: `to have GraphQL extension \`${key}\``,
      actual: ext[key],
      expected: key,
    };
  }

  return {
    passed: JSON.stringify(ext[key]) === JSON.stringify(expectedValue),
    message: `to have GraphQL extension \`${key}\` = ${inspect(expectedValue)}`,
    actual: ext[key],
    expected: expectedValue,
  };
};

// =============================================================================
// Registration — called from plugin manifest, not a bare import side effect
// =============================================================================

/**
 * Register GraphQL matchers onto the shared `Expectation` prototype. Called
 * from `./index.ts` when the plugin manifest is installed via
 * `installPlugin(graphqlManifest)` in `glubean.setup.ts`; a bare
 * `import "@glubean/graphql"` does not register matchers or the adapter.
 *
 * Idempotent: swallows the "matcher already exists" error thrown by
 * `Expectation.extend` on re-evaluation (duplicate imports, Vitest
 * isolation boundaries, etc.).
 *
 * Note: `toHaveHttpStatus` is registered here even though it's
 * conceptually transport-level (not GraphQL-specific) — users of
 * `@glubean/graphql` are the ones who need it because the GraphQL
 * envelope uses `httpStatus` instead of `status`. If a future package
 * also exposes an `httpStatus` field, registration idempotency will
 * catch the conflict at boot.
 */
/**
 * Collection of GraphQL custom matchers, keyed by matcher name.
 *
 * Consumed by the plugin manifest in `graphql/src/index.ts` as
 * `manifest.matchers`. `installPlugin` drives the actual `Expectation.extend`
 * call — plugin authors never need to touch it directly.
 */
export const graphqlMatchers = {
  toHaveHttpStatus,
  toHaveGraphqlData,
  toHaveGraphqlNoErrors,
  toHaveGraphqlErrorCode,
  toHaveGraphqlExtension,
} as const;
