import { describe, expect, test } from "vitest";
import type { ResolvedRunPlan } from "./config.js";
import { formatResolvedPlan } from "./print-plan.js";

function makePlan(over: Partial<ResolvedRunPlan> = {}): ResolvedRunPlan {
  return {
    profile: "ci",
    configPath: "/repo/glubean.yaml",
    suites: [
      { name: "contracts", target: "./contracts", kinds: ["contract", "flow"] },
      { name: "tests", target: "./tests", kinds: ["test"] },
    ],
    selection: {
      tags: [],
      excludeTags: ["manual", "destructive"],
      filter: undefined,
      pick: undefined,
      tagMode: "or",
    },
    execution: {
      failFast: true,
      failAfter: null,
      timeoutMs: 30000,
      concurrency: 2,
      noSession: false,
    },
    capabilities: { browser: false, outOfBand: false, optIn: false },
    reporters: {
      console: "summary",
      junit: ".glubean/results/junit.xml",
      resultJson: ".glubean/results/ci.result.json",
      emitFullTrace: false,
      inferSchema: false,
      truncateArrays: false,
    },
    envFile: ".env",
    redaction: { replacementFormat: "simple" },
    thresholds: {},
    ...over,
  };
}

describe("formatResolvedPlan", () => {
  test("emits profile + suites + selection + execution + reporters per plan §可见 plan 输出", () => {
    const out = formatResolvedPlan(makePlan(), "/repo");
    // Header
    expect(out).toContain("Profile: ci");
    expect(out).toContain("Config:  glubean.yaml");
    // Suites: name-padded, kinds rendered in brackets
    expect(out).toContain("contracts -> ./contracts [contract, flow]");
    expect(out).toContain("tests     -> ./tests [test]");
    // Selection
    expect(out).toContain("excludeTags: manual, destructive");
    expect(out).toContain("tagMode: or");
    // Execution: failAfter null renders as "none" not "null"
    expect(out).toContain("failFast: true");
    expect(out).toContain("failAfter: none");
    expect(out).toContain("concurrency: 2");
    expect(out).toContain("timeoutMs: 30000");
    // Reporters: console line intentionally suppressed until reporters.console
    // is wired through runCommand — see print-plan.ts comment.
    expect(out).not.toContain("console:");
    expect(out).toContain("junit: .glubean/results/junit.xml");
    expect(out).toContain("resultJson: .glubean/results/ci.result.json");
  });

  test("omits empty selection lines + reporters that aren't set", () => {
    const plan = makePlan({
      selection: {
        tags: [],
        excludeTags: [],
        tagMode: "or",
      },
      reporters: {
        console: "detailed",
        emitFullTrace: false,
        inferSchema: false,
        truncateArrays: false,
      },
    });
    const out = formatResolvedPlan(plan, "/repo");
    expect(out).not.toContain("tags:");
    expect(out).not.toContain("excludeTags:");
    expect(out).not.toContain("filter:");
    expect(out).not.toContain("pick:");
    expect(out).not.toContain("junit:");
    expect(out).not.toContain("resultJson:");
    expect(out).not.toContain("emitFullTrace:");
    expect(out).not.toContain("console:");
  });

  test("renders failAfter number when set", () => {
    const plan = makePlan({
      execution: {
        failFast: false,
        failAfter: 5,
        timeoutMs: 30000,
        concurrency: 4,
        noSession: false,
      },
    });
    const out = formatResolvedPlan(plan, "/repo");
    expect(out).toContain("failAfter: 5");
  });

  test("renders noSession when true", () => {
    const plan = makePlan({
      execution: {
        failFast: false,
        failAfter: null,
        timeoutMs: 30000,
        concurrency: 4,
        noSession: true,
      },
    });
    const out = formatResolvedPlan(plan, "/repo");
    expect(out).toContain("noSession: true");
  });

  test("renders upload section when enabled", () => {
    const plan = makePlan({
      upload: { enabled: true, projectId: "prj_demo", tokenEnv: "GLUBEAN_TOKEN_DEMO" },
    });
    const out = formatResolvedPlan(plan, "/repo");
    expect(out).toContain("Upload:");
    expect(out).toContain("enabled: true");
    expect(out).toContain("projectId: prj_demo");
    expect(out).toContain("tokenEnv: GLUBEAN_TOKEN_DEMO");
  });

  test("omits upload section when disabled or absent", () => {
    expect(formatResolvedPlan(makePlan(), "/repo")).not.toContain("Upload:");
    const plan = makePlan({ upload: { enabled: false } });
    expect(formatResolvedPlan(plan, "/repo")).not.toContain("Upload:");
  });

  test("renders thresholds section: per-aggregation rules + shorthand string", () => {
    const plan = makePlan({
      thresholds: {
        http_duration_ms: { p95: "<200", avg: "<100" },
        error_rate: "<0.01",
      },
    });
    const out = formatResolvedPlan(plan, "/repo");
    expect(out).toContain("Thresholds:");
    expect(out).toContain("http_duration_ms: p95 <200, avg <100");
    expect(out).toContain("error_rate: <0.01");
  });

  test("omits thresholds section when none declared", () => {
    expect(formatResolvedPlan(makePlan(), "/repo")).not.toContain("Thresholds:");
  });

  test("absolute configPath outside cwd falls back to the absolute path", () => {
    const plan = makePlan({ configPath: "/other/repo/glubean.yaml" });
    const out = formatResolvedPlan(plan, "/repo");
    // relative() gives "../other/repo/glubean.yaml" — still resolvable, not empty
    expect(out).toMatch(/Config:\s+\.\.\/other\/repo\/glubean\.yaml/);
  });
});
