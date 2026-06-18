// vNext workflow per-node evidence → first-class timeline events.
//
// The workflow executor (./execute.ts) emits node evidence as namespaced
// GlubeanEvents over ctx.event (NODE_START_EVENT / NODE_END_EVENT /
// POLL_ATTEMPT_EVENT / BRANCH_DECISION_EVENT — §17 #9). This unwraps the known
// shapes into first-class timeline events so node id + grade reach generateSummary
// and the Cloud payload directly (§17 #9/#10). Anything else — other workflow:*
// names, malformed payloads — returns null and stays a generic pass-through `event`
// (a misshapen payload must not mint a misshapen first-class event).
//
// Co-located with the executor that PRODUCES these events (plan 0007 — moved out of
// the generic harness): the event names come from the executor's own constants, so
// the producer and this consumer can't drift.
import type { GlubeanEvent } from "@glubean/sdk";
import {
  NODE_START_EVENT,
  NODE_END_EVENT,
  POLL_ATTEMPT_EVENT,
  BRANCH_DECISION_EVENT,
} from "./execute.js";

const NODE_STATUSES = new Set(["passed", "failed", "skipped"]);
const NODE_GRADES = new Set(["full", "partial", "trace", "opaque"]);
const POLL_OUTCOMES = new Set(["satisfied", "probe", "failed"]);

export function workflowEventToTimeline(ev: GlubeanEvent): Record<string, unknown> | null {
  if (
    ev.type !== NODE_START_EVENT &&
    ev.type !== NODE_END_EVENT &&
    ev.type !== POLL_ATTEMPT_EVENT &&
    ev.type !== BRANCH_DECISION_EVENT
  ) {
    return null;
  }
  const d = ev.data as Record<string, unknown> | undefined;
  if (!d || typeof d.nodeId !== "string") return null;
  const attemptFields = {
    ...(typeof d.attempt === "number" ? { attempt: d.attempt } : {}),
    ...(typeof d.attempts === "number" ? { attempts: d.attempts } : {}),
  };
  if (ev.type === NODE_START_EVENT) {
    return {
      type: "node_start",
      nodeId: d.nodeId,
      kind: typeof d.kind === "string" ? d.kind : "unknown",
      name: typeof d.name === "string" ? d.name : d.nodeId,
      ...attemptFields,
    };
  }
  if (ev.type === NODE_END_EVENT) {
    if (typeof d.status !== "string" || !NODE_STATUSES.has(d.status)) return null;
    if (typeof d.grade !== "string" || !NODE_GRADES.has(d.grade)) return null;
    return {
      type: "node_end",
      nodeId: d.nodeId,
      kind: typeof d.kind === "string" ? d.kind : "unknown",
      name: typeof d.name === "string" ? d.name : d.nodeId,
      status: d.status,
      grade: d.grade,
      durationMs: typeof d.durationMs === "number" ? d.durationMs : 0,
      ...(typeof d.error === "string" ? { error: d.error } : {}),
      ...attemptFields,
    };
  }
  if (ev.type === POLL_ATTEMPT_EVENT) {
    if (
      typeof d.attempt !== "number" ||
      typeof d.outcome !== "string" ||
      !POLL_OUTCOMES.has(d.outcome)
    ) {
      return null;
    }
    return {
      type: "poll_attempt",
      nodeId: d.nodeId,
      attempt: d.attempt,
      outcome: d.outcome,
      durationMs: typeof d.durationMs === "number" ? d.durationMs : 0,
    };
  }
  // BRANCH_DECISION_EVENT (addendum §9 — branch/switch/route taken case)
  if (
    (d.mode !== "predicate" && d.mode !== "value") ||
    (typeof d.takenIndex !== "number" && d.takenIndex !== "default")
  ) {
    return null;
  }
  return {
    type: "branch_decision",
    nodeId: d.nodeId,
    mode: d.mode,
    takenIndex: d.takenIndex,
    ...(typeof d.takenLabel === "string" ? { takenLabel: d.takenLabel } : {}),
  };
}
