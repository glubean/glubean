/**
 * Type-level tests for the attachment model on the real SDK path.
 *
 * Uses `contract.http.with(...)` factory (the real public API) to prove:
 *   - `.case("key")` preserves per-case Needs from `needs: SchemaLike<T>`
 *   - `contract.bootstrap(ref, { run })` rejects wrong run return types
 *   - No-needs cases produce void ref; void-returning bootstrap OK
 *
 * Complements Spike 0 standalone proof by verifying the production type
 * chain (register → dispatcher → ProtocolContract → .case → bootstrap)
 * actually wires up `NoInfer<Needs>` correctly.
 *
 * No runtime assertions. Only type correctness. Runs via `tsc --noEmit`.
 *
 * @see contract-attachment-model.md v1.3
 * @see __spikes__/attachment-model-types.ts for the isolated proof
 */

/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-unused-expressions */

import { contract } from "./index.js";
import type { SchemaLike } from "./types.js";

// Fabricate a SchemaLike<T> for type-only tests (no runtime parse).
function s<T>(): SchemaLike<T> {
  return {} as SchemaLike<T>;
}

// Minimal mock http client — typed enough for the factory `.with(...)` call.
const mockClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get: (async (_url: string, _opts?: unknown) => ({ status: 200, body: {} })) as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  post: (async (_url: string, _opts?: unknown) => ({ status: 200, body: {} })) as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  put: (async (_url: string, _opts?: unknown) => ({ status: 200, body: {} })) as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete: (async (_url: string, _opts?: unknown) => ({ status: 200, body: {} })) as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  patch: (async (_url: string, _opts?: unknown) => ({ status: 200, body: {} })) as any,
};

const api = contract.http.with("type-d-tests", { client: mockClient as any });

// =============================================================================
// Test 1: contract.bootstrap rejects wrong run return shape
// =============================================================================

{
  const getUser = api("user.get", {
    endpoint: "GET /users/:userId",
    cases: {
      success: {
        description: "fetch user",
        needs: s<{ token: string; userId: string }>(),
        expect: { status: 200 },
      },
    },
  });

  const ref = getUser.case("success");

  // Introspect the ref's phantom input — must be { token, userId }, NOT `any`
  type RefInput = typeof ref extends { __phantom_inputs?: infer I } ? I : never;
  const _assertHasToken: RefInput = { token: "t", userId: "u" };
  // @ts-expect-error — RefInput must not accept arbitrary keys (proves not `any`)
  const _assertNotAny: RefInput = { completelyWrongField: "x" };

  // CORRECT: run returns exact Needs shape
  const goodOverlay = contract.bootstrap(ref, async (_ctx) => ({
    token: "t",
    userId: "u",
  }));

  // WRONG: run return `{ token }` missing `userId`
  // @ts-expect-error — run return does not satisfy Needs `{ token, userId }`
  const badMissingField = contract.bootstrap(ref, async (_ctx) => ({
    token: "t",
  }));

  void goodOverlay;
  void badMissingField;
}

// =============================================================================
// Test 2: structured bootstrap form preserves Params inference
// =============================================================================

{
  const getUser = api("user.get2", {
    endpoint: "GET /users/:userId",
    cases: {
      success: {
        description: "fetch user",
        needs: s<{ token: string; userId: string }>(),
        expect: { status: 200 },
      },
    },
  });

  const ref = getUser.case("success");

  // CORRECT: structured form with params; run sees typed params
  const goodStructured = contract.bootstrap(ref, {
    params: s<{ userIdOverride: string }>(),
    run: async (_ctx, params) => ({
      token: "t",
      userId: params.userIdOverride,
    }),
  });

  void goodStructured;
}

// =============================================================================
// Test 3: no-needs case accepts void-returning bootstrap
// =============================================================================

{
  const health = api("health.read", {
    endpoint: "GET /health",
    cases: {
      ok: {
        description: "service healthy",
        expect: { status: 200 },
      },
    },
  });

  const ref = health.case("ok");

  // Ref input phantom should be `void` (no needs declared)
  type RefInput = typeof ref extends { __phantom_inputs?: infer I } ? I : never;
  const _voidOk: RefInput = undefined as void;

  // Void return OK for no-needs case
  const noNeedsOverlay = contract.bootstrap(ref, async (_ctx) => {
    /* pure side-effect prep */
  });

  void noNeedsOverlay;
}
