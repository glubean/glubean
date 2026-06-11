import { describe, test, expect } from "vitest";
import { generateSummary } from "./generate_summary.js";
import type { TimelineEvent } from "./executor.js";

describe("generateSummary", () => {
  test("all pass — 1 trace + 1 assertion passed", () => {
    const events: TimelineEvent[] = [
      { type: "trace", ts: 1, data: { method: "GET", url: "https://api.example.com/health", status: 200, duration: 50 } as any },
      { type: "assertion", ts: 2, passed: true, message: "status is 200" },
    ];
    const s = generateSummary(events);
    expect(s.success).toBe(true);
    expect(s.assertionTotal).toBe(1);
    expect(s.assertionFailed).toBe(0);
    expect(s.httpRequestTotal).toBe(1);
    expect(s.httpErrorTotal).toBe(0);
    expect(s.httpErrorRate).toBe(0);
  });

  test("soft assertion failure — status completed but assertion failed", () => {
    const events: TimelineEvent[] = [
      { type: "assertion", ts: 1, passed: true, message: "ok" },
      { type: "assertion", ts: 2, passed: false, message: "expected 1 === 2" },
    ];
    const s = generateSummary(events);
    expect(s.success).toBe(false);
    expect(s.assertionTotal).toBe(2);
    expect(s.assertionFailed).toBe(1);
  });

  test("step retry success — first attempt failed, retry passed", () => {
    const events: TimelineEvent[] = [
      { type: "assertion", ts: 1, passed: false, message: "attempt 1 fail", stepIndex: 0 },
      { type: "assertion", ts: 2, passed: true, message: "attempt 2 pass", stepIndex: 0 },
      {
        type: "step_end", ts: 3, index: 0, name: "flaky",
        status: "passed", durationMs: 200, assertions: 1, failedAssertions: 0,
        attempts: 2, retriesUsed: 1,
      },
    ];
    const s = generateSummary(events);
    // step_end says passed — success is derived from step_end, not raw assertions
    expect(s.success).toBe(true);
    expect(s.stepTotal).toBe(1);
    expect(s.stepPassed).toBe(1);
    expect(s.stepFailed).toBe(0);
    // Raw assertion counters still reflect all attempts
    expect(s.assertionTotal).toBe(2);
    expect(s.assertionFailed).toBe(1);
  });

  test("step retry failure — all attempts failed", () => {
    const events: TimelineEvent[] = [
      { type: "assertion", ts: 1, passed: false, message: "attempt 1 fail", stepIndex: 0 },
      { type: "assertion", ts: 2, passed: false, message: "attempt 2 fail", stepIndex: 0 },
      {
        type: "step_end", ts: 3, index: 0, name: "broken",
        status: "failed", durationMs: 400, assertions: 1, failedAssertions: 1,
        attempts: 2, retriesUsed: 1,
      },
    ];
    const s = generateSummary(events);
    expect(s.success).toBe(false);
    expect(s.stepFailed).toBe(1);
  });

  test("schema validation failure", () => {
    const events: TimelineEvent[] = [
      {
        type: "schema_validation", ts: 1, label: "response body",
        success: false, severity: "error",
        issues: [{ message: "expected string, got number" }],
      },
      { type: "assertion", ts: 2, passed: false, message: "Schema validation failed: response body" },
    ];
    const s = generateSummary(events);
    expect(s.success).toBe(false);
    expect(s.schemaValidationTotal).toBe(1);
    expect(s.schemaValidationFailed).toBe(1);
    expect(s.schemaValidationWarnings).toBe(0);
  });

  test("schema validation warning (severity=warn)", () => {
    const events: TimelineEvent[] = [
      {
        type: "schema_validation", ts: 1, label: "loose check",
        success: false, severity: "warn",
      },
    ];
    const s = generateSummary(events);
    // Warnings don't cause failure
    expect(s.success).toBe(true);
    expect(s.schemaValidationTotal).toBe(1);
    expect(s.schemaValidationWarnings).toBe(1);
    expect(s.schemaValidationFailed).toBe(0);
  });

  test("empty events", () => {
    const s = generateSummary([]);
    expect(s.success).toBe(true);
    expect(s.assertionTotal).toBe(0);
    expect(s.httpRequestTotal).toBe(0);
    expect(s.stepTotal).toBe(0);
    expect(s.warningTotal).toBe(0);
    expect(s.schemaValidationTotal).toBe(0);
    expect(s.httpErrorRate).toBe(0);
  });

  test("multiple traces — mix of 2xx and 4xx", () => {
    const events: TimelineEvent[] = [
      { type: "trace", ts: 1, data: { method: "GET", url: "https://a.com", status: 200, duration: 10 } as any },
      { type: "trace", ts: 2, data: { method: "POST", url: "https://b.com", status: 201, duration: 20 } as any },
      { type: "trace", ts: 3, data: { method: "GET", url: "https://c.com", status: 404, duration: 15 } as any },
      { type: "trace", ts: 4, data: { method: "DELETE", url: "https://d.com", status: 500, duration: 30 } as any },
      { type: "assertion", ts: 5, passed: true, message: "ok" },
    ];
    const s = generateSummary(events);
    expect(s.httpRequestTotal).toBe(4);
    expect(s.httpErrorTotal).toBe(2);
    expect(s.httpErrorRate).toBe(0.5);
    expect(s.success).toBe(true);
  });

  test("warning events", () => {
    const events: TimelineEvent[] = [
      { type: "warning", ts: 1, condition: true, message: "all good" },
      { type: "warning", ts: 2, condition: false, message: "response slow" },
      { type: "warning", ts: 3, condition: false, message: "high error rate" },
    ];
    const s = generateSummary(events);
    expect(s.success).toBe(true); // warnings never affect success
    expect(s.warningTotal).toBe(3);
    expect(s.warningTriggered).toBe(2);
  });
});

// =============================================================================
// vNext workflow node events (§17 #9/#10 consumption — S2.7)
// =============================================================================

describe("workflow node events", () => {
  const end = (
    nodeId: string,
    status: "passed" | "failed" | "skipped",
    grade: "full" | "partial" | "trace" | "opaque",
    extra: Record<string, unknown> = {},
  ): TimelineEvent =>
    ({ type: "node_end", ts: 1, nodeId, kind: "action", name: nodeId, status, grade, durationMs: 1, ...extra }) as TimelineEvent;

  test("node verdicts + grade rollup; node_end is the success authority without step_end", () => {
    const events: TimelineEvent[] = [
      end("a", "passed", "full"),
      end("b", "passed", "trace"),
      end("c", "skipped", "opaque"),
    ];
    const s = generateSummary(events);
    expect(s.nodeTotal).toBe(3);
    expect(s.nodePassed).toBe(2);
    expect(s.nodeFailed).toBe(0);
    expect(s.nodeSkipped).toBe(1);
    expect(s.nodeGrades).toEqual({ full: 1, partial: 0, trace: 1, opaque: 1 });
    expect(s.success).toBe(true);
  });

  test("a failed node fails the run even with zero failed assertions (thrown-node case)", () => {
    const events: TimelineEvent[] = [
      { type: "assertion", ts: 1, passed: true, message: "ok" },
      end("boom", "failed", "opaque", { error: "kaput" }),
    ];
    const s = generateSummary(events);
    expect(s.nodeFailed).toBe(1);
    expect(s.success).toBe(false); // node verdicts are authoritative, not assertion counts
  });

  test("retry: the LAST node_end per nodeId wins — a non-terminal failed bracket doesn't count", () => {
    const events: TimelineEvent[] = [
      end("flaky", "failed", "opaque", { attempt: 1, attempts: 2 }),
      end("flaky", "passed", "trace", { attempt: 2, attempts: 2 }),
    ];
    const s = generateSummary(events);
    expect(s.nodeTotal).toBe(1);
    expect(s.nodePassed).toBe(1);
    expect(s.nodeFailed).toBe(0);
    expect(s.nodeGrades).toEqual({ full: 0, partial: 0, trace: 1, opaque: 0 });
    expect(s.success).toBe(true);
  });

  test("step_end stays the authority when both are present", () => {
    const events: TimelineEvent[] = [
      { type: "step_end", ts: 1, index: 0, name: "s", status: "failed", durationMs: 1, assertions: 0, failedAssertions: 0 },
      end("a", "passed", "full"),
    ];
    expect(generateSummary(events).success).toBe(false);
  });

  test("no node events → node counters zero and assertions stay the fallback authority", () => {
    const events: TimelineEvent[] = [{ type: "assertion", ts: 1, passed: false, message: "bad" }];
    const s = generateSummary(events);
    expect(s.nodeTotal).toBe(0);
    expect(s.nodeGrades).toEqual({ full: 0, partial: 0, trace: 0, opaque: 0 });
    expect(s.success).toBe(false);
  });

  test("a setup soft-failure (failed assert + all nodes skipped) fails a recomputed summary (codex S2.7 R1)", () => {
    const events: TimelineEvent[] = [
      { type: "assertion", ts: 1, passed: false, message: "setup precondition" },
      end("a", "skipped", "full"),
      end("b", "skipped", "opaque"),
    ];
    const s = generateSummary(events);
    expect(s.nodeFailed).toBe(0); // no node failed…
    expect(s.success).toBe(false); // …but the failed assertion is verdict-relevant
  });

  test("duplicate node ids stay distinct occurrences; only attempt>1 folds a retry chain (codex S2.7 R1)", () => {
    const events: TimelineEvent[] = [
      end("dup", "failed", "opaque"), // first occurrence (no attempt stamp)
      end("dup", "skipped", "opaque"), // second occurrence — must NOT replace the first
      end("chain", "failed", "opaque", { attempt: 1, attempts: 2 }),
      end("chain", "passed", "trace", { attempt: 2, attempts: 2 }), // folds onto attempt 1
    ];
    const s = generateSummary(events);
    expect(s.nodeTotal).toBe(3); // dup×2 + chain×1
    expect(s.nodeFailed).toBe(1); // the first "dup" occurrence still counts
    expect(s.nodePassed).toBe(1);
    expect(s.nodeSkipped).toBe(1);
    expect(s.success).toBe(false);
  });
});
