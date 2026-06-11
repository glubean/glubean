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
  // vNext workflow nodes: a retrying node emits one bracket per attempt and
  // only the LAST one carries the verdict (§17 #7/#13). The executor does NOT
  // reject duplicate authored node ids, so the fold cannot key on nodeId
  // alone: an attempt-stamped bracket with attempt > 1 REPLACES the previous
  // verdict of its retry chain; everything else (no attempt stamp, or
  // attempt 1 starting a new chain) is a distinct node occurrence.
  type NodeVerdict = {
    status: "passed" | "failed" | "skipped";
    grade: "full" | "partial" | "trace" | "opaque";
  };
  const nodeVerdicts: NodeVerdict[] = [];
  const lastIndexByNodeId = new Map<string, number>();

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

      case "node_end": {
        const verdict: NodeVerdict = { status: e.status, grade: e.grade };
        const retryOfPrevious =
          e.attempt !== undefined && e.attempt > 1 && lastIndexByNodeId.has(e.nodeId);
        if (retryOfPrevious) {
          nodeVerdicts[lastIndexByNodeId.get(e.nodeId)!] = verdict;
        } else {
          lastIndexByNodeId.set(e.nodeId, nodeVerdicts.length);
          nodeVerdicts.push(verdict);
        }
        break;
      }


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

  // Resolve per-node verdicts (retry chains already folded above).
  let nodePassed = 0;
  let nodeFailed = 0;
  let nodeSkipped = 0;
  const nodeGrades = { full: 0, partial: 0, trace: 0, opaque: 0 };
  for (const verdict of nodeVerdicts) {
    if (verdict.status === "passed") nodePassed++;
    else if (verdict.status === "failed") nodeFailed++;
    else nodeSkipped++;
    nodeGrades[verdict.grade]++;
  }
  const nodeTotal = nodeVerdicts.length;

  // Derive success:
  // 1. Any error/status event → failure (crash, timeout, process exit)
  //    These event types are not in TimelineEvent but may be present
  //    when callers pass ExecutionEvent[] or GlubeanEvent[] via `as any`.
  // 2. If step_end events exist, use them as authority
  // 3. Else if node_end events exist (vNext workflow): node verdicts AND
  //    assertion counts must BOTH be clean. Verdicts catch what assertions
  //    can't (a thrown-node failure leaves no failed assertion); assertions
  //    catch what verdicts can't (a setup soft-failure skips every node, so
  //    no node is "failed" — and the wrapping test's error event is NOT in
  //    the timeline array, so a recomputed summary would otherwise pass).
  //    Retry noise can't poison this: a quarantined attempt's failed asserts
  //    never reach the host timeline (sdk S2.4c) — every failed assertion
  //    present is verdict-relevant.
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
      success = nodeFailed === 0 && assertionFailed === 0;
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
