/**
 * engine-bridge — drive @glubean/engine's RunnerCore from inside the harness
 * subprocess (runner-on-engine migration, plan 0005).
 *
 * Phase 0: behind the GLUBEAN_USE_ENGINE flag (default OFF → 100% legacy). When
 * ON, harness.ts:executeNewTest delegates the run-loop to RunnerCore; this module
 * maps the engine's canonical events back to the runner's NDJSON wire shape so the
 * parent (executor) sees a byte-identical event stream. Parity is proven by
 * running the SAME module through the harness subprocess twice (flag off/on) and
 * diffing the raw ExecutionEvent stream — see engine-parity.test.ts.
 *
 * The carrier MUST be installed (RunnerCore constructor) BEFORE harness.ts calls
 * setRuntime(), so the SDK process-global runtime fallback and the engine's
 * runWithRuntime() share one carrier (plan 0005 §接缝设计 / codex P1-5).
 */
import {
  RunnerCore,
  toTestDef,
  type ExecutionEvent,
  type RunnerServices,
  type TestResult,
  type ScopeInput,
} from "@glubean/engine";
import { createAlsCarrier } from "@glubean/sdk/internal";
import type { Test } from "@glubean/sdk";

/** Default OFF: production stays on the legacy run-loop until the cutover. */
export const USE_ENGINE = process.env.GLUBEAN_USE_ENGINE === "1";

// Per-test allowlist (plan 0005): while the engine ctx is being brought to parity
// incrementally, the flag alone must NOT route arbitrary tests through an incomplete
// ctx (codex). GLUBEAN_ENGINE_TESTIDS is a comma list of EXACT test ids to route —
// the parity instrument sets it for its own fixtures. There is deliberately no
// "route all" wildcard yet: workflow/contract/etc. build plain simple-shaped Tests
// that look routable but need unmigrated ctx APIs, so a blanket cutover waits until
// those features land (Phase 8 wires route-all explicitly). Empty → route NOTHING.
const ENGINE_TESTIDS = new Set(
  (process.env.GLUBEAN_ENGINE_TESTIDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);

/** Whether the engine should run this specific test id (flag + explicit allowlist).
 *  The Phase 8 cutover wires a "*" route-all wildcard here, but ONLY once
 *  engineSupports() excludes workflow wrapper tests (a built workflow is a simple-
 *  shaped Test whose workflow:* events the LEGACY harness unwraps — routing it to the
 *  engine would lose that evidence; codex P3 P2). Until then: explicit ids only. */
export function engineRoutesId(id: string): boolean {
  return USE_ENGINE && ENGINE_TESTIDS.has(id);
}

/**
 * Map one engine canonical event to the runner's NDJSON wire event. testId comes
 * from the event's own `id` (not ALS — the engine path runs outside testContext).
 * Status is NOT mapped here: the engine emits no status event; harness.ts
 * synthesizes it from the run RESULT (plan 0005). Phase 0 base set:
 * start / log / assertion / trace. Richer variants (warning / action / metric /
 * step_*) and the full Trace shape (+ derived action + http_duration_ms) land in
 * later sub-slices (Phase 3/4).
 */
export function engineEventToWire(e: ExecutionEvent): Record<string, unknown> {
  switch (e.type) {
    case "start":
      return {
        type: "start",
        id: e.id,
        name: e.name,
        tags: e.tags,
        testId: e.id,
        ...(e.retryCount !== undefined ? { retryCount: e.retryCount } : {}),
      };
    case "log":
      return {
        type: "log",
        message: e.message,
        ...(e.data !== undefined ? { data: e.data } : {}),
        ...(e.stepIndex !== undefined ? { stepIndex: e.stepIndex } : {}),
        testId: e.id,
      };
    case "assertion":
      return {
        type: "assertion",
        passed: e.passed,
        message: e.message,
        actual: e.actual,
        expected: e.expected,
        ...(e.stepIndex !== undefined ? { stepIndex: e.stepIndex } : {}),
        testId: e.id,
      };
    case "warning":
      return {
        type: "warning",
        condition: e.condition,
        message: e.message,
        ...(e.stepIndex !== undefined ? { stepIndex: e.stepIndex } : {}),
        testId: e.id,
      };
    case "metric":
      return {
        type: "metric",
        name: e.name,
        value: e.value,
        unit: e.unit,
        tags: e.tags,
        ...(e.stepIndex !== undefined ? { stepIndex: e.stepIndex } : {}),
        testId: e.id,
      };
    case "action":
      return {
        type: "action",
        data: e.data,
        ...(e.stepIndex !== undefined ? { stepIndex: e.stepIndex } : {}),
        testId: e.id,
      };
    case "event":
      // Generic structured event. The node harness's workflow first-class unwrap
      // (workflowEventToTimeline) is workflow-only → node-legacy; workflow tests are
      // never engine-routed, so the engine path only ever carries generic events.
      return {
        type: "event",
        data: e.data,
        ...(e.stepIndex !== undefined ? { stepIndex: e.stepIndex } : {}),
        testId: e.id,
      };
    case "schema_validation":
      return {
        type: "schema_validation",
        label: e.label,
        success: e.success,
        severity: e.severity,
        ...(e.issues !== undefined ? { issues: e.issues } : {}),
        ...(e.stepIndex !== undefined ? { stepIndex: e.stepIndex } : {}),
        testId: e.id,
      };
    case "branch":
      return {
        type: "branch",
        index: e.index,
        name: e.name,
        takenIndex: e.takenIndex,
        ...(e.takenValue !== undefined ? { takenValue: e.takenValue } : {}),
        ...(e.message !== undefined ? { message: e.message } : {}),
        total: e.total,
        ...(e.error !== undefined ? { error: e.error } : {}),
        testId: e.id,
      };
    case "poll":
      return {
        type: "poll",
        index: e.index,
        name: e.name,
        attempts: e.attempts,
        elapsedMs: e.elapsedMs,
        satisfied: e.satisfied,
        exhausted: e.exhausted,
        ...(e.error !== undefined ? { error: e.error } : {}),
        testId: e.id,
      };
    case "step_start":
      return { type: "step_start", index: e.index, name: e.name, total: e.total, testId: e.id };
    case "step_end":
      return {
        type: "step_end",
        index: e.index,
        name: e.name,
        status: e.status,
        durationMs: e.durationMs,
        assertions: e.assertions,
        failedAssertions: e.failedAssertions,
        ...(e.attempts !== undefined ? { attempts: e.attempts } : {}),
        ...(e.retriesUsed !== undefined ? { retriesUsed: e.retriesUsed } : {}),
        ...(e.error !== undefined ? { error: e.error } : {}),
        ...(e.returnState !== undefined ? { returnState: e.returnState } : {}),
        testId: e.id,
      };
    case "timeout_update":
      // Control event (emitEngineWire bypasses buffering — CONTROL_EVENT_TYPES).
      return { type: "timeout_update", timeout: e.timeout, testId: e.id };
    case "session_set":
      // Legacy shape: a control event (bypasses buffering) carrying ts. ts is
      // wall-clock here (node bridge) and normalized out of parity diffs.
      return { type: "session:set", key: e.key, value: e.value, ts: Date.now(), testId: e.id };
    case "trace":
      // The engine now emits the FULL Trace shape (Phase 4f) — pass it through as the
      // runner wire's { type:"trace", data: Trace }. The derived action +
      // http_duration_ms metric are emitted by the engine as their own events.
      return {
        type: "trace",
        data: e.data,
        ...(e.stepIndex !== undefined ? { stepIndex: e.stepIndex } : {}),
        testId: e.id,
      };
    default:
      // pass-through with testId; richer mappings added per sub-slice
      return { ...(e as Record<string, unknown>), testId: (e as { id: string }).id };
  }
}

export interface EngineCoreOptions {
  vars: Record<string, string>;
  secrets: Record<string, string>;
  /** HTTP trace policy (ExecutorOptions), forwarded to the engine's ky hooks so the
   *  auto-trace capture matches the legacy harness (plan 0005 §D / Phase 4f-3). */
  emitFullTrace?: boolean;
  inferSchema?: boolean;
  truncateArrays?: boolean;
}

/**
 * Build the RunnerCore for the harness subprocess. `sink` writes a wire event to
 * stdout (harness owns the NDJSON write + control-event bypass). Constructing
 * RunnerCore installs the ALS carrier — call this BEFORE setRuntime().
 */
export function createEngineCore(
  sink: (wire: Record<string, unknown>) => void,
  opts: EngineCoreOptions,
): RunnerCore {
  const services: RunnerServices = {
    fetch: (input, init) => globalThis.fetch(input as RequestInfo, init),
    env: { vars: () => opts.vars, secrets: () => opts.secrets },
    events: { emit: (e) => sink(engineEventToWire(e)) },
    scheduler: { now: () => performance.now() },
    carrier: createAlsCarrier(),
    http: {
      emitFullTrace: opts.emitFullTrace,
      inferSchema: opts.inferSchema,
      truncateArrays: opts.truncateArrays,
    },
  };
  return new RunnerCore(services);
}

/** Run one already-resolved SDK Test through the engine (converts to engine TestDef). */
export function runViaEngine(core: RunnerCore, test: Test<unknown>, input: ScopeInput): Promise<TestResult> {
  return core.run(toTestDef(test), input);
}
