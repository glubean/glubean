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
  LoadProducerSlot,
  LoadReportSignal,
  LoadScenario,
  LoadStepDefinition,
} from "@glubean/sdk/load";
import { isLoadBranchStep } from "@glubean/sdk/load";
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
  if (name !== undefined) return "stepError";
  if (msg === "" || msg === "assertion failed") return "assertion";
  return "stepError";
}

/**
 * A per-iteration `report` whose signals emit through the sink with attribution.
 *
 * `primaryComplete` (M5) records the measurement boundary: the FIRST call stamps
 * `primaryDurationMs` (iteration start → now), emits `producer:primaryCompleted`,
 * and flips the sink into this iteration's continuation phase; later calls are
 * duplicates (no second boundary). Producer release / backpressure are M6, so
 * `releasedProducerSlot` is always false and `releaseProducerSlot: true` is merely
 * forwarded on the event as `releaseRequested`.
 */
function makeIterationReport(
  sink: LoadSink,
  env: LoadIterationEnvelope,
  start: number,
  now: () => number,
): LoadReportSignal {
  let primaryCompleted = false;
  return {
    checkpoint(id, data) {
      sink.emitCheckpoint(env, id, data);
    },
    async primaryComplete(id, data) {
      if (primaryCompleted) {
        // A second boundary in the same iteration is ignored (one boundary per
        // logical iteration); report it as a duplicate for diagnostics.
        return { measuredPrimaryComplete: false, releasedProducerSlot: false, duplicate: true, backpressureMs: 0 };
      }
      primaryCompleted = true;
      sink.emitPrimaryCompleted(env, {
        primaryId: id,
        primaryDurationMs: Math.max(0, now() - start),
        releaseRequested: data?.releaseProducerSlot === true,
      });
      return { measuredPrimaryComplete: true, releasedProducerSlot: false, duplicate: false, backpressureMs: 0 };
    },
  };
}

/**
 * Run one scenario iteration through the engine core, bracket it with
 * `iteration:start` / `iteration:end`, and feed every wire event to the sink.
 * Never rejects: an infra-level throw from the core is recorded as a failed
 * iteration (so one bad iteration can't take down the orchestrator).
 */
export async function runLoadIteration<Input>(
  args: RunLoadIterationArgs<Input>,
): Promise<RunLoadIterationResult> {
  const { core, sink, scenario, envelope, input, producerSlot, iteration, session } = args;
  const now = args.now ?? (() => performance.now());

  sink.beginIteration(envelope);
  sink.emitIterationStart(envelope, {
    ...(args.inputKey !== undefined ? { inputKey: args.inputKey } : {}),
    ...(args.feederKeys !== undefined ? { feederKeys: args.feederKeys } : {}),
  });

  // Stamp the iteration start BEFORE building the report so `primaryComplete` can
  // measure `primaryDurationMs` from it; `start` is also the end-to-end baseline.
  const start = now();
  const scope: ScopeInput = {
    ...(session !== undefined ? { session } : {}),
    ctxExtensions: {
      input,
      producerSlot,
      iteration,
      now,
      report: makeIterationReport(sink, envelope, start, now),
    },
  };

  let result: TestResult | null = null;
  let ok = false;
  let skipped = false;
  let errorKind: LoadErrorKind | undefined;
  try {
    result = await core.run(loadScenarioToTestDef(scenario, envelope.iterationId), scope);
    if (result.status === "skipped") {
      // `ctx.skip()` opted this iteration out — not a success and not a failure.
      // Report it `ok` (errorKind undefined) so it never lands in failure stats;
      // the `skipped` flag lets a caller account for it separately later.
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
  const durationMs = now() - start;

  sink.emitIterationEnd(envelope, { ok, durationMs, ...(errorKind !== undefined ? { errorKind } : {}) });
  sink.endIteration(envelope.iterationId);

  return {
    ok,
    durationMs,
    ...(errorKind !== undefined ? { errorKind } : {}),
    ...(skipped ? { skipped: true } : {}),
    result,
  };
}
