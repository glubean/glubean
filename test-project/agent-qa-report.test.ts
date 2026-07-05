import { describe, expect as vitestExpect, it } from "vitest";
import {
  diffAgentQaReports,
  specFromBrowserContract,
  validateAgentQaReport,
  type ValidationSpec,
} from "./agent-qa-report.js";
import { loginJourney } from "./auth.browser.js";

// A minimal, schema-valid `agent-qa-report/v1` for `auth.browser.ts`'s
// happyPath case. Every test below starts from a deep clone of this and
// breaks exactly one rule, so a failing assertion always points at the rule
// under test rather than an accidental fixture typo.
function validReport(): Record<string, unknown> {
  return {
    kind: "agent-qa-report/v1",
    contract: "auth.login.journey",
    case: "happyPath",
    contractRevision: "1d22e1afb8c9",
    executor: {
      kind: "agent",
      model: "claude-sonnet-5",
      round: 1,
      startedAt: "2026-07-05T08:00:00Z",
      finishedAt: "2026-07-05T08:04:00Z",
    },
    steps: [
      { id: "open-login", status: "completed", evidence: ["final url = https://app.staging.glubean.com/login"] },
      { id: "fill-credentials", status: "completed", evidence: ["filled via aria-label Email/Password"] },
      { id: "submit", status: "completed", evidence: ["step-submit.png"] },
    ],
    expect: [
      { id: "url-dashboard", verdict: "pass", evidence: "final url = https://app.staging.glubean.com/dashboard" },
      { id: "dom-welcome", verdict: "pass", evidence: "heading[level=1] text: 'Welcome back, dogfood@glubean.com'" },
      { id: "calls-signin", verdict: "pass", evidence: "POST https://api.staging.glubean.com/api/auth/sign-in/email → 200" },
      { id: "console-clean", verdict: "pass", evidence: "0 error-level console messages on product domains" },
    ],
    extraFindings: [],
    provenance: "agent-judged",
  };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

const spec: ValidationSpec = specFromBrowserContract(loginJourney, "happyPath");

describe("specFromBrowserContract", () => {
  it("derives step/expect ids straight from the .browser.ts fixture", () => {
    vitestExpect(spec.stepIds).toEqual(["open-login", "fill-credentials", "submit"]);
    vitestExpect(spec.expectIds).toEqual(["url-dashboard", "dom-welcome", "calls-signin", "console-clean"]);
  });

  it("throws on an unknown case key rather than silently returning an empty spec", () => {
    vitestExpect(() => specFromBrowserContract(loginJourney, "nope" as never)).toThrow(/unknown case/);
  });
});

describe("validateAgentQaReport — happy path", () => {
  it("accepts a report that fully answers the fixed questionnaire", () => {
    const result = validateAgentQaReport(validReport(), spec);
    vitestExpect(result).toEqual({ valid: true, errors: [] });
  });

  it("accepts a report with a non-empty extraFindings entry", () => {
    const report = validReport();
    report.extraFindings = [
      {
        category: "console-noise",
        severity: "P4",
        title: "favicon.ico 404",
        note: "unrelated to product code",
        evidence: ["GET /favicon.ico → 404"],
        source: { attention: "unprompted" },
      },
    ];
    vitestExpect(validateAgentQaReport(report, spec).valid).toBe(true);
  });
});

describe("validateAgentQaReport — top-level fields", () => {
  it("rejects a non-object report", () => {
    vitestExpect(validateAgentQaReport(null, spec).valid).toBe(false);
    vitestExpect(validateAgentQaReport("prose is not a report", spec).valid).toBe(false);
  });

  it("rejects a wrong kind literal", () => {
    const report = validReport();
    report.kind = "agent-qa-report/v2";
    const result = validateAgentQaReport(report, spec);
    vitestExpect(result.valid).toBe(false);
    vitestExpect(result.errors).toContain("kind must be literal 'agent-qa-report/v1'");
  });

  it("rejects a wrong provenance literal (would blur agent-judged vs runtime-judged)", () => {
    const report = validReport();
    report.provenance = "runtime-judged";
    vitestExpect(validateAgentQaReport(report, spec).valid).toBe(false);
  });

  it("rejects a missing contractRevision", () => {
    const report = validReport();
    delete report.contractRevision;
    const result = validateAgentQaReport(report, spec);
    vitestExpect(result.errors).toContain("contractRevision required (non-empty string)");
  });

  it("rejects a missing executor.model", () => {
    const report = validReport();
    report.executor = { kind: "agent" };
    const result = validateAgentQaReport(report, spec);
    vitestExpect(result.errors).toContain("executor.model required");
  });
});

describe("validateAgentQaReport — steps[]", () => {
  it("rejects a report missing a spec step id", () => {
    const report = validReport();
    report.steps = (report.steps as unknown[]).slice(0, 2); // drop "submit"
    const result = validateAgentQaReport(report, spec);
    vitestExpect(result.errors).toContain("missing step: submit");
  });

  it("rejects a completed step with no evidence — optional evidence proved to be no evidence", () => {
    const report = validReport();
    (report.steps as Array<Record<string, unknown>>)[2] = { id: "submit", status: "completed" };
    const result = validateAgentQaReport(report, spec);
    vitestExpect(result.errors).toContain("step submit: completed requires >=1 evidence (screenshot/URL/DOM excerpt)");
  });

  it("rejects a blocked step with no note", () => {
    const report = validReport();
    (report.steps as Array<Record<string, unknown>>)[2] = { id: "submit", status: "blocked" };
    const result = validateAgentQaReport(report, spec);
    vitestExpect(result.errors).toContain("step submit: blocked requires note");
  });

  it("accepts a blocked step that carries a note (no evidence required when blocked)", () => {
    const report = validReport();
    (report.steps as Array<Record<string, unknown>>)[2] = {
      id: "submit",
      status: "blocked",
      note: "submit button never became enabled",
    };
    // submit is blocked, so its expect answers below should be blocked too —
    // but this test only exercises the steps[] rule in isolation.
    for (const e of report.expect as Array<Record<string, unknown>>) {
      e.verdict = "blocked";
      delete e.evidence;
    }
    const result = validateAgentQaReport(report, spec);
    vitestExpect(result.errors.some((e) => e.startsWith("step submit:"))).toBe(false);
  });
});

describe("validateAgentQaReport — expect[] (fixed questionnaire)", () => {
  it("rejects a report that skips an expect id — the single most important rule", () => {
    const report = validReport();
    report.expect = (report.expect as unknown[]).filter(
      (e) => (e as { id: string }).id !== "console-clean",
    );
    const result = validateAgentQaReport(report, spec);
    vitestExpect(result.errors).toContain("missing expect answer: console-clean (漏答 = report INVALID)");
  });

  it("rejects an unknown verdict value (closed 4-value enum)", () => {
    const report = validReport();
    (report.expect as Array<Record<string, unknown>>)[0].verdict = "mostly-pass";
    const result = validateAgentQaReport(report, spec);
    vitestExpect(result.errors).toContain("expect url-dashboard: bad verdict 'mostly-pass'");
  });

  it("rejects verdict=pass with empty evidence", () => {
    const report = validReport();
    (report.expect as Array<Record<string, unknown>>)[0].evidence = "";
    const result = validateAgentQaReport(report, spec);
    vitestExpect(result.errors).toContain("expect url-dashboard: verdict 'pass' requires non-empty evidence");
  });

  it("rejects verdict=unverified with no reason", () => {
    const report = validReport();
    const answer = (report.expect as Array<Record<string, unknown>>)[3];
    answer.verdict = "unverified";
    delete answer.evidence;
    const result = validateAgentQaReport(report, spec);
    vitestExpect(result.errors).toContain("expect console-clean: unverified requires reason");
  });

  it("accepts verdict=unverified when reason is present", () => {
    const report = validReport();
    const answer = (report.expect as Array<Record<string, unknown>>)[3];
    answer.verdict = "unverified";
    delete answer.evidence;
    answer.reason = "getResponseBody() returned empty for a 304 — cannot verify body shape";
    vitestExpect(validateAgentQaReport(report, spec).valid).toBe(true);
  });
});

describe("validateAgentQaReport — extraFindings[]", () => {
  it("rejects a missing extraFindings field (distinct from an empty array)", () => {
    const report = validReport();
    delete report.extraFindings;
    const result = validateAgentQaReport(report, spec);
    vitestExpect(result.errors).toContain("extraFindings must exist (empty array is valid, missing is not)");
  });

  it("rejects a finding with a bad severity", () => {
    const report = validReport();
    report.extraFindings = [
      { category: "layout", severity: "P9", title: "x", note: "y" },
    ];
    const result = validateAgentQaReport(report, spec);
    vitestExpect(result.errors).toContain("extraFindings[0]: bad severity 'P9'");
  });

  it("rejects a finding missing a title (dedup clustering key)", () => {
    const report = validReport();
    report.extraFindings = [{ category: "layout", severity: "P3", note: "y" }];
    const result = validateAgentQaReport(report, spec);
    vitestExpect(result.errors).toContain("extraFindings[0]: requires title");
  });
});

describe("validateAgentQaReport — secret red line", () => {
  it("flags a report that leaks a known secret plaintext value", () => {
    const report = validReport();
    (report.expect as Array<Record<string, unknown>>)[2].evidence =
      "POST .../sign-in/email body: { password: 'hunter2-staging' } → 200";
    const result = validateAgentQaReport(report, spec, { knownSecrets: ["hunter2-staging"] });
    vitestExpect(result.valid).toBe(false);
    vitestExpect(result.errors).toContain("SECRET LEAK: report contains a known secret value in plaintext");
  });

  it("does not false-positive when no known secret is present", () => {
    const result = validateAgentQaReport(validReport(), spec, { knownSecrets: ["hunter2-staging"] });
    vitestExpect(result.valid).toBe(true);
  });
});

describe("diffAgentQaReports — cross-round comparability (the GLU-211 hypothesis check)", () => {
  it("reports identical id sets and zero disagreements for two matching VALID reports", () => {
    const roundA = validReport();
    const roundB = clone(validReport());
    (roundB.executor as Record<string, unknown>).round = 2;
    const diff = diffAgentQaReports(roundA, roundB);
    vitestExpect(diff.sameStepIdSet).toBe(true);
    vitestExpect(diff.sameExpectIdSet).toBe(true);
    vitestExpect(diff.disagreements).toEqual([]);
    vitestExpect(diff.extraFindingsOnlyInA).toEqual([]);
    vitestExpect(diff.extraFindingsOnlyInB).toEqual([]);
  });

  it("surfaces exactly the expect ids whose verdict disagrees between rounds", () => {
    const roundA = validReport();
    const roundB = clone(validReport());
    (roundB.expect as Array<Record<string, unknown>>).find((e) => e.id === "console-clean")!.verdict = "fail";
    (roundB.expect as Array<Record<string, unknown>>).find((e) => e.id === "console-clean")!.evidence =
      "1 error: GET /projects/proj_default_.../targets → 404";
    const diff = diffAgentQaReports(roundA, roundB);
    vitestExpect(diff.disagreements).toEqual(["console-clean"]);
    vitestExpect(diff.verdictDeltas).toContainEqual({ id: "console-clean", a: "pass", b: "fail" });
  });

  it("flags a broken sequence (different expect id set) — schema drift, not just verdict drift", () => {
    const roundA = validReport();
    const roundB = clone(validReport());
    roundB.expect = (roundB.expect as unknown[]).filter((e) => (e as { id: string }).id !== "console-clean");
    const diff = diffAgentQaReports(roundA, roundB);
    vitestExpect(diff.sameExpectIdSet).toBe(false);
  });

  it("diffs extraFindings by category+title, independent of ordering", () => {
    const roundA = validReport();
    roundA.extraFindings = [
      { category: "layout", severity: "P3", title: "dashboard cards overlap at 1280px", note: "n" },
    ];
    const roundB = validReport();
    roundB.extraFindings = [
      { category: "console-noise", severity: "P4", title: "get-session ERR_ABORTED", note: "n" },
    ];
    const diff = diffAgentQaReports(roundA, roundB);
    vitestExpect(diff.extraFindingsOnlyInA).toEqual([
      { category: "layout", title: "dashboard cards overlap at 1280px" },
    ]);
    vitestExpect(diff.extraFindingsOnlyInB).toEqual([
      { category: "console-noise", title: "get-session ERR_ABORTED" },
    ]);
  });
});
