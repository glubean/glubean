/**
 * @module poll-primitives
 *
 * Bounded poll-until primitives — shared by the vNext `workflow().poll`
 * executor, `test()` helpers, and (until D2 deletes it) the legacy
 * `contract.flow()` loop. Renamed from `contract-flow-poll.ts` (Nv1-D1,
 * 2026-06-13): the quarantine/budget/bounds machinery was never
 * flow-specific. The legacy flow's poll step shapes that used to live here
 * were deleted with the flow itself (Nv1-D2).
 *
 * A poll repeats ONE contract case until an exit predicate over the RESPONSE
 * holds, BOUNDED by a total wall-clock deadline and/or a finite per-attempt
 * budget. It is the projectable subset of "loop" (a self-loop on one node), as
 * opposed to the arbitrary loops that stay in `test()`. See the design proposal
 * `internal/40-discovery/proposals/contract-flow-poll.md`.
 *
 * This module owns the poll-specific runtime types, the bounded-retry helpers
 * (quarantined ctx, budget race), the exit-predicate evaluator (three strictness
 * tiers, reusing the condition predicate foundation), the build-time bound
 * validation, and the JSON-safe projection. The execution LOOP lives in
 * `contract-core.ts` (it needs the shared committed-state cell).
 */

import type { TestContext, SchemaLike } from "./types.js";
import { Expectation } from "./expect.js";

/** Backoff cap — mirrors the test() step retry-backoff ceiling. */
export const BACKOFF_CAP_MS = 30_000;
/** Default interval between attempts when `every` is omitted. */
export const DEFAULT_EVERY_MS = 1000;

// =============================================================================
// Exhaustion error
// =============================================================================

export class PollExhaustedError extends Error {
  readonly attempts: number;
  constructor(stepLabel: string, attempts: number, detail?: string) {
    super(
      `poll "${stepLabel}" exhausted: condition not met after ${attempts} attempt(s)` +
        (detail ? ` (${detail})` : ""),
    );
    this.name = "PollExhaustedError";
    this.attempts = attempts;
  }
}

// =============================================================================
// Quarantined context (R8/R9/R11)
// =============================================================================

/**
 * A child `TestContext` that isolates the **pass/fail-affecting** APIs of a poll
 * attempt — `assert` / `expect` / `validate` / `fail` — so a probe's validation
 * noise or a timed-out orphan's late failure cannot corrupt the run's pass/fail
 * outcome. Those are buffered and either flushed (the satisfying attempt / an
 * in-budget deliberate failure) or discarded (probe / orphan).
 *
 * Everything else PASSES THROUGH to the real ctx and emits per-attempt, by
 * design — and this is deliberate, not an oversight:
 *   - Observability (`trace` / `metric` / `log` / `action` / `event`): the
 *     polling requests genuinely happened; their traces/metrics are wanted (you
 *     want to see "polled 3×"). Buffering them would also be inconsistent: the
 *     adapter's HTTP client is pre-bound to the real ctx at construction, so its
 *     auto-traces emit to the real ctx regardless of this wrapper — there is no
 *     way to intercept them here, so we don't pretend to.
 *   - Accessors / side effects (`vars` / `secrets` / `session` / `http`): a
 *     predicate that reads/writes these runs against the live ctx, exactly like
 *     a condition predicate does (which is also evaluated against the real ctx).
 *
 * `skip` is pure control flow — the real `skip` only throws a SkipError (it
 * emits nothing), so it is delegated. The poll loop catches any rejection from a
 * raced-out attempt so a late skip/fail cannot surface as an unhandled rejection.
 */
export interface QuarantinedContext extends TestContext {
  /** Replay all buffered emissions onto a real ctx (the satisfying attempt / in-budget predicate). */
  flushTo(target: TestContext): void;
  /** True if any buffered assertion / validation / fail recorded a failure. */
  hasFailure(): boolean;
}

export function quarantinedCtx(real: TestContext): QuarantinedContext {
  const buffer: Array<(t: TestContext) => void> = [];
  let failed = false;

  const recordAssert = (passed: boolean): void => {
    if (!passed) failed = true;
  };

  // `Object.create(real)` (not a spread) so PROTOTYPE-inherited APIs survive —
  // a fixture-augmented ctx (test.extend) carries vars/http/log/etc. on its
  // prototype chain, which `{ ...real }` would drop. Accessors + observability
  // resolve through the prototype; only the pass/fail APIs below are overridden.
  // `skip` is intentionally NOT overridden — it inherits real.skip (throws a
  // SkipError, emits nothing → safe to delegate).
  const q = Object.assign(Object.create(real) as TestContext, {
    assert: (
      a: boolean | { passed: boolean; actual?: unknown; expected?: unknown },
      message?: string,
      details?: unknown,
    ) => {
      const passed = typeof a === "boolean" ? a : a.passed;
      recordAssert(passed);
      buffer.push((t) => (t.assert as (...args: unknown[]) => void)(a, message, details));
    },
    expect: <V>(actual: V): Expectation<V> =>
      new Expectation(actual, (result) => {
        recordAssert(result.passed);
        buffer.push((t) =>
          (t.assert as (...args: unknown[]) => void)(
            { passed: result.passed, actual: result.actual, expected: result.expected },
            result.message,
          ),
        );
      }),
    validate: <T>(
      data: unknown,
      schema: SchemaLike<T>,
      label?: string,
      options?: unknown,
    ): T | undefined => {
      // Run the schema NOW (the adapter consumes the return value); buffer the
      // event so it only lands on the real ctx if this attempt is flushed.
      // Mirror ctx.validate: support both safeParse and parse-only SchemaLikes
      // (a parse-only schema must still run + transform, not silently no-op).
      const s = schema as {
        safeParse?: (d: unknown) => { success: boolean; data?: T };
        parse?: (d: unknown) => T;
      };
      let ok = true;
      let value: T | undefined;
      if (typeof s.safeParse === "function") {
        const r = s.safeParse(data);
        ok = r.success;
        value = r.success ? r.data : undefined;
      } else if (typeof s.parse === "function") {
        try {
          value = s.parse(data);
        } catch {
          ok = false;
        }
      } else {
        // Neither safeParse nor parse (a `jsonSchema`-only SchemaLike, GLU-90):
        // nothing can prove the data valid, so this is a FAILED validation —
        // exactly what the real ctx records ("Schema has neither safeParse nor
        // parse method", harness.ts / engine.ts / workflow execute.ts all route
        // it through the failure branch). Leaving `ok = true` here made a
        // `severity: "fatal"` call return `undefined` without aborting, which
        // the narrowed `T` return type promises can never happen.
        ok = false;
      }
      recordAssert(ok);
      buffer.push((t) =>
        (t.validate as (...args: unknown[]) => unknown)(data, schema, label, options),
      );
      // `severity: "fatal"` aborts at the validation point in the real ctx —
      // preserve that control flow (the buffered event still flushes/discards
      // with the attempt). The throw propagates; the poll loop flushes this
      // ctx for an in-budget throw, discards it for a timed-out orphan.
      if (!ok && (options as { severity?: string } | undefined)?.severity === "fatal") {
        throw new Error(`fatal validation failed: ${label ?? "data"}`);
      }
      return value;
    },
    // fail emits a failed assertion AND bumps the counter in the real ctx, so it
    // must NOT delegate (a timed-out orphan would mutate the abandoned run).
    // Buffer the failure event + throw locally; the poll loop flushes this ctx
    // for an in-budget fail (the assertion lands + the throw fails the poll) and
    // discards it for an orphan.
    fail: (message: string): never => {
      failed = true;
      buffer.push((t) => (t.assert as (...args: unknown[]) => void)({ passed: false }, message));
      throw new Error(message);
    },
  }) as unknown as QuarantinedContext;

  q.flushTo = (target: TestContext): void => {
    for (const replay of buffer) replay(target);
  };
  q.hasFailure = (): boolean => failed;
  return q;
}

// =============================================================================
// Budget race
// =============================================================================

/**
 * Race a promise against a finite budget (ms). If the budget elapses first,
 * reject with `onTimeout()`. A non-finite budget degrades to a plain await
 * (build-time validation guarantees attempt budgets are finite, so this only
 * happens defensively).
 */
export function raceBudget<T>(
  promise: Promise<T>,
  budgetMs: number,
  onTimeout: () => Error,
): Promise<T> {
  if (!Number.isFinite(budgetMs)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), Math.max(0, budgetMs));
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// =============================================================================

/**
 * Validate poll bounds at construction. Two rules (both required), plus
 * finiteness on every timing value (an `Infinity` bound would un-bound the loop):
 *   1. total stop condition: `timeout` OR `maxAttempts`
 *   2. finite per-attempt budget: `timeout` OR `perAttemptTimeout`
 * (so `maxAttempts`-only — with no per-attempt budget — is illegal: a single
 * hung request/predicate could block forever before the attempt counter advances.)
 */
export function validatePollBounds(
  bounds: {
    timeout?: number;
    maxAttempts?: number;
    perAttemptTimeout?: number;
    every?: number;
    backoff?: number;
  },
  stepLabel: string,
): void {
  const { timeout, maxAttempts, perAttemptTimeout, every, backoff } = bounds;
  const finitePos = (v: number | undefined, name: string, min = 0, integer = false): void => {
    if (v === undefined) return;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || (integer && !Number.isInteger(v))) {
      throw new Error(
        `poll "${stepLabel}": \`${name}\` must be a finite ${integer ? "integer " : ""}number >= ${min}; got ${String(v)}`,
      );
    }
  };
  finitePos(timeout, "timeout", 1);
  finitePos(maxAttempts, "maxAttempts", 1, true);
  finitePos(perAttemptTimeout, "perAttemptTimeout", 1);
  finitePos(every, "every", 0);
  finitePos(backoff, "backoff", 1);

  if (timeout === undefined && maxAttempts === undefined) {
    throw new Error(
      `poll "${stepLabel}": needs a stop condition — provide \`timeout\` or \`maxAttempts\`.`,
    );
  }
  if (timeout === undefined && perAttemptTimeout === undefined) {
    throw new Error(
      `poll "${stepLabel}": a \`maxAttempts\`-only poll is not bounded — a single hung request/predicate ` +
        `could block forever. Provide \`timeout\` (total wall-clock) or \`perAttemptTimeout\` (per-attempt budget).`,
    );
  }
}

// =============================================================================
// Projection (JSON-safe)
