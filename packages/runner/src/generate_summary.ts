import type { TimelineEvent } from "./executor.js";

export interface Summary {
  assertionTotal: number;
  assertionFailed: number;
  httpRequestTotal: number;
  httpErrorTotal: number;
  httpErrorRate: number;
  stepTotal: number;
  stepPassed: number;
  stepFailed: number;
  stepSkipped: number;
  /** vNext workflow nodes (§17 #9): per-node verdicts, LAST node_end per nodeId
   * (a retrying node emits one bracket per attempt; only the terminal one
   * counts). All zero when the run has no workflow nodes. */
  nodeTotal: number;
  nodePassed: number;
  nodeFailed: number;
  nodeSkipped: number;
  /** Runtime grade rollup over the same per-node verdicts (§17 #10 — includes
   * opaque→trace promotions the static projection cannot know). */
  nodeGrades: { full: number; partial: number; trace: number; opaque: number };
  warningTotal: number;
  warningTriggered: number;
  schemaValidationTotal: number;
  schemaValidationFailed: number;
  schemaValidationWarnings: number;
  success: boolean;
}

/**
 * Derive a complete Summary from a list of timeline events.
 *
 * Pure function — no side effects.  Replicates the logic previously
 * scattered across harness counters + `deriveFailureFromEvents`.
 */
export function generateSummary(events: TimelineEvent[]): Summary {
  let assertionTotal = 0;
  let assertionFailed = 0;
  let httpRequestTotal = 0;
  let httpErrorTotal = 0;
  let stepTotal = 0;
  let stepPassed = 0;
  let stepFailed = 0;
  let stepSkipped = 0;
  let warningTotal = 0;
  let warningTriggered = 0;
  let schemaValidationTotal = 0;
  let schemaValidationFailed = 0;
  let schemaValidationWarnings = 0;
  // vNext workflow nodes: the LAST node_end per nodeId is the verdict — a
  // retrying node emits a failed bracket per non-terminal attempt that must
  // not count (mirrors the executor's commit semantics, §17 #7/#13).
  const lastNodeEnd = new Map<
    string,
    { status: "passed" | "failed" | "skipped"; grade: "full" | "partial" | "trace" | "opaque" }
  >();

  for (const e of events) {
    switch (e.type) {
      case "assertion":
        assertionTotal++;
        if (!e.passed) assertionFailed++;
        break;

      case "trace":
        httpRequestTotal++;
        if (e.data && typeof e.data === "object" && "status" in e.data) {
          const status = (e.data as { status: number }).status;
          if (status >= 400) httpErrorTotal++;
        }
        break;

      case "step_end":
        stepTotal++;
        if (e.status === "passed") stepPassed++;
        else if (e.status === "failed") stepFailed++;
        else if (e.status === "skipped") stepSkipped++;
        break;

      case "node_end":
        lastNodeEnd.set(e.nodeId, { status: e.status, grade: e.grade });
        break;


      case "warning":
        warningTotal++;
        if (!e.condition) warningTriggered++;
        break;

      case "schema_validation":
        schemaValidationTotal++;
        if (!e.success) {
          if (e.severity === "warn") {
            schemaValidationWarnings++;
          } else {
            // severity "error" or "fatal"
            schemaValidationFailed++;
          }
        }
        break;
    }
  }

  const httpErrorRate =
    httpRequestTotal > 0
      ? Math.round((httpErrorTotal / httpRequestTotal) * 10000) / 10000
      : 0;

  // Resolve per-node verdicts (last node_end per nodeId wins).
  let nodePassed = 0;
  let nodeFailed = 0;
  let nodeSkipped = 0;
  const nodeGrades = { full: 0, partial: 0, trace: 0, opaque: 0 };
  for (const verdict of lastNodeEnd.values()) {
    if (verdict.status === "passed") nodePassed++;
    else if (verdict.status === "failed") nodeFailed++;
    else nodeSkipped++;
    nodeGrades[verdict.grade]++;
  }
  const nodeTotal = lastNodeEnd.size;

  // Derive success:
  // 1. Any error/status event → failure (crash, timeout, process exit)
  //    These event types are not in TimelineEvent but may be present
  //    when callers pass ExecutionEvent[] or GlubeanEvent[] via `as any`.
  // 2. If step_end events exist, use them as authority
  // 3. Else if node_end events exist (vNext workflow), the per-node verdicts
  //    are the authority — assertion counts can disagree by design (e.g. a
  //    thrown-node failure leaves no failed assertion; the wrapping test's
  //    error event covers that via the hard-failure check above).
  // 4. Otherwise fall back to assertion results
  let success: boolean;
  const hasHardFailure = events.some((e) => {
    const t = (e as { type: string }).type;
    if (t === "error") return true;
    if (t === "status") {
      const s = (e as { status?: string }).status;
      return s !== "completed" && s !== "skipped";
    }
    // A branch decision that threw (predicate/lens error) is a failure even if
    // no leaf step ran, so a summary recomputed from events agrees with
    // result.success. Check PRESENCE (an empty-string error message is still a
    // failure), not truthiness.
    if (t === "branch") return (e as { error?: string }).error !== undefined;
    // A poll that exhausted / threw / returned a non-boolean carries `error`.
    if (t === "poll") return (e as { error?: string }).error !== undefined;
    return false;
  });
  if (hasHardFailure) {
    success = false;
  } else {
    const hasStepEnds = events.some((e) => e.type === "step_end");
    if (hasStepEnds) {
      success = stepFailed === 0;
    } else if (nodeTotal > 0) {
      success = nodeFailed === 0;
    } else {
      success = assertionFailed === 0;
    }
  }

  return {
    assertionTotal,
    assertionFailed,
    httpRequestTotal,
    httpErrorTotal,
    httpErrorRate,
    stepTotal,
    stepPassed,
    stepFailed,
    stepSkipped,
    nodeTotal,
    nodePassed,
    nodeFailed,
    nodeSkipped,
    nodeGrades,
    warningTotal,
    warningTriggered,
    schemaValidationTotal,
    schemaValidationFailed,
    schemaValidationWarnings,
    success,
  };
}
