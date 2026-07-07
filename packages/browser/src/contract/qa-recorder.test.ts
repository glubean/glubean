/**
 * Tests for the Mode B QA recorder seal logic (GLU-234/235 · P1-4/P1-5).
 * Pure — no live browser. Verifies the runtime judge of the machine-checkable
 * expects, the agent-answer merge, and the agent-qa-report/v1 shape.
 */

import { describe, expect, test } from "vitest";
import type { ContractCaseRef } from "@glubean/sdk";
import { judgeRecordedExpects, sealQaReport } from "./qa-recorder.js";
import type { BrowserContractCase, BrowserEvidence } from "./types.js";

function httpRef(endpoint: string, status: number): ContractCaseRef<unknown, unknown> {
  return {
    __glubean_type: "contract-case-ref",
    contractId: "auth.sign-in.email",
    caseKey: "validStagingCredentials",
    protocol: "http",
    target: endpoint,
    contract: { _spec: { endpoint, cases: { validStagingCredentials: { expect: { status } } } } },
  } as unknown as ContractCaseRef<unknown, unknown>;
}

const caseSpec: BrowserContractCase = {
  description: "login",
  steps: [{ id: "s", intent: "s" }],
  expect: [
    { id: "url-dashboard", url: { path: ["/", "/dashboard"], notPath: "/login" } },
    { id: "dom-welcome", dom: { visible: { text: "Welcome back" } } },
    { id: "calls-signin", calls: httpRef("POST /api/auth/sign-in/email", 200) },
    { id: "console-clean", console: { errors: 0, allow: ["favicon"] } },
  ],
} as BrowserContractCase;

const cleanEvidence: BrowserEvidence = {
  finalUrl: "https://app.staging.glubean.com/",
  network: [{ method: "POST", url: "https://api/api/auth/sign-in/email", status: 200, durationMs: 10 }],
  consoleErrors: [{ message: "favicon 404", source: "https://app/favicon.ico" }],
};

describe("judgeRecordedExpects", () => {
  test("runtime-judges url / calls / console; leaves dom to the agent", () => {
    const answers = judgeRecordedExpects(caseSpec, cleanEvidence);
    const byId = Object.fromEntries(answers.map((a) => [a.id, a]));
    expect(byId["url-dashboard"]).toMatchObject({ verdict: "pass", judgedBy: "runtime" });
    expect(byId["calls-signin"]).toMatchObject({ verdict: "pass", judgedBy: "runtime" });
    expect(byId["console-clean"]).toMatchObject({ verdict: "pass", judgedBy: "runtime" });
    expect(byId["dom-welcome"]).toMatchObject({ verdict: "unverified", judgedBy: "agent" });
  });

  test("fails url when still on /login and console on a product error", () => {
    const answers = judgeRecordedExpects(caseSpec, {
      finalUrl: "https://app.staging.glubean.com/login",
      network: [{ method: "POST", url: "https://api/api/auth/sign-in/email", status: 200, durationMs: 10 }],
      consoleErrors: [{ message: "boom", source: "https://api.staging.glubean.com/x" }],
    });
    const byId = Object.fromEntries(answers.map((a) => [a.id, a]));
    expect(byId["url-dashboard"].verdict).toBe("fail");
    expect(byId["console-clean"].verdict).toBe("fail");
  });
});

describe("sealQaReport", () => {
  test("produces a valid agent-qa-report/v1 in spec order, agent-judged provenance", () => {
    const report = sealQaReport({
      contractId: "auth.login.journey",
      caseKey: "happyPath",
      caseSpec,
      contractRevision: "abc123def456",
      evidence: cleanEvidence,
      executor: { kind: "agent", model: "claude-sonnet-5", round: 1 },
      steps: [{ id: "s", status: "completed", evidence: ["shot.png"] }],
    });
    expect(report.kind).toBe("agent-qa-report/v1");
    expect(report.provenance).toBe("agent-judged");
    expect(report.contract).toBe("auth.login.journey");
    expect(report.expect.map((e) => e.id)).toEqual([
      "url-dashboard",
      "dom-welcome",
      "calls-signin",
      "console-clean",
    ]);
    expect(() => JSON.stringify(report)).not.toThrow();
  });

  test("auto-populates a valid steps[] covering every spec step id (codex R2)", () => {
    const spec2: BrowserContractCase = {
      description: "x",
      steps: [
        { id: "open", intent: "open" },
        { id: "submit", intent: "submit" },
      ],
      expect: [{ id: "url", url: { path: "/" } }],
    } as BrowserContractCase;
    const report = sealQaReport({
      contractId: "c",
      caseKey: "k",
      caseSpec: spec2,
      contractRevision: "rev",
      evidence: { finalUrl: "https://h/", network: [], consoleErrors: [] },
      executor: { kind: "agent", model: "m" },
    });
    expect(report.steps.map((s) => s.id)).toEqual(["open", "submit"]);
    // A passive recorder must NOT fabricate `completed` (codex R3) — synthesized
    // steps are `skipped` with a note (valid; no evidence required).
    expect(report.steps.every((s) => s.status === "skipped" && !!s.note)).toBe(true);
  });

  test("agent answers CANNOT override a runtime-judged url/calls/console verdict (codex R1)", () => {
    // A failing calls verdict (no POST observed) must NOT be flippable to pass
    // by an agent answer — machine-checkable expects stay runtime-authoritative.
    const report = sealQaReport({
      contractId: "c",
      caseKey: "happyPath",
      caseSpec,
      contractRevision: "rev",
      evidence: { finalUrl: "https://app.staging.glubean.com/login", network: [], consoleErrors: [] },
      executor: { kind: "agent", model: "m" },
      agentAnswers: [
        { id: "calls-signin", verdict: "pass", evidence: "agent claims it happened", judgedBy: "agent" },
        { id: "url-dashboard", verdict: "pass", evidence: "agent claims dashboard", judgedBy: "agent" },
      ],
    });
    // Runtime judged these FAIL (no POST, still on /login) — agent can't flip them.
    expect(report.expect.find((e) => e.id === "calls-signin")).toMatchObject({ verdict: "fail", judgedBy: "runtime" });
    expect(report.expect.find((e) => e.id === "url-dashboard")).toMatchObject({ verdict: "fail", judgedBy: "runtime" });
  });

  test("agent answers override the recorder's unverified dom verdict", () => {
    const report = sealQaReport({
      contractId: "c",
      caseKey: "happyPath",
      caseSpec,
      contractRevision: "rev",
      evidence: cleanEvidence,
      executor: { kind: "agent", model: "m" },
      agentAnswers: [
        { id: "dom-welcome", verdict: "pass", evidence: "heading 'Welcome back, Peisong'", judgedBy: "agent" },
      ],
    });
    const dom = report.expect.find((e) => e.id === "dom-welcome");
    expect(dom).toMatchObject({ verdict: "pass", judgedBy: "agent" });
    // Runtime-judged ones remain.
    expect(report.expect.find((e) => e.id === "calls-signin")).toMatchObject({ judgedBy: "runtime" });
  });
});
