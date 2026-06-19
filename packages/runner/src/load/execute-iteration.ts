/**
 * Single load-iteration executor — runs ONE scenario iteration through the shared
 * engine `RunnerCore`, reusing the exact test() execution surface (ctx.http /
 * session / vars / steps / branch / poll / setup / teardown) via the engine's
 * generic `ctxExtensions` seam.
 *
 * A `LoadScenario` is compiled ONCE (`compileLoadScenario`) into engine steps:
 * `LoadStepDefinition` mirrors the SDK's step/branch/poll runtime shape, which the
 * engine detects structurally — so the conversion is a re-label, not a re-built
 * run-loop. Compilation also resolves each step's `LoadAssertionFailureMode` into
 * the engine's neutral `continueOnAssertionFailure` hint (the load `continue`
 * default keeps a transaction running after a soft assertion failure) and carries
 * `meta.group` through for report attribution. Load-only ctx members (`input` /
 * `producerSlot` / `iteration` / `now` / `report`) ride in on `ctxExtensions`.
 *
 * The executor owns the iteration lifecycle: it brackets the run with
 * `iteration:start` / `iteration:end` on the sink and threads a per-iteration
 * `report` whose checkpoints emit through the same sink. Concurrency, pacing,
 * feeder allocation, and the producer-release boundary live in the orchestrator
 * (M3-f) and the phase split (M5/M6) — this function runs exactly one iteration.
 */
import type {
  RunnerCore,
  ScopeInput,
  StepDef,
  TestDef,
  TestFn,
  TestResult,
} from "@glubean/engine";
import type {
  LoadAssertionFailureMode,
  LoadErrorKind,
  LoadIteration,
  LoadPrimaryCompletionReceipt,
  LoadProducerSlot,
  LoadReportSignal,
  LoadScenario,
  LoadStepDefinition,
} from "@glubean/sdk/load";
import { isLoadBranchStep } from "@glubean/sdk/load";
import { AdmissionCancelledError, ContinuationBacklogFullError, type ContinuationPool } from "./continuation-pool.js";
import type { LoadIterationEnvelope, LoadSink } from "./sink.js";

/** Phantom-typed Input so a compiled scenario stays coupled to its input type. */
declare const COMPILED_INPUT: unique symbol;

/**
 * A `LoadScenario` lowered to engine-ready steps, computed once and reused across
 * every iteration of the run (only the per-iteration `meta.id` differs). The
 * `steps` already carry the resolved `continueOnAssertionFailure` hint + group.
 */
export interface CompiledLoadScenario<Input = unknown> {
  /** @internal phantom — preserves the Input type through compilation. */
  readonly [COMPILED_INPUT]?: (input: Input) => void;
  scenarioId: string;
  name: string;
  setup?: TestFn;
  steps: StepDef[];
  teardown?: TestFn;
}

/** Options for resolving a scenario's assertion-failure policy chain. */
export interface CompileLoadScenarioOptions {
  /**
   * The `loadRunner`-level default `onFailure` (the lowest-precedence rung of the
   * resolution chain). Omitted → the documented default `"continue"`.
   */
  defaultOnFailure?: LoadAssertionFailureMode;
}

/**
 * Resolve a step's effective `onFailure` (most specific wins):
 *   step `assertions.onFailure` > scenario `assertions.onFailure`
 *     > loadRunner default > `"continue"`.
 */
function resolveOnFailure(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  step: LoadStepDefinition<any, any>,
  scenarioMode: LoadAssertionFailureMode | undefined,
  runnerDefault: LoadAssertionFailureMode | undefined,
): LoadAssertionFailureMode {
  return (
    step.meta.assertions?.onFailure ?? scenarioMode ?? runnerDefault ?? "continue"
  );
}

/** Lower one load step (recursing into branch sub-steps) to an engine StepDef.
 *  `inheritedGroup` is the group of an enclosing `.group()`-wrapped branch — only
 *  branch LEAVES emit `step_start`, so the branch node's group must flow down. */
function compileStep(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  step: LoadStepDefinition<any, any>,
  scenarioMode: LoadAssertionFailureMode | undefined,
  runnerDefault: LoadAssertionFailureMode | undefined,
  inheritedGroup?: string,
): StepDef {
  const onFailure = resolveOnFailure(step, scenarioMode, runnerDefault);
  // A step's own group wins; otherwise it inherits the enclosing branch's group.
  const effectiveGroup = step.meta.group ?? inheritedGroup;
  // Preserve the WHOLE step meta (name / group / timeout / retries / retryDelay /
  // backoff — all read by the engine) and only ADD the resolved policy hint + the
  // effective group. Only `continue` keeps the transaction running after a soft
  // assertion failure; `skipRemainingSteps` / `abortIteration` both halt (the
  // engine treats them the same — the iteration is marked failed and the rest
  // skipped either way). The load-only `assertions` field rides along inertly; the
  // engine never reads it.
  const meta = {
    ...step.meta,
    ...(effectiveGroup !== undefined ? { group: effectiveGroup } : {}),
    continueOnAssertionFailure: onFailure === "continue",
  };
  // Branch/poll are detected structurally by the engine via these fields; carry
  // them through, recursing so nested case/default steps inherit the policy chain
  // AND the enclosing group.
  if (isLoadBranchStep(step)) {
    const branch = step.branch;
    return {
      meta,
      fn: step.fn as unknown as TestFn,
      branch: {
        ...branch,
        cases: branch.cases.map((c) => ({
          ...c,
          steps: c.steps.map((s) => compileStep(s, scenarioMode, runnerDefault, effectiveGroup)),
        })),
        default: branch.default.map((s) => compileStep(s, scenarioMode, runnerDefault, effectiveGroup)),
      },
    } as unknown as StepDef;
  }
  // Normal or poll step (poll carries its own `.poll` data the engine reads).
  return { meta, fn: step.fn as unknown as TestFn, ...("poll" in step ? { poll: step.poll } : {}) } as unknown as StepDef;
}

/** Compile a `LoadScenario` to reusable engine steps (do this ONCE per scenario). */
export function compileLoadScenario<Input>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scenario: LoadScenario<Input, any>,
  opts: CompileLoadScenarioOptions = {},
): CompiledLoadScenario<Input> {
  const scenarioMode = scenario.meta.assertions?.onFailure;
  return {
    scenarioId: scenario.meta.id,
    name: scenario.meta.id,
    setup: scenario.setup as TestFn | undefined,
    steps: scenario.steps.map((s) => compileStep(s, scenarioMode, opts.defaultOnFailure)),
    teardown: scenario.teardown as TestFn | undefined,
  };
}

/** Re-label a compiled scenario as an engine `TestDef` for one iteration run. */
export function loadScenarioToTestDef(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  compiled: CompiledLoadScenario<any>,
  iterationId: string,
): TestDef {
  return {
    meta: { id: iterationId, name: compiled.name },
    type: "steps",
    setup: compiled.setup,
    steps: compiled.steps,
    teardown: compiled.teardown,
  };
}

/** Inputs for one iteration run. */
export interface RunLoadIterationArgs<Input = unknown> {
  core: RunnerCore;
  sink: LoadSink;
  /** The compiled scenario (compile once with `compileLoadScenario`, reuse). */
  scenario: CompiledLoadScenario<Input>;
  envelope: LoadIterationEnvelope;
  /** Per-iteration input produced by `loadRunner().input` (becomes `ctx.input`). */
  input: Input;
  producerSlot: LoadProducerSlot;
  iteration: LoadIteration;
  /** Per-iteration session overlay (copy-on-write isolation lands in M3-f). */
  session?: Record<string, unknown>;
  /** Attribution for `iteration:start` (feeder allocation lands in M3-f). */
  inputKey?: string;
  feederKeys?: Record<string, string>;
  /** Monotonic clock for the iteration duration; defaults to `performance.now`. */
  now?: () => number;
  /** Producer-release wiring (M6). When present, `ctx.report.primaryComplete(...,
   *  { releaseProducerSlot: true })` reserves a continuation slot from this pool
   *  (back-pressure / fail-iteration) and frees the producer slot at the boundary;
   *  absent → the M5 closed model (release is a no-op phase split). */
  continuation?: { pool: ContinuationPool };
}

/**
 * Handle to a started iteration whose producer slot may be released mid-run (M6).
 * `primaryDone` lets the orchestrator free the slot at the right moment;
 * `completed` is the whole iteration (continuation included) for drain + counting.
 */
export interface LoadIterationHandle {
  /** Resolves when the PRODUCER SLOT is free to start the next primary: at the
   *  release boundary (`released: true`) or, with no release, at full completion. */
  primaryDone: Promise<{ released: boolean }>;
  /** Resolves when the whole iteration (incl. any continuation) settles. */
  completed: Promise<RunLoadIterationResult>;
}

/** Outcome of one iteration run (the engine `TestResult` plus the load verdict). */
export interface RunLoadIterationResult {
  ok: boolean;
  durationMs: number;
  errorKind?: LoadErrorKind;
  /** The scenario called `ctx.skip()` — the iteration opted out (not a failure).
   *  Distinct skip accounting in the artifact is future work; for now a skipped
   *  iteration is reported `ok` so it never pollutes failure/assertion stats. */
  skipped?: boolean;
  /** The engine result, or null if the core itself threw (infra error). */
  result: TestResult | null;
}

/**
 * Map an engine `TestResult` to a load `errorKind`.
 *
 * A load scenario is always lowered to a STEPS `TestDef`, and the engine catches
 * step/poll/teardown throws — so a top-level throw (`result.threw`) means the
 * scenario `setup` failed: classify it as `setupError`. For caught step/poll
 * failures the engine surfaces the error NAME in `stepErrorName`, so a request
 * timeout (`TimeoutError`), step timeout (`StepTimeoutError`), or HTTP error
 * (`HTTPError`) still classifies correctly; a soft assertion failure leaves no
 * thrown error and the generic "assertion failed" text.
 *
 * NOTE: with the engine's default `throwHttpErrors: false` a non-2xx response does
 * NOT throw — it surfaces as the endpoint's `ok:false` / status in
 * `request:observed` (endpoint error rate), not as an iteration `errorKind`; only
 * an explicit HTTP throw yields `"http"` here.
 */
function classifyIterationError(result: TestResult): LoadErrorKind {
  if (result.threw) return "setupError";
  const name = result.stepErrorName;
  const msg = result.error ?? "";
  if (name === "TimeoutError" || name === "StepTimeoutError" || /timed out/i.test(msg)) return "timeout";
  if (name === "HTTPError") return "http";
  // A backlog-full release rejection (fail-iteration policy) failed the iteration.
  if (name === "ContinuationBacklogFullError") return "continuationBacklogFull";
  if (name !== undefined) return "stepError";
  if (msg === "" || msg === "assertion failed") return "assertion";
  return "stepError";
}

/** A producer-slot release request, handled by `startLoadIteration`'s coordinator
 *  (admit to the continuation pool, emit producer:released, free the slot). */
type ReleaseFn = (info: { primaryId: string; primaryDurationMs: number }) => Promise<LoadPrimaryCompletionReceipt>;

/**
 * A per-iteration `report` whose signals emit through the sink with attribution.
 *
 * `primaryComplete` records the measurement boundary (M5): the FIRST call stamps
 * `primaryDurationMs` (iteration start → now), emits `producer:primaryCompleted`,
 * and flips the sink into this iteration's continuation phase; later calls are
 * duplicates. With `releaseProducerSlot: true` AND a `release` coordinator (M6) it
 * also frees the producer slot via the continuation pool (back-pressure /
 * fail-iteration); without a coordinator release is a no-op phase split.
 */
function makeIterationReport(
  sink: LoadSink,
  env: LoadIterationEnvelope,
  start: number,
  now: () => number,
  release?: ReleaseFn,
  rejectDuplicateRelease?: (id: string) => void,
): LoadReportSignal {
  let primaryCompleted = false;
  return {
    checkpoint(id, data) {
      sink.emitCheckpoint(env, id, data);
    },
    async primaryComplete(id, data) {
      if (primaryCompleted) {
        // A second boundary in the same iteration is ignored (one boundary per
        // logical iteration); report it as a duplicate for diagnostics. A duplicate
        // that re-requested release is recorded as a rejected duplicate signal.
        if (data?.releaseProducerSlot === true) rejectDuplicateRelease?.(id);
        return { measuredPrimaryComplete: false, releasedProducerSlot: false, duplicate: true, backpressureMs: 0 };
      }
      primaryCompleted = true;
      // `releaseProducerSlot` only requests a release when a coordinator is wired (M6).
      // Without one (the M5-only phase split), it's a documented no-op — so report
      // releaseRequested:false, else the reducer would treat this boundary as a producer
      // parked on backlog and surface spurious blockedOnBacklog / a continuation summary.
      const releaseRequested = data?.releaseProducerSlot === true && release !== undefined;
      const primaryDurationMs = Math.max(0, now() - start);
      sink.emitPrimaryCompleted(env, { primaryId: id, primaryDurationMs, releaseRequested });
      if (releaseRequested && release) {
        // Release the producer slot (may back-pressure, or throw under
        // fail-iteration → the iteration fails). Returns the full receipt.
        return release({ primaryId: id, primaryDurationMs });
      }
      return { measuredPrimaryComplete: true, releasedProducerSlot: false, duplicate: false, backpressureMs: 0 };
    },
  };
}

/**
 * The producer slot's end-state for one iteration (the M6 release lifecycle). It
 * starts `held`, the release coordinator moves it to `released` / `releasedForDrain`
 * AT MOST ONCE (mutually-exclusive code paths), and it drives the `completed`
 * finalizer:
 *  - `held`            — no release happened: the closed model, no continuation
 *                        coordinator, or a `fail-iteration` backlog-full that threw.
 *                        The slot was held to the end; the finalizer resolves
 *                        `primaryDone({ released: false })`.
 *  - `released`        — a pool slot was acquired at the boundary and the producer
 *                        moved on; the finalizer pairs it with `pool.release()` once
 *                        the continuation tail settles.
 *  - `releasedForDrain`— the boundary freed the producer but acquired NO pool slot
 *                        (the run deadline closed the pool, or this release's drain
 *                        bound expired). `primaryDone` was already resolved; the tail
 *                        drains at run-end and the finalizer does nothing.
 */
type SlotDisposition = "held" | "released" | "releasedForDrain";

/**
 * Start one scenario iteration through the engine core, bracketing it with
 * `iteration:start` / `iteration:end`. Returns a handle: `primaryDone` resolves
 * when the producer slot is free (release boundary, or full completion when no
 * release), and `completed` resolves when the whole iteration settles. Never
 * rejects: an infra-level throw from the core is recorded as a failed iteration.
 */
export function startLoadIteration<Input>(args: RunLoadIterationArgs<Input>): LoadIterationHandle {
  const { core, sink, scenario, envelope, input, producerSlot, iteration, session } = args;
  const pool = args.continuation?.pool;
  const now = args.now ?? (() => performance.now());

  sink.beginIteration(envelope);
  sink.emitIterationStart(envelope, {
    ...(args.inputKey !== undefined ? { inputKey: args.inputKey } : {}),
    ...(args.feederKeys !== undefined ? { feederKeys: args.feederKeys } : {}),
  });

  // Stamp the iteration start BEFORE building the report so `primaryComplete` can
  // measure `primaryDurationMs` from it; `start` is also the end-to-end baseline.
  const start = now();

  // The producer-slot lifecycle (see SlotDisposition). Starts "held"; the release
  // coordinator moves it to "released" / "releasedForDrain" at most once. The `as`
  // widens past the "held" literal so reads in `completed` see the full union — the
  // coordinator's writes are in an async closure CFA can't fold back into the narrowing.
  let slot = "held" as SlotDisposition;
  // The iteration couldn't honor the continuation backlog bound — a `fail-iteration`
  // release hit a full backlog, or a `block-producer` release parked past its drain
  // bound — so it MUST fail, regardless of step retries or a tail that later settles.
  let failedBacklogBound = false;
  // The iteration has fully ended (its `completed` finalizer ran). Guards a release
  // still parked on back-pressure so it hands its slot back instead of leaking.
  let iterationSettled = false;
  let resolvePrimaryDone!: (v: { released: boolean }) => void;
  const primaryDone = new Promise<{ released: boolean }>((r) => { resolvePrimaryDone = r; });

  // M6 release coordinator (only wired when a continuation pool is provided).
  const release: ReleaseFn | undefined = pool
    ? async ({ primaryId, primaryDurationMs }) => {
        try {
          const backpressureMs = await pool.admit(); // back-pressure, or throw under fail-iteration
          if (iterationSettled) {
            // The iteration already ended (e.g. a step timeout) while this release
            // was parked on back-pressure. Hand the just-acquired slot straight back
            // and do NOT release the producer slot or emit a late producer:released —
            // otherwise the slot would leak at capacity and deadlock future releases.
            pool.release();
            return { measuredPrimaryComplete: true, releasedProducerSlot: false, duplicate: false, backpressureMs };
          }
          slot = "released";
          sink.emitProducerReleased(envelope, {
            releaseId: primaryId,
            primaryDurationMs,
            continuationBacklog: pool.outstanding,
            backpressureMs,
          });
          resolvePrimaryDone({ released: true }); // free the producer slot NOW
          return { measuredPrimaryComplete: true, releasedProducerSlot: true, duplicate: false, backpressureMs };
        } catch (e) {
          if (e instanceof AdmissionCancelledError) {
            if (iterationSettled) {
              // The iteration already ended (e.g. a step timeout) before the cancel
              // hit this parked admit. It's no longer tracked — don't emit a
              // rejection or resolve primaryDone (already done), just return.
              return { measuredPrimaryComplete: true, releasedProducerSlot: false, duplicate: false, backpressureMs: e.waitMs };
            }
            // Either the run's wall-clock deadline closed the pool, or this release's
            // own drain bound expired (the backlog never freed). Both free the producer
            // for liveness and leave the continuation tail to be drained at run-end
            // (no pool slot acquired), but they're DIFFERENT outcomes:
            //  - runDeadlineReached: the run is ending; the primary was already complete
            //    and is released-for-drain — NOT an iteration failure.
            //  - drainTimeout: the backlog stayed full past the drain bound mid-run — the
            //    same terminal outcome as fail-iteration, so the iteration MUST fail (else
            //    the slot would silently run over the configured backlog bound).
            sink.emitProducerReleaseRejected(envelope, {
              releaseId: primaryId,
              reason: e.reason,
              waitMs: e.waitMs,
              continuationBacklog: pool.outstanding,
            });
            slot = "releasedForDrain"; // freed at the boundary, no pool slot to pair with release()
            if (e.reason === "drainTimeout") failedBacklogBound = true;
            resolvePrimaryDone({ released: true }); // free the slot + track the tail
            return { measuredPrimaryComplete: true, releasedProducerSlot: false, duplicate: false, backpressureMs: e.waitMs };
          }
          if (e instanceof ContinuationBacklogFullError) {
            sink.emitProducerReleaseRejected(envelope, {
              releaseId: primaryId,
              reason: "continuationBacklogFull",
              waitMs: 0,
              continuationBacklog: pool.outstanding,
            });
            // fail-iteration: the iteration MUST fail. Throw the TYPED error so a
            // non-retried step classifies as "continuationBacklogFull"; also latch the
            // flag so that if the step has `retries`, the retry's duplicate
            // primaryComplete (which returns success) can't let the iteration pass. The
            // slot stays "held" — the throw propagates and the finalizer frees it.
            failedBacklogBound = true;
          }
          throw e;
        }
      }
    : undefined;

  // Record a duplicate release request (a second primaryComplete that re-asks for
  // release) so the continuation summary's duplicateReleaseSignals reflects it.
  const rejectDuplicateRelease = pool
    ? (id: string) =>
        sink.emitProducerReleaseRejected(envelope, {
          releaseId: id,
          reason: "duplicateRelease",
          waitMs: 0,
          continuationBacklog: pool.outstanding,
        })
    : undefined;

  const scope: ScopeInput = {
    ...(session !== undefined ? { session } : {}),
    ctxExtensions: {
      input,
      producerSlot,
      iteration,
      now,
      report: makeIterationReport(sink, envelope, start, now, release, rejectDuplicateRelease),
    },
  };

  const completed = (async (): Promise<RunLoadIterationResult> => {
    let result: TestResult | null = null;
    let ok = false;
    let skipped = false;
    let errorKind: LoadErrorKind | undefined;
    try {
      result = await core.run(loadScenarioToTestDef(scenario, envelope.iterationId), scope);
      if (result.status === "skipped") {
        // `ctx.skip()` opted this iteration out — not a success and not a failure.
        ok = true;
        skipped = true;
      } else {
        ok = result.status === "ok";
        errorKind = ok ? undefined : classifyIterationError(result);
      }
    } catch {
      // The engine resolves user errors into a TestResult; reaching here means the
      // core itself threw (infra). Record it as a runner-crash-flavoured failure.
      ok = false;
      errorKind = "runnerCrash";
    }
    // A backlog-bound failure is terminal regardless of step retries / a tail that
    // later settles: the iteration couldn't honor the backlog bound, so it fails. This
    // covers both fail-iteration (full → throw immediately) and block-producer
    // drain-timeout (parked past the drain bound → give up) — a retry's duplicate
    // primaryComplete returns success and could otherwise let the iteration (and a
    // re-run primary side effect) pass.
    if (failedBacklogBound) {
      ok = false;
      errorKind = "continuationBacklogFull";
    }
    const durationMs = now() - start;
    // Mark the iteration done BEFORE finalizing, so a release still parked on
    // back-pressure (its step having timed out) returns its slot instead of leaking.
    iterationSettled = true;

    try {
      sink.emitIterationEnd(envelope, { ok, durationMs, ...(errorKind !== undefined ? { errorKind } : {}) });
      sink.endIteration(envelope.iterationId);
    } catch {
      // Finalization is best-effort — a sink hiccup must neither reject this
      // promise nor (via the finally below) hang the producer slot.
    } finally {
      // Settle the slot per its end-state (see SlotDisposition). This MUST run so the
      // slot loop's `await primaryDone` never hangs.
      //  - "released":        pair the acquired pool slot with a release now the tail settled.
      //  - "held":            no release happened — free the producer slot it held to the end.
      //  - "releasedForDrain": primaryDone already resolved at the boundary, no pool slot held.
      if (slot === "released") pool?.release();
      else if (slot === "held") resolvePrimaryDone({ released: false });
    }

    return {
      ok,
      durationMs,
      ...(errorKind !== undefined ? { errorKind } : {}),
      ...(skipped ? { skipped: true } : {}),
      result,
    };
  })();

  return { primaryDone, completed };
}

/**
 * Run one scenario iteration to completion (closed model). The M5/M3 entry: it
 * awaits the WHOLE iteration. The orchestrator uses `startLoadIteration` directly
 * for M6 producer-release scheduling.
 */
export async function runLoadIteration<Input>(
  args: RunLoadIterationArgs<Input>,
): Promise<RunLoadIterationResult> {
  return startLoadIteration(args).completed;
}
