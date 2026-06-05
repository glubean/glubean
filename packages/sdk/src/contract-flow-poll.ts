/**
 * @module contract-flow-poll
 *
 * Bounded poll-until primitive for `contract.flow()` — runtime + projection.
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

import type {
  ContractCaseRef,
  ProtocolContract,
  FieldMapping,
} from "./contract-types.js";
import type { TestContext, SchemaLike } from "./types.js";
import { Expectation } from "./expect.js";
import {
  type BranchPredicate,
  type OpaquePredicate,
  type ExtractedPredicate,
  evalPredicate,
  extractPredicate,
} from "./contract-flow-condition.js";

// =============================================================================
// Runtime poll step
// =============================================================================

/**
 * Runtime representation of a `flow().poll()` step. Carries live callbacks +
 * the live contract ref. Never serialized — `extractPollStep` produces the
 * JSON-safe form.
 *
 * The exit predicate (`until`) is over the RESPONSE (not state): L2 declarative
 * (`BranchPredicate`, projectable) or opaque (L1 sync / L0 async, marked). The
 * opaque form additionally receives `state` so a poll can wait for the response
 * to reflect something already in state (e.g. `res.version >= state.lastSeen`).
 */
export interface RuntimePollStep {
  kind: "poll";
  name?: string;
  ref: ContractCaseRef<any, any, any, any>;
  caseKey: string;
  /** Live contract instance (mirrors ref.contract). */
  contract: ProtocolContract<any, any, any>;
  bindings?: {
    in?: (state: any) => any;
    out?: (state: any, response: any) => any;
    accept?: readonly unknown[];
  };
  /** Exit predicate — L2 declarative (over the response) or opaque (gets ctx, res, state). */
  until:
    | BranchPredicate<any>
    | {
        kind: "opaque";
        sync: boolean;
        fn: (ctx: TestContext, res: any, state: any) => boolean | Promise<boolean>;
      };
  /** Author-supplied label (opaque tiers require it; L2 can auto-generate). */
  message?: string;
  /** Interval between attempts (ms). */
  every: number;
  /** Multiplier applied to `every` after each retry (1 = fixed). Capped at BACKOFF_CAP_MS. */
  backoff: number;
  /** Total wall-clock bound (ms). */
  timeoutMs?: number;
  /** Per-attempt budget (ms) — required when `timeoutMs` is absent. */
  perAttemptTimeoutMs?: number;
  /** Max attempts (>= 1). */
  maxAttempts?: number;
}

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
 * A child `TestContext` whose event-emitting methods buffer instead of emitting,
 * so a poll attempt's side effects can be discarded (probe noise / timed-out
 * orphan) or merged (the satisfying attempt / an in-budget user predicate).
 *
 * Pass-through accessors (vars / secrets / session / http) delegate to the real
 * ctx unchanged. `validate` runs the schema locally (the adapter needs its
 * return value) and buffers the event replay. `expect` routes through the
 * buffered `assert`. `skip` / `fail` are control flow — they delegate to the
 * real ctx and throw; the poll loop catches any rejection from a raced-out
 * attempt so a late skip/fail cannot surface as an unhandled rejection.
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

  const q = {
    ...real,
    log: (message: string, data?: unknown) => {
      buffer.push((t) => t.log(message, data));
    },
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
    warn: (condition: boolean, message: string) => {
      buffer.push((t) => t.warn(condition, message));
    },
    validate: <T>(
      data: unknown,
      schema: SchemaLike<T>,
      label?: string,
      options?: unknown,
    ): T | undefined => {
      // Run the schema NOW (the adapter consumes the return value); buffer the
      // event so it only lands on the real ctx if this attempt is flushed.
      const parsed = (schema as { safeParse?: (d: unknown) => { success: boolean; data?: T } })
        .safeParse?.(data);
      const ok = parsed ? parsed.success : true;
      recordAssert(ok);
      buffer.push((t) =>
        (t.validate as (...args: unknown[]) => unknown)(data, schema, label, options),
      );
      return parsed && parsed.success ? parsed.data : undefined;
    },
    trace: (request: unknown) => {
      buffer.push((t) => (t.trace as (r: unknown) => void)(request));
    },
    action: (a: unknown) => {
      buffer.push((t) => (t.action as (a: unknown) => void)(a));
    },
    event: (ev: unknown) => {
      buffer.push((t) => (t.event as (e: unknown) => void)(ev));
    },
    metric: (name: string, value: number, options?: unknown) => {
      buffer.push((t) => (t.metric as (...args: unknown[]) => void)(name, value, options));
    },
    // skip / fail are control flow — delegate to the real ctx (they throw).
    skip: (reason?: string): never => real.skip(reason),
    fail: (message: string): never => {
      failed = true;
      return real.fail(message);
    },
  } as unknown as QuarantinedContext;

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
// Exit-predicate evaluation (three tiers)
// =============================================================================

function isOpaqueExit(
  p: RuntimePollStep["until"],
): p is { kind: "opaque"; sync: boolean; fn: (ctx: TestContext, res: any, state: any) => boolean | Promise<boolean> } {
  return (p as { kind?: string }).kind === "opaque";
}

/**
 * Evaluate a poll exit predicate. L2 declarative reads the RESPONSE (`evalPredicate`
 * with subject = response). Opaque tiers get `(ctx, res, state)`. Non-boolean
 * results fail fast (mirrors condition Phase 6); a thrown error / `ctx.skip()`
 * propagates to the caller.
 */
export async function evalPollExit(
  until: RuntimePollStep["until"],
  response: unknown,
  ctx: TestContext,
  state: unknown,
): Promise<boolean> {
  if (isOpaqueExit(until)) {
    const out = until.fn(ctx, response, state);
    if (until.sync && out && typeof (out as { then?: unknown }).then === "function") {
      throw new Error(
        "pollFn (L1) exit predicate must be synchronous — it returned a thenable. Use pollAsync for async/I-O exit predicates.",
      );
    }
    const result = await out;
    if (typeof result !== "boolean") {
      throw new Error(
        `${until.sync ? "pollFn (L1)" : "pollAsync (L0)"} exit predicate must return a boolean; ` +
          `got ${result === null ? "null" : typeof result}`,
      );
    }
    return result;
  }
  // L2 declarative — predicate subject is the response.
  return evalPredicate(until as BranchPredicate<any>, response as any);
}

// =============================================================================
// Build-time bound validation
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
// =============================================================================

export interface ExtractedPollStep {
  kind: "poll";
  name?: string;
  contractId: string;
  caseKey: string;
  protocol: string;
  target: string;
  inputs?: FieldMapping[];
  outputs?: FieldMapping[];
  accept?: ReadonlyArray<string | number>;
  /** Exit predicate — L2 precise (compare/in/...) or `{kind:"opaque",...}`. */
  until: ExtractedPredicate;
  message?: string;
  every: number;
  backoff: number;
  timeoutMs?: number;
  perAttemptTimeoutMs?: number;
  maxAttempts?: number;
}

/**
 * Normalize a runtime poll step to JSON-safe form. `dryRun` produces the
 * input/output field mappings (the same Proxy dry-run normalizeFlow uses for a
 * contract-call step), so the poll node carries data-flow edges like a step.
 */
export function extractPollStep(
  step: RuntimePollStep,
  dryRun: (step: RuntimePollStep) => { inputs?: FieldMapping[]; outputs?: FieldMapping[] },
): ExtractedPollStep {
  const projection = (step.contract as { _projection: { id: string; protocol: string; target?: string } })._projection;
  const { inputs, outputs } = dryRun(step);
  const untilExtracted: ExtractedPredicate = isOpaqueExit(step.until)
    ? { kind: "opaque", strictness: step.until.sync ? "L1" : "L0", mayDoAsyncIO: !step.until.sync }
    : extractPredicate(step.until as BranchPredicate<any>);
  return {
    kind: "poll",
    ...(step.name ? { name: step.name } : {}),
    contractId: projection.id,
    caseKey: step.caseKey,
    protocol: projection.protocol,
    target: projection.target ?? "",
    ...(inputs && inputs.length ? { inputs } : {}),
    ...(outputs && outputs.length ? { outputs } : {}),
    ...(step.bindings?.accept ? { accept: step.bindings.accept as ReadonlyArray<string | number> } : {}),
    until: untilExtracted,
    ...(step.message ? { message: step.message } : {}),
    every: step.every,
    backoff: step.backoff,
    ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
    ...(step.perAttemptTimeoutMs !== undefined ? { perAttemptTimeoutMs: step.perAttemptTimeoutMs } : {}),
    ...(step.maxAttempts !== undefined ? { maxAttempts: step.maxAttempts } : {}),
  };
}
