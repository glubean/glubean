/**
 * Multi-core load control protocol — the versioned, bidirectional inner protocol a
 * coordinator (parent) and a worker (forked child) speak over the DEDICATED control
 * channel (proposal §4). It is transport-agnostic: multi-core carries it over the fork
 * IPC channel, and the future `remote` provider (D2) reuses these exact message shapes
 * over WebSocket+TLS — only the transport differs (§4: "内层协议共享,只换传输层"). Every
 * message is therefore a plain, JSON-round-trippable object (no `Map`/`Set`/functions):
 * Node fork IPC serializes with JSON by default, and a remote transport will too.
 *
 * Isolation (hard requirement, §6 decision 6 / §12): control frames travel on this
 * channel ONLY. User `console.log` / `stderr` go to the child's stdout/stderr, which the
 * parent forwards verbatim as ordinary output — user code can neither read nor forge a
 * control frame, because it has no handle on the IPC channel. (Contrast the single-file
 * `subprocess.ts`, which multiplexes protocol onto stdout behind `WIRE_PREFIX`; §6 rules
 * that insufficient for D1.)
 *
 * Trust model (COOPERATIVE — read before extending `decode*`): the peer on the other end
 * is a same-version glubean process we spawned (multi-core) or an enrolled, token-bound
 * agent (remote), NOT an adversary. `decode*` validates the version envelope and the
 * STRUCTURE of each message (right `type`, required fields present and of the right kind)
 * so a protocol-version skew or a drifted/garbled frame fails loudly and early — it does
 * NOT do byzantine/deep semantic validation (e.g. it trusts the `partial`'s internal
 * shape to `parseLoadReducerPartial` at the point of use, and trusts numeric fields to be
 * sane). Version incompatibility is rejected BEFORE any `assign` is sent (§4), so a
 * mismatched worker never receives secrets or does work.
 */
import type { LoadReducerPartialV1 } from "../partial.js";
import type { LoadShard } from "../shard.js";
import type { LoadEndReason } from "@glubean/sdk/load";

/** The wire protocol version. Bumped on any INCOMPATIBLE message-shape change; a peer that
 *  announces (or stamps) a different version is rejected before `assign` (§4). */
export const MULTICORE_PROTOCOL_VERSION = 1;

// ── Payload sub-shapes ───────────────────────────────────────────────────────

/**
 * The orchestration observables a shard hands back beyond its streamed reducer state —
 * the SCALAR facts of {@link import("../orchestrator.js").RunLoadShardResult} that do NOT
 * live in the cumulative `LoadReducerPartialV1`, so they must ride the wire explicitly for
 * a coordinator to finalize exactly as the single-machine `runLoad` shell does from the
 * return value (D1-2 flagged this return-value bypass as needing a wire carrier; this is
 * it). The live `reducer` is NOT here — its complete state crosses the wire as the
 * terminal `snapshot` frame (`final: true`); a coordinator hydrates from that.
 */
export interface ShardResultObservablesV1 {
  /** Why this shard's dispatch ended (§7.4). */
  endReason: LoadEndReason;
  /** The `now()` captured at finalization — the run-end denominator a coordinator passes to
   *  `finalizeMerged`, and the terminal frame's `observedAt`. */
  finalizeNow: number;
  /** The deprecated `random` override actually drove a mix selection → not seed-replayable
   *  (a coordinator drops the recorded `rngSeed`). Always false for a distributed run. */
  mixOverrideUsed: boolean;
  /** Peak concurrent continuation tails this worker saw (incl. deadline-released ones the
   *  reducer's `maxBacklog` cannot see). */
  peakContinuations: number;
  /** Continuations the drain timeout abandoned (still in flight at finalize). */
  abortedByDrainTimeout: number;
  /** Some iteration ran an unreleased tail poll (the advisory condition). */
  unreleasedTailPollRan: boolean;
  /** Largest overshoot (ms) of a slot's absolute ramp target `startAt + rampDelay` (§5.1). */
  maxStartLatenessMs: number;
}

/**
 * Everything a worker needs to BIND to its slice of the run and prepare to dispatch
 * (proposal §5.1 `RunLoadShardOptions`, minus the runtime start timing which arrives in
 * the later `start` frame). Sent once, after `hello`, before `start`.
 */
export interface ShardAssignmentV1 {
  /** Absolute path to the user `.load.ts` the worker imports (the plan LOCATOR). */
  file: string;
  /** Which `LoadPlan` exported by that file this worker runs (its `plan.id`). */
  planId: string;
  /** This worker's static slice of the run (from `shardPlan`). Its `workerId` MUST equal the
   *  id the coordinator minted for this worker at fork (echoed in `hello`). */
  shard: LoadShard;
  /** Root seed for the run's counter-keyed RNG streams (§6.5) — IDENTICAL on every shard. */
  rngSeed: string;
  /** Resolved environment vars for the engine core (ctx.vars). */
  vars: Record<string, string>;
  /** Resolved secrets for the engine core (ctx.secrets). */
  secrets: Record<string, string>;
  /** Base session each iteration copies. JSON-safe by construction (it crossed the wire). */
  baseSession?: Record<string, unknown>;
  /** Shared run-axis origin (epoch ms) every emitted offset is computed against — the
   *  coordinator's authoritative `t0`, identical on every shard so their frames merge. A
   *  coordinator that gates dispatch on the two-phase `ready` barrier (§10.5) sends a
   *  PROVISIONAL value here and COMMITS the real axis in the later `start` frame's
   *  `timelineOrigin` (which the worker prefers) — so the axis equals `startAt` even though
   *  `assign` is sent before every worker has bound. A driver that does not use the barrier
   *  (e.g. a manual test) may set the committed value here and omit it from `start`. */
  timelineOrigin: number;
  /** Periodic snapshot cadence (ms); omitted → the kernel default (15s). Injectable so a
   *  test need not wait 15s for a frame. */
  snapshotIntervalMs?: number;
}

// ── Coordinator → worker ─────────────────────────────────────────────────────

/**
 * A frame the coordinator (parent) sends the worker. `assign` binds the shard; `start`
 * releases dispatch at an absolute `startAt` instant (the time-based start barrier, §5.1 —
 * every worker holds until this shared instant, so a late `start` does not desync the run)
 * and may COMMIT the shared `timelineOrigin` (overriding the provisional one in `assign`, so
 * the run axis equals `startAt` even when `assign` preceded every worker's bind); `abort`
 * requests a clean early wind-down; `heartbeat` is the coordinator-liveness keep-alive
 * (§10.5 lease) that also doubles as a channel probe. (The `assign` → `ready` → `start`
 * sequence is the multi-core minimal form of §10.5's armed→commit barrier — D1-4.)
 */
export type CoordinatorMessage =
  | { type: "assign"; assignment: ShardAssignmentV1 }
  | { type: "start"; startAt: number; dispatchDeadline?: number; timelineOrigin?: number }
  | { type: "abort"; reason: string }
  | { type: "heartbeat"; ts?: number };

// ── Worker → coordinator ─────────────────────────────────────────────────────

/**
 * A frame the worker (child) sends the coordinator. `hello` announces readiness + the
 * protocol version the coordinator checks BEFORE assigning (§4); `ready` acknowledges that
 * `assign` was BOUND (the user file imported + the plan selected) so the coordinator can pick
 * a shared `startAt` in every worker's future (the multi-core armed→commit barrier, §10.5);
 * `snapshot` streams the cumulative reducer state (periodic `final:false`, then one
 * authoritative `final:true` at run end — the frame a coordinator merges); `result` carries
 * the scalar orchestration observables; `error` reports a per-assignment failure; `done` is
 * the terminal sentinel (its absence at channel close means the worker died mid-run).
 * `progress` is a reserved, lightweight cumulative-counter frame (§4 "progress 可选") —
 * defined for wire completeness; the D1-3 worker relies on `snapshot` for live progress and
 * does not emit it.
 */
export type WorkerMessage =
  | { type: "hello"; protocolVersion: number; workerId: string; pid: number }
  | { type: "ready"; workerId: string }
  | {
      type: "progress";
      workerId: string;
      observedAt: number;
      iterationsStarted: number;
      iterationsCompleted: number;
    }
  | { type: "snapshot"; workerId: string; final: boolean; partial: LoadReducerPartialV1 }
  | { type: "result"; workerId: string; observables: ShardResultObservablesV1 }
  | { type: "error"; workerId?: string; message: string; stack?: string }
  | { type: "done"; workerId: string };

// ── Encode / decode ──────────────────────────────────────────────────────────

/** Raised when a frame cannot be decoded: an incompatible protocol version, or a
 *  structurally invalid message (cooperative-trust structural check — see file header). */
export class MulticoreProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MulticoreProtocolError";
  }
}

/** The version envelope wrapping every wire frame. */
interface Envelope {
  v: number;
}

/** Stamp the version envelope onto a coordinator frame for the wire. */
export function encodeCoordinatorMessage(msg: CoordinatorMessage): Envelope & CoordinatorMessage {
  return { v: MULTICORE_PROTOCOL_VERSION, ...msg };
}

/** Stamp the version envelope onto a worker frame for the wire. */
export function encodeWorkerMessage(msg: WorkerMessage): Envelope & WorkerMessage {
  return { v: MULTICORE_PROTOCOL_VERSION, ...msg };
}

function asRecord(raw: unknown, side: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) {
    throw new MulticoreProtocolError(`${side}: frame is not an object (got ${raw === null ? "null" : typeof raw})`);
  }
  return raw as Record<string, unknown>;
}

/** Validate the version envelope shared by both directions. Version mismatch is the
 *  incompatibility the coordinator acts on BEFORE `assign` (§4). */
function checkEnvelope(o: Record<string, unknown>, side: string): void {
  if (o.v !== MULTICORE_PROTOCOL_VERSION) {
    throw new MulticoreProtocolError(
      `${side}: incompatible protocol version ${JSON.stringify(o.v)} (this build speaks ${MULTICORE_PROTOCOL_VERSION})`,
    );
  }
}

function reqString(o: Record<string, unknown>, field: string, side: string): string {
  const v = o[field];
  if (typeof v !== "string") throw new MulticoreProtocolError(`${side}: '${field}' must be a string`);
  return v;
}

function reqNumber(o: Record<string, unknown>, field: string, side: string): number {
  const v = o[field];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new MulticoreProtocolError(`${side}: '${field}' must be a finite number`);
  }
  return v;
}

function reqObject(o: Record<string, unknown>, field: string, side: string): Record<string, unknown> {
  const v = o[field];
  if (typeof v !== "object" || v === null) throw new MulticoreProtocolError(`${side}: '${field}' must be an object`);
  return v as Record<string, unknown>;
}

function reqBool(o: Record<string, unknown>, field: string, side: string): boolean {
  const v = o[field];
  if (typeof v !== "boolean") throw new MulticoreProtocolError(`${side}: '${field}' must be a boolean`);
  return v;
}

/**
 * Decode + validate a frame the coordinator received FROM a worker. Structural (not
 * byzantine) validation per the cooperative trust model — enough that a version skew or a
 * drifted frame fails loudly at the boundary. The `partial` inside a `snapshot` is passed
 * through and validated deeply by `parseLoadReducerPartial` where it is consumed (merge).
 */
export function decodeWorkerMessage(raw: unknown): WorkerMessage {
  const side = "worker→coordinator";
  const o = asRecord(raw, side);
  checkEnvelope(o, side);
  const type = o.type;
  switch (type) {
    case "hello":
      return {
        type: "hello",
        protocolVersion: reqNumber(o, "protocolVersion", side),
        workerId: reqString(o, "workerId", side),
        pid: reqNumber(o, "pid", side),
      };
    case "ready":
      return { type: "ready", workerId: reqString(o, "workerId", side) };
    case "progress":
      return {
        type: "progress",
        workerId: reqString(o, "workerId", side),
        observedAt: reqNumber(o, "observedAt", side),
        iterationsStarted: reqNumber(o, "iterationsStarted", side),
        iterationsCompleted: reqNumber(o, "iterationsCompleted", side),
      };
    case "snapshot":
      return {
        type: "snapshot",
        workerId: reqString(o, "workerId", side),
        final: reqBool(o, "final", side),
        // Structural check only here (must be an object) — deep validation is deferred to
        // `parseLoadReducerPartial` at merge time (cooperative trust; see file header).
        partial: reqObject(o, "partial", side) as unknown as LoadReducerPartialV1,
      };
    case "result":
      return {
        type: "result",
        workerId: reqString(o, "workerId", side),
        observables: decodeObservables(reqObject(o, "observables", side), side),
      };
    case "error":
      return {
        type: "error",
        ...(o.workerId !== undefined ? { workerId: reqString(o, "workerId", side) } : {}),
        message: reqString(o, "message", side),
        ...(o.stack !== undefined ? { stack: reqString(o, "stack", side) } : {}),
      };
    case "done":
      return { type: "done", workerId: reqString(o, "workerId", side) };
    default:
      throw new MulticoreProtocolError(`${side}: unknown message type ${JSON.stringify(type)}`);
  }
}

function decodeObservables(o: Record<string, unknown>, side: string): ShardResultObservablesV1 {
  const endReason = reqString(o, "endReason", side) as LoadEndReason;
  return {
    endReason,
    finalizeNow: reqNumber(o, "finalizeNow", side),
    mixOverrideUsed: reqBool(o, "mixOverrideUsed", side),
    peakContinuations: reqNumber(o, "peakContinuations", side),
    abortedByDrainTimeout: reqNumber(o, "abortedByDrainTimeout", side),
    unreleasedTailPollRan: reqBool(o, "unreleasedTailPollRan", side),
    maxStartLatenessMs: reqNumber(o, "maxStartLatenessMs", side),
  };
}

/**
 * Decode + validate a frame the worker received FROM the coordinator. Same cooperative
 * structural validation. The `shard`/`assignment` internals are trusted to `runLoadShard`
 * (which validates the plan + shard itself and throws a `loadRunner`-prefixed error the
 * worker relays as an `error` frame).
 */
export function decodeCoordinatorMessage(raw: unknown): CoordinatorMessage {
  const side = "coordinator→worker";
  const o = asRecord(raw, side);
  checkEnvelope(o, side);
  const type = o.type;
  switch (type) {
    case "assign": {
      const a = reqObject(o, "assignment", side);
      const shard = reqObject(a, "shard", side) as unknown as LoadShard;
      const assignment: ShardAssignmentV1 = {
        file: reqString(a, "file", side),
        planId: reqString(a, "planId", side),
        shard,
        rngSeed: reqString(a, "rngSeed", side),
        vars: reqObject(a, "vars", side) as Record<string, string>,
        secrets: reqObject(a, "secrets", side) as Record<string, string>,
        timelineOrigin: reqNumber(a, "timelineOrigin", side),
        ...(a.baseSession !== undefined
          ? { baseSession: reqObject(a, "baseSession", side) as Record<string, unknown> }
          : {}),
        ...(a.snapshotIntervalMs !== undefined ? { snapshotIntervalMs: reqNumber(a, "snapshotIntervalMs", side) } : {}),
      };
      return { type: "assign", assignment };
    }
    case "start":
      return {
        type: "start",
        startAt: reqNumber(o, "startAt", side),
        ...(o.dispatchDeadline !== undefined ? { dispatchDeadline: reqNumber(o, "dispatchDeadline", side) } : {}),
        ...(o.timelineOrigin !== undefined ? { timelineOrigin: reqNumber(o, "timelineOrigin", side) } : {}),
      };
    case "abort":
      return { type: "abort", reason: reqString(o, "reason", side) };
    case "heartbeat":
      return { type: "heartbeat", ...(o.ts !== undefined ? { ts: reqNumber(o, "ts", side) } : {}) };
    default:
      throw new MulticoreProtocolError(`${side}: unknown message type ${JSON.stringify(type)}`);
  }
}
