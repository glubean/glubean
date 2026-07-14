/**
 * Bounded failure-trace / slow-transaction sampling for the load reducer.
 *
 * The aggregates answer "how bad, where"; the samples answer "show me one". For each
 * in-flight iteration the collector buffers a CAPPED list of observations (requests +
 * failed assertions) plus its slowest step and a bounded top-k of busiest endpoints. At
 * iteration:end:
 *  - a FAILED iteration keeps a `LoadFailureTraceSample` (its observations + the failed
 *    step), up to `maxFailureTraces` (the first N — the onset is the useful part);
 *  - a SUCCESSFUL one competes for the top `maxSlowTransactionSummaries` slowest, kept as
 *    a `LoadSlowTransactionSummary` (no full trace, just its slowest step + top endpoints).
 *
 * Memory is bounded: per in-flight iteration the observation buffer AND the endpoint top-k
 * are capped, the in-flight count is bounded by concurrency, and the kept-sample counts are
 * capped. The caps come from the plan's `report` config (0 disables a sample type entirely —
 * then nothing is even buffered for it).
 *
 * Retention is DETERMINISTIC, under total orders a distributed merge can share: the slow
 * top-k competes on `compareSlow` (durationMs desc, workerId asc, iterationId asc — identity
 * tie-break, no wall-clock key); failure traces keep the FIRST N under `compareFailure`
 * (completedAtOffsetMs asc, workerId asc, iterationId asc). Both comparators are exported so
 * the coordinator's merge re-sorts by the exact same order — a merge of per-worker bounded
 * samples is only EXACT if every worker retained under the order the center sorts by.
 */
import type {
  LoadArtifactSamples,
  LoadErrorKind,
  LoadFailureObservation,
  LoadFailureTraceSample,
  LoadSampleIdentity,
  LoadSlowTransactionSummary,
} from "@glubean/sdk/load";

const DEFAULT_MAX_FAILURE_TRACES = 20;
const DEFAULT_MAX_SLOW = 20;
const MAX_OBS_PER_TRACE = 40;
const TOP_ENDPOINTS = 3;
// Memory backstop on CONCURRENTLY-buffered iterations (each holds a bounded obs/endpoint
// buffer until iteration:end). Normal runs stay far below this — in-flight is bounded by
// concurrency + continuation limits. It only bites the pathological `releaseProducerSlot` +
// unbounded-continuation case with slow/hung tails, where in-flight iterations would otherwise
// grow without bound; there, excess iterations are simply not sampled.
const MAX_ACTIVE_BUFFERS = 4096;
const MAX_PREVIEW_CHARS = 512;
const MAX_PREVIEW_DEPTH = 6;
const PREVIEW_NODE_BUDGET = 512; // hard cap on nodes visited — bounds CPU/memory for huge payloads

const truncateStr = (s: string): string => (s.length > MAX_PREVIEW_CHARS ? `${s.slice(0, MAX_PREVIEW_CHARS)}…` : s);

/** Deep-truncate `v` into a bounded, JSON-safe structure WITHOUT walking the whole input: a
 *  shared node budget caps total work, arrays/objects stop early when it's exhausted, depth
 *  is capped, strings are truncated, and BigInt / symbol / function become strings. This runs
 *  BEFORE serialization, so a huge response body can't make JSON.stringify allocate the whole
 *  value first (codex). */
function boundStructure(v: unknown, depth: number, budget: { n: number }): unknown {
  if (budget.n <= 0) return "…";
  budget.n -= 1;
  if (typeof v === "string") return truncateStr(v);
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v); // NaN / ±Infinity → JSON null
  if (typeof v === "boolean" || v === null) return v;
  if (typeof v === "bigint") return truncateStr(`${v}n`);
  if (typeof v !== "object") return truncateStr(String(v)); // symbol / function — length-capped
  if (depth >= MAX_PREVIEW_DEPTH) return Array.isArray(v) ? "[…]" : "{…}";
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (let i = 0; i < v.length && budget.n > 0; i++) out.push(boundStructure(v[i], depth + 1, budget));
    if (v.length > out.length) out.push(`…+${v.length - out.length} more`);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const k in v) {
    if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
    if (budget.n <= 0) {
      out["…"] = "…";
      break;
    }
    out[k] = boundStructure((v as Record<string, unknown>)[k], depth + 1, budget);
  }
  return out;
}

/** Bound a captured assertion value for the trace so a single retained failure sample can't
 *  carry an unbounded payload AND so the preview is JSON-safe — the artifact is later
 *  `JSON.stringify`d, which throws on a BigInt. Primitives pass through (long strings
 *  truncated; BigInt / symbol / function → string); a structured value is deep-truncated to a
 *  bounded structure, then serialized to a length-capped JSON string (a debugging PREVIEW). */
function previewValue(v: unknown): unknown {
  if (typeof v === "string") return truncateStr(v);
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v); // NaN / ±Infinity → JSON null
  if (typeof v === "boolean" || v === null) return v;
  if (typeof v === "bigint") return truncateStr(`${v}n`);
  if (typeof v !== "object") return truncateStr(String(v)); // symbol / function — length-capped
  let s: string | undefined;
  try {
    s = JSON.stringify(boundStructure(v, 0, { n: PREVIEW_NODE_BUDGET }));
  } catch {
    return "[unserializable]"; // a throwing getter / toJSON on the bounded structure
  }
  return truncateStr(s === undefined ? String(v) : s);
}

/** The failure cause worth keeping over a successful request when the trace buffer is full:
 *  a failed assertion (only failures are recorded) or a failed/errored request. */
function isHighValue(o: LoadFailureObservation): boolean {
  return o.type === "assertion" || (o.type === "request" && !o.ok);
}

/** Shared identity tie-break: workerId asc, then iterationId asc. An absent workerId
 *  (single-process runs — `iterationId` is already unique there) sorts before any present id;
 *  ids compare as plain strings (UTF-16 order, deliberately not locale-sensitive), so a
 *  distributed worker's `w0` / `it-N` keys need no special casing. */
function compareIdentity(a: LoadSampleIdentity, b: LoadSampleIdentity): number {
  const wa = a.workerId ?? "";
  const wb = b.workerId ?? "";
  if (wa !== wb) return wa < wb ? -1 : 1;
  return a.iterationId < b.iterationId ? -1 : a.iterationId > b.iterationId ? 1 : 0;
}

/** Total order for slow top-k retention: durationMs DESC, then the identity tie-break —
 *  no wall-clock key. Local retention and the coordinator's top-k merge over per-worker
 *  samples must share ONE total order for the merged top-k to be exact (exported for that
 *  merge), so equal-duration eviction is decided here, deterministically, not by arrival
 *  order. Negative ⇒ `a` ranks ahead of (outlives) `b`. */
export function compareSlow(a: LoadSlowTransactionSummary, b: LoadSlowTransactionSummary): number {
  if (a.durationMs !== b.durationMs) return b.durationMs - a.durationMs;
  return compareIdentity(a.identity, b.identity);
}

/** Total order for failure-trace retention: completedAtOffsetMs ASC (the onset failures are
 *  the useful ones), then the identity tie-break. A missing completedAtOffsetMs (an event
 *  path that predates the field) ranks +∞ — it never displaces a stamped sample, matching
 *  the old "late arrivals don't get in" behavior. Exported for the coordinator merge, which
 *  re-sorts the union of worker samples by this order and keeps the first N. */
export function compareFailure(a: LoadFailureTraceSample, b: LoadFailureTraceSample): number {
  const ta = a.completedAtOffsetMs ?? Number.POSITIVE_INFINITY;
  const tb = b.completedAtOffsetMs ?? Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta - tb;
  return compareIdentity(a.identity, b.identity);
}

type Phase = "primary" | "continuation";
type EndpointSample = { routeKey: string; phase?: Phase; durationMs: number; status?: number };

interface IterBuffer {
  scenarioId: string;
  scenarioRefId?: string;
  producerSlotId: string;
  feederKeys?: Record<string, string>; // data-row attribution (feeder name → drawn key)
  observations: LoadFailureObservation[];
  droppedObservations: number;
  slowestStep?: { stepId: string; stepName: string; durationMs: number };
  failedStep?: { stepId: string; stepName: string };
  endpoints: EndpointSample[]; // bounded top-k by durationMs (desc)
}

export class LoadSampleCollector {
  private readonly maxFailureTraces: number;
  private readonly maxSlow: number;
  private readonly workerId?: string;
  private readonly buffers = new Map<string, IterBuffer>();
  // Failed iterations, kept sorted by `compareFailure` (first `maxFailureTraces`, earliest first).
  private readonly failureTraces: LoadFailureTraceSample[] = [];
  // Slowest successful transactions, kept sorted by `compareSlow` (top `maxSlow`, slowest first).
  private readonly slow: LoadSlowTransactionSummary[] = [];

  /** `report` caps (0 disables a sample type entirely; undefined → the default). `workerId` is
   *  this collector's shard identity in a distributed run — stamped into every sample identity
   *  so merged samples stay unique and totally ordered across workers. Single-process runs
   *  leave it unset; the distributed shard runner (D1) wires its `shard.workerId` here. Do NOT
   *  wire the event `runnerId` instead: that's the PLAN's identity, identical on every worker
   *  of a distributed run, so it can't disambiguate anything. */
  constructor(caps: { maxFailureTraces?: number; maxSlowTransactionSummaries?: number; workerId?: string } = {}) {
    this.maxFailureTraces = caps.maxFailureTraces ?? DEFAULT_MAX_FAILURE_TRACES;
    this.maxSlow = caps.maxSlowTransactionSummaries ?? DEFAULT_MAX_SLOW;
    if (caps.workerId !== undefined) this.workerId = caps.workerId;
  }

  /** Whether any per-iteration buffering is needed at all. */
  private get tracking(): boolean {
    return this.maxFailureTraces > 0 || this.maxSlow > 0;
  }

  beginIteration(
    iterationId: string,
    info: { scenarioId: string; scenarioRefId?: string; producerSlotId: string; feederKeys?: Record<string, string> },
  ): void {
    if (!this.tracking) return; // both sample types disabled — buffer nothing
    if (this.buffers.size >= MAX_ACTIVE_BUFFERS) return; // memory backstop (see the const)
    this.buffers.set(iterationId, {
      scenarioId: info.scenarioId,
      ...(info.scenarioRefId !== undefined ? { scenarioRefId: info.scenarioRefId } : {}),
      producerSlotId: info.producerSlotId,
      ...(info.feederKeys !== undefined ? { feederKeys: info.feederKeys } : {}),
      observations: [],
      droppedObservations: 0,
      endpoints: [],
    });
  }

  recordRequest(
    iterationId: string,
    r: {
      tsOffsetMs: number;
      stepId?: string;
      stepName?: string;
      phase?: Phase;
      method: string;
      routeKey: string;
      status?: number;
      ok: boolean;
      durationMs: number;
      errorKind?: LoadErrorKind;
    },
  ): void {
    const b = this.buffers.get(iterationId);
    if (b === undefined) return;
    if (this.maxFailureTraces > 0) {
      this.pushObservation(b, {
        type: "request",
        tsOffsetMs: r.tsOffsetMs,
        ...(r.stepId !== undefined ? { stepId: r.stepId } : {}),
        ...(r.stepName !== undefined ? { stepName: r.stepName } : {}),
        ...(r.phase !== undefined ? { phase: r.phase } : {}),
        method: r.method,
        routeKey: r.routeKey,
        ...(r.status !== undefined ? { status: r.status } : {}),
        ok: r.ok,
        durationMs: r.durationMs,
        ...(r.errorKind !== undefined ? { errorKind: r.errorKind } : {}),
      });
    }
    if (this.maxSlow > 0) {
      this.offerEndpoint(b, {
        routeKey: r.routeKey,
        ...(r.phase !== undefined ? { phase: r.phase } : {}),
        durationMs: r.durationMs,
        ...(r.status !== undefined ? { status: r.status } : {}),
      });
    }
  }

  recordAssertionFailure(
    iterationId: string,
    a: {
      tsOffsetMs: number;
      stepId?: string;
      stepName?: string;
      phase?: Phase;
      message?: string;
      // Presence flags (not value !== undefined) so a deliberately-`undefined` operand
      // (e.g. `expect(undefined).toBe(1)`) is retained as a diagnostic, not dropped (codex).
      actual?: unknown;
      hasActual?: boolean;
      expected?: unknown;
      hasExpected?: boolean;
    },
  ): void {
    const b = this.buffers.get(iterationId);
    if (b === undefined || this.maxFailureTraces === 0) return;
    // The caller may pass an explicit presence flag (to retain an `undefined` operand) or rely
    // on the value being defined.
    const hasActual = a.hasActual ?? a.actual !== undefined;
    const hasExpected = a.hasExpected ?? a.expected !== undefined;
    this.pushObservation(b, {
      type: "assertion",
      tsOffsetMs: a.tsOffsetMs,
      ...(a.stepId !== undefined ? { stepId: a.stepId } : {}),
      ...(a.stepName !== undefined ? { stepName: a.stepName } : {}),
      ...(a.phase !== undefined ? { phase: a.phase } : {}),
      passed: false,
      ...(a.message !== undefined ? { message: a.message } : {}),
      ...(hasActual ? { actualPreview: previewValue(a.actual) } : {}),
      ...(hasExpected ? { expectedPreview: previewValue(a.expected) } : {}),
    });
  }

  recordStep(
    iterationId: string,
    s: { stepId: string; stepName: string; durationMs: number; ok: boolean; skipped: boolean },
  ): void {
    const b = this.buffers.get(iterationId);
    if (b === undefined || s.skipped) return;
    if (this.maxSlow > 0 && (b.slowestStep === undefined || s.durationMs > b.slowestStep.durationMs)) {
      b.slowestStep = { stepId: s.stepId, stepName: s.stepName, durationMs: s.durationMs };
    }
    if (this.maxFailureTraces > 0 && !s.ok && b.failedStep === undefined) {
      b.failedStep = { stepId: s.stepId, stepName: s.stepName };
    }
  }

  /** `completedAtOffsetMs` = the iteration:end offset from run start (the caller's event clock —
   *  same basis as observation `tsOffsetMs`). Optional so older event paths still work. */
  endIteration(
    iterationId: string,
    end: { ok: boolean; durationMs: number; errorKind?: LoadErrorKind; completedAtOffsetMs?: number },
  ): void {
    const b = this.buffers.get(iterationId);
    if (b === undefined) return;
    this.buffers.delete(iterationId);
    const identity = this.identityOf(iterationId, b);
    if (!end.ok) {
      this.offerFailure({
        identity,
        ...(end.completedAtOffsetMs !== undefined ? { completedAtOffsetMs: end.completedAtOffsetMs } : {}),
        durationMs: end.durationMs,
        ...(end.errorKind !== undefined ? { errorKind: end.errorKind } : {}),
        ...(b.failedStep !== undefined ? { failedStepId: b.failedStep.stepId, failedStepName: b.failedStep.stepName } : {}),
        observations: b.observations,
        truncated: b.droppedObservations > 0,
        droppedObservationCount: b.droppedObservations,
      });
    } else if (this.maxSlow > 0) {
      this.offerSlow({
        identity,
        ...(end.completedAtOffsetMs !== undefined ? { completedAtOffsetMs: end.completedAtOffsetMs } : {}),
        durationMs: end.durationMs,
        ...(b.slowestStep !== undefined ? { slowStepId: b.slowestStep.stepId, slowStepName: b.slowestStep.stepName } : {}),
        topEndpoints: b.endpoints, // already a bounded top-k, sorted desc
        truncated: false,
      });
    }
  }

  finalize(): LoadArtifactSamples {
    return {
      maxFailureTraces: this.maxFailureTraces,
      maxSlowTransactionSummaries: this.maxSlow,
      failureTraces: this.failureTraces,
      slowTransactions: this.slow,
    };
  }

  private pushObservation(b: IterBuffer, obs: LoadFailureObservation): void {
    if (b.observations.length < MAX_OBS_PER_TRACE) {
      b.observations.push(obs);
      return;
    }
    // Full. The exact failure cause — a failed assertion OR a failed request (500 / timeout) —
    // must never be dropped just because a chatty/polling iteration filled the buffer with
    // successful requests first. A LOW-value overflow (a successful request) is dropped; a
    // HIGH-value one evicts the oldest LOW-value observation (or the oldest, if all are
    // high-value, keeping the most recent) to make room.
    if (!isHighValue(obs)) {
      b.droppedObservations += 1;
      return;
    }
    const lowIdx = b.observations.findIndex((o) => !isHighValue(o));
    b.observations.splice(lowIdx >= 0 ? lowIdx : 0, 1);
    b.droppedObservations += 1;
    b.observations.push(obs);
  }

  /** Keep only the TOP_ENDPOINTS slowest endpoints seen this iteration (sorted desc). */
  private offerEndpoint(b: IterBuffer, ep: EndpointSample): void {
    if (b.endpoints.length < TOP_ENDPOINTS) {
      b.endpoints.push(ep);
      b.endpoints.sort((x, y) => y.durationMs - x.durationMs);
      return;
    }
    if (ep.durationMs <= b.endpoints[b.endpoints.length - 1].durationMs) return;
    b.endpoints[b.endpoints.length - 1] = ep;
    b.endpoints.sort((x, y) => y.durationMs - x.durationMs);
  }

  private identityOf(iterationId: string, b: IterBuffer): LoadSampleIdentity {
    return {
      scenarioId: b.scenarioId,
      ...(b.scenarioRefId !== undefined ? { scenarioRefId: b.scenarioRefId } : {}),
      producerSlotId: b.producerSlotId,
      iterationId,
      ...(this.workerId !== undefined ? { workerId: this.workerId } : {}), // shard identity (see ctor)
      // Data-row attribution: which feeder key produced this sample (strategy isn't known here).
      ...(b.feederKeys !== undefined && Object.keys(b.feederKeys).length > 0
        ? { feeders: Object.fromEntries(Object.entries(b.feederKeys).map(([name, key]) => [name, { key }])) }
        : {}),
    };
  }

  /** Keep this failure iff it's among the FIRST `maxFailureTraces` under `compareFailure`
   *  (completion order — the onset is the useful part). Single-process, arrival order here
   *  already IS completion order (the reducer feeds monotone offsets), so vs. the old
   *  "first N to arrive" rule the only observable difference is that a same-millisecond tie
   *  is now decided by the identity tie-break, not by arrival. Eviction mirrors `offerSlow`:
   *  the last-ranked of {kept ∪ candidate} is the one out. */
  private offerFailure(f: LoadFailureTraceSample): void {
    if (this.maxFailureTraces <= 0) return; // disabled (a buffer can still exist for the slow type)
    if (this.failureTraces.length < this.maxFailureTraces) {
      this.failureTraces.push(f);
      this.failureTraces.sort(compareFailure);
      return;
    }
    if (compareFailure(f, this.failureTraces[this.failureTraces.length - 1]) >= 0) return; // candidate ranks last — it's out
    this.failureTraces[this.failureTraces.length - 1] = f;
    this.failureTraces.sort(compareFailure);
  }

  /** Keep this transaction iff it's among the top `maxSlow` under the `compareSlow` total
   *  order. Eviction is deterministic even on equal durations: the last-ranked of
   *  {kept ∪ candidate} — the array's tail after sorting — is the one out, regardless of
   *  arrival order. */
  private offerSlow(s: LoadSlowTransactionSummary): void {
    if (this.slow.length < this.maxSlow) {
      this.slow.push(s);
      this.slow.sort(compareSlow);
      return;
    }
    if (compareSlow(s, this.slow[this.slow.length - 1]) >= 0) return; // candidate ranks last — it's out
    this.slow[this.slow.length - 1] = s;
    this.slow.sort(compareSlow);
  }
}
