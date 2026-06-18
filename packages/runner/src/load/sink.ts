/**
 * LoadSink — translates the engine's per-run wire events into the load
 * `LoadEvent` fact stream and feeds the `LoadReducer`.
 *
 * One sink + one engine core serve every concurrent iteration: each iteration
 * runs an engine TestDef whose `meta.id` is the unique iterationId, so wire
 * events arrive tagged with `testId = iterationId` and the sink demuxes them
 * back to the right iteration's attribution (no per-iteration core needed).
 *
 * Success requests feed only the reducer's aggregates; the sink stays bounded
 * (per-iteration step-name maps are dropped at iteration end). Failure-trace
 * sampling and producer-release events land in later milestones.
 */
import type { LoadErrorKind, LoadEvent, LoadReducer } from "@glubean/sdk/load";
import { resolveRouteKey } from "./route-key.js";

/** Per-iteration attribution the sink stamps onto translated events. */
export interface LoadIterationEnvelope {
  scenarioId: string;
  scenarioRefId?: string;
  producerSlotId: string;
  iterationId: string;
}

/** Distributive Omit — applied per union member so each LoadEvent variant keeps
 *  its own discriminant-specific fields (a plain Omit over the union would keep
 *  only the common envelope keys). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type LoadEventBody = DistributiveOmit<LoadEvent, "ts" | "seq" | "runId" | "runnerId">;

interface TraceData {
  protocol?: string;
  method?: string;
  url?: string;
  status?: number;
  durationMs?: number;
  ok?: boolean;
  target?: string;
}

export class LoadSink {
  private seq = 0;
  private readonly envelopes = new Map<string, LoadIterationEnvelope>();
  private readonly stepNames = new Map<string, Map<number, string>>();

  constructor(
    private readonly reducer: LoadReducer,
    private readonly runId: string,
    private readonly runnerId: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Stamp envelope basics (ts / seq / runId / runnerId) and apply to the reducer. */
  emit(body: LoadEventBody): void {
    this.reducer.apply({
      ts: this.now(),
      seq: this.seq++,
      runId: this.runId,
      runnerId: this.runnerId,
      ...body,
    } as LoadEvent);
  }

  /** Register an iteration's attribution before its engine run starts. */
  beginIteration(env: LoadIterationEnvelope): void {
    this.envelopes.set(env.iterationId, env);
    this.stepNames.set(env.iterationId, new Map());
  }

  /** Drop an iteration's per-iteration buffers once it has finished. */
  endIteration(iterationId: string): void {
    this.envelopes.delete(iterationId);
    this.stepNames.delete(iterationId);
  }

  /** The shared per-iteration attribution every translated event carries. Phase is
   *  always "primary" until the primaryComplete boundary lands (M5). */
  private baseOf(env: LoadIterationEnvelope) {
    return {
      scenarioId: env.scenarioId,
      ...(env.scenarioRefId !== undefined ? { scenarioRefId: env.scenarioRefId } : {}),
      producerSlotId: env.producerSlotId,
      iterationId: env.iterationId,
      phase: "primary" as const,
    };
  }

  /** Emit `iteration:start` (the executor calls this right after beginIteration). */
  emitIterationStart(
    env: LoadIterationEnvelope,
    opts: { inputKey?: string; feederKeys?: Record<string, string> } = {},
  ): void {
    this.emit({
      type: "iteration:start",
      ...this.baseOf(env),
      ...(opts.inputKey !== undefined ? { inputKey: opts.inputKey } : {}),
      ...(opts.feederKeys !== undefined ? { feederKeys: opts.feederKeys } : {}),
    });
  }

  /** Emit `iteration:end` (the executor calls this once the engine run resolves). */
  emitIterationEnd(
    env: LoadIterationEnvelope,
    result: { ok: boolean; durationMs: number; errorKind?: LoadErrorKind },
  ): void {
    this.emit({
      type: "iteration:end",
      ...this.baseOf(env),
      ok: result.ok,
      durationMs: result.durationMs,
      ...(result.errorKind !== undefined ? { errorKind: result.errorKind } : {}),
    });
  }

  /** A per-scenario-stable, leaf-unique step id. The engine's leaf `index` is
   *  assigned in deterministic registry order (taken or skipped), so the same
   *  logical step always gets the same index — folding it in disambiguates two
   *  leaves that share a display name (the reducer keys aggregates by stepId). */
  private stepIdOf(index: number, name: string): string {
    return `${index}:${name}`;
  }

  /** Emit `report:checkpoint` (backs `ctx.report.checkpoint`). */
  emitCheckpoint(env: LoadIterationEnvelope, checkpointId: string, data?: Record<string, unknown>): void {
    this.emit({
      type: "report:checkpoint",
      ...this.baseOf(env),
      checkpointId,
      ...(data !== undefined ? { data } : {}),
    });
  }

  /** The engine-core sink callback: translate one wire event to LoadEvent(s). */
  readonly handleWire = (wire: Record<string, unknown>): void => {
    const iterationId = wire.testId as string | undefined;
    if (!iterationId) return;
    const env = this.envelopes.get(iterationId);
    if (!env) return; // not a tracked load iteration
    const base = this.baseOf(env);

    switch (wire.type) {
      case "step_start": {
        const index = wire.index as number;
        const name = wire.name as string;
        const group = wire.group as string | undefined;
        this.stepNames.get(iterationId)?.set(index, name);
        this.emit({
          type: "step:start",
          ...base,
          stepId: this.stepIdOf(index, name),
          stepName: name,
          ...(group !== undefined ? { groupId: group } : {}),
        });
        break;
      }
      case "step_end": {
        const index = wire.index as number;
        const name = wire.name as string;
        const status = wire.status as string;
        const group = wire.group as string | undefined;
        this.emit({
          type: "step:end",
          ...base,
          stepId: this.stepIdOf(index, name),
          stepName: name,
          ok: status === "passed",
          durationMs: (wire.durationMs as number) ?? 0,
          ...(status === "skipped" ? { skipped: true } : {}),
          assertionFailures: (wire.failedAssertions as number) ?? 0,
          ...(wire.error !== undefined ? { errorKind: "stepError" as const } : {}),
          // Carries group for SKIPPED leaves (no step:start emitted for them).
          ...(group !== undefined ? { groupId: group } : {}),
        });
        break;
      }
      case "trace": {
        const t = (wire.data ?? {}) as TraceData;
        const stepIndex = wire.stepIndex as number | undefined;
        const stepName = stepIndex !== undefined ? this.stepNames.get(iterationId)?.get(stepIndex) : undefined;
        // Resolve method + heuristic routeKey together (id-like path segments →
        // ":id", M3-e). The method is recovered from the trace `target` when the
        // explicit `method` is absent, so a target-only POST/PUT isn't mislabelled
        // GET. Explicit routeKeys / a contract catalog land in M8.
        const { method, routeKey } = resolveRouteKey(t.method, t.url, t.target, t.protocol);
        this.emit({
          type: "request:observed",
          ...base,
          ...(stepName !== undefined ? { stepId: this.stepIdOf(stepIndex!, stepName) } : {}),
          method,
          url: t.url ?? "",
          routeKey,
          routeKeySource: "normalized-url",
          routeKeyHeuristic: true,
          ...(t.status !== undefined ? { status: t.status } : {}),
          ok: t.ok ?? false,
          durationMs: t.durationMs ?? 0,
        });
        break;
      }
      case "assertion": {
        const stepIndex = wire.stepIndex as number | undefined;
        const stepName = stepIndex !== undefined ? this.stepNames.get(iterationId)?.get(stepIndex) : undefined;
        this.emit({
          type: "assertion:observed",
          ...base,
          ...(stepName !== undefined ? { stepId: this.stepIdOf(stepIndex!, stepName) } : {}),
          passed: wire.passed as boolean,
          ...(wire.message !== undefined ? { message: wire.message as string } : {}),
        });
        break;
      }
      // log / metric / action / event / warning / schema / branch / poll / start /
      // status / timeout: not part of the M3 closed-model aggregates.
      default:
        break;
    }
  };
}
