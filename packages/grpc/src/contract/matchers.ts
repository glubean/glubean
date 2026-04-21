/**
 * gRPC custom matchers for `ctx.expect()`.
 *
 * Registered as a side effect of `import "@glubean/grpc"` (see `./index.ts`).
 * No extra import or configure step required — the matchers become available
 * on every `ctx.expect(res)` call and are fully typed via the
 * `CustomMatchers<T>` declaration merging block below.
 *
 * Matchers work on any object that carries gRPC response shape, including:
 *   - `GrpcCallResult` from `@glubean/grpc` transport (direct client.call)
 *   - `GrpcCaseResult` from the contract adapter (verify callback / flow
 *     `out` lens input)
 *
 * The canonical shape both produce:
 *   {
 *     message: T,
 *     status: { code: number, details: string },
 *     responseMetadata: Record<string, string>,
 *     duration: number,
 *   }
 *
 * See `packages/sdk/src/expect.ts` for the underlying `MatcherResult` /
 * `Expectation.extend` / `CustomMatchers<T>` contracts.
 */

import { Expectation, inspect, type MatcherResult } from "@glubean/sdk/expect";

// =============================================================================
// Type augmentation (ambient, no user-side `declare module` required)
// =============================================================================

declare module "@glubean/sdk/expect" {
  interface CustomMatchers<T> {
    /**
     * Assert the gRPC status code on a `GrpcCallResult` / `GrpcCaseResult`.
     *
     * @param code Expected gRPC status code (`0` = OK, `5` = NOT_FOUND, etc.)
     * @param message Optional context prepended to the assertion message
     *
     * @example ctx.expect(res).toHaveGrpcStatus(0);
     * @example ctx.expect(res).toHaveGrpcStatus(5, "user lookup");
     */
    toHaveGrpcStatus(code: number, message?: string): Expectation<T>;

    /**
     * Convenience: assert status code is `0` (OK).
     * Equivalent to `toHaveGrpcStatus(0)` but reads better in test bodies.
     *
     * @example ctx.expect(res).toHaveGrpcOk();
     */
    toHaveGrpcOk(message?: string): Expectation<T>;

    /**
     * Assert presence (and optionally value) of a key in response metadata.
     *
     * @param key Metadata key (case-insensitive per gRPC spec; compared as lowercased)
     * @param value Optional exact expected value; when omitted, only presence is checked
     * @param message Optional context prepended to the assertion message
     *
     * @example ctx.expect(res).toHaveGrpcMetadata("x-request-id");
     * @example ctx.expect(res).toHaveGrpcMetadata("x-tenant", "acme");
     */
    toHaveGrpcMetadata(
      key: string,
      value?: string,
      message?: string,
    ): Expectation<T>;
  }
}

// =============================================================================
// Helpers
// =============================================================================

interface GrpcStatusShape {
  status?: { code?: number; details?: string };
}

interface GrpcMetadataShape {
  responseMetadata?: Record<string, string>;
}

function readStatusCode(actual: unknown): number | undefined {
  const s = (actual as GrpcStatusShape | null | undefined)?.status;
  return typeof s?.code === "number" ? s.code : undefined;
}

function readStatusDetails(actual: unknown): string | undefined {
  const s = (actual as GrpcStatusShape | null | undefined)?.status;
  return typeof s?.details === "string" ? s.details : undefined;
}

function readMetadata(actual: unknown): Record<string, string> | undefined {
  const md = (actual as GrpcMetadataShape | null | undefined)?.responseMetadata;
  return md && typeof md === "object" ? md : undefined;
}

function findMetadataEntry(
  md: Record<string, string>,
  key: string,
): [string, string] | undefined {
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(md)) {
    if (k.toLowerCase() === lower) return [k, v];
  }
  return undefined;
}

// =============================================================================
// Matcher implementations
// =============================================================================

const toHaveGrpcStatus = (
  actual: unknown,
  ...args: unknown[]
): MatcherResult => {
  const code = args[0] as number;
  const actualCode = readStatusCode(actual);
  const details = readStatusDetails(actual);

  if (actualCode === undefined) {
    return {
      passed: false,
      message:
        `to have gRPC status ${code} — actual has no \`.status.code\` (got ${inspect(actual)})`,
      actual,
      expected: code,
    };
  }

  return {
    passed: actualCode === code,
    message: details
      ? `to have gRPC status ${code} (got ${actualCode}: ${details})`
      : `to have gRPC status ${code}`,
    actual: actualCode,
    expected: code,
  };
};

const toHaveGrpcOk = (actual: unknown): MatcherResult => {
  const actualCode = readStatusCode(actual);
  const details = readStatusDetails(actual);

  if (actualCode === undefined) {
    return {
      passed: false,
      message: `to have gRPC status OK (0) — actual has no \`.status.code\``,
      actual,
      expected: 0,
    };
  }

  return {
    passed: actualCode === 0,
    message: details
      ? `to have gRPC status OK (0) (got ${actualCode}: ${details})`
      : `to have gRPC status OK (0)`,
    actual: actualCode,
    expected: 0,
  };
};

const toHaveGrpcMetadata = (
  actual: unknown,
  ...args: unknown[]
): MatcherResult => {
  const key = args[0] as string;
  const expectedValue = args[1] as string | undefined;
  const md = readMetadata(actual);

  if (!md) {
    return {
      passed: false,
      message: `to have gRPC metadata \`${key}\` — actual has no \`.responseMetadata\``,
      actual,
      expected: expectedValue !== undefined ? { [key]: expectedValue } : key,
    };
  }

  const entry = findMetadataEntry(md, key);

  if (!entry) {
    return {
      passed: false,
      message: `to have gRPC metadata \`${key}\``,
      actual: md,
      expected: expectedValue !== undefined ? { [key]: expectedValue } : key,
    };
  }

  if (expectedValue === undefined) {
    return {
      passed: true,
      message: `to have gRPC metadata \`${key}\``,
      actual: entry[1],
      expected: key,
    };
  }

  return {
    passed: entry[1] === expectedValue,
    message: `to have gRPC metadata \`${key}\` = ${inspect(expectedValue)}`,
    actual: entry[1],
    expected: expectedValue,
  };
};

// =============================================================================
// Registration — side effect
// =============================================================================

/**
 * Register gRPC matchers onto the shared `Expectation` prototype. Called
 * from `./index.ts` during the same side-effect block that registers the
 * contract adapter; users get matchers + adapter from a single
 * `import "@glubean/grpc"`.
 *
 * Idempotent: catches the "matcher already exists" error thrown by
 * `Expectation.extend` when the module is evaluated more than once
 * (duplicate imports, Vitest isolation boundaries, etc.).
 */
export function registerGrpcMatchers(): void {
  try {
    Expectation.extend({
      toHaveGrpcStatus,
      toHaveGrpcOk,
      toHaveGrpcMetadata,
    });
  } catch (err) {
    if (err instanceof Error && /already exists/.test(err.message)) {
      // Idempotent — re-import in a second harness instance is fine.
      return;
    }
    throw err;
  }
}
