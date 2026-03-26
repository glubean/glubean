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

  // Derive success:
  // 1. Any error/status event → failure (crash, timeout, process exit)
  //    These event types are not in TimelineEvent but may be present
  //    when callers pass ExecutionEvent[] or GlubeanEvent[] via `as any`.
  // 2. If step_end events exist, use them as authority
  // 3. Otherwise fall back to assertion results
  let success: boolean;
  const hasHardFailure = events.some((e) => {
    const t = (e as { type: string }).type;
    if (t === "error") return true;
    if (t === "status") {
      const s = (e as { status?: string }).status;
      return s !== "completed" && s !== "skipped";
    }
    return false;
  });
  if (hasHardFailure) {
    success = false;
  } else {
    const hasStepEnds = events.some((e) => e.type === "step_end");
    if (hasStepEnds) {
      success = stepFailed === 0;
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
    warningTotal,
    warningTriggered,
    schemaValidationTotal,
    schemaValidationFailed,
    schemaValidationWarnings,
    success,
  };
}
