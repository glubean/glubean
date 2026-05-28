/**
 * Phase 1 sub-task D: resolveRunPlan unit tests.
 *
 * Covers: missing profile / 4-layer merge (built-in → defaults → profile → CLI)
 * / array replacement (not concat) / null preservation on failAfter / channel
 * override on reporters (not full-dict replacement).
 */

import { describe, it, expect } from "vitest";
import {
  GlubeanConfigError,
  RESOLVED_PLAN_BUILTIN_DEFAULTS as DEFAULTS,
  resolveRunPlan,
  type CliProfileOverrides,
  type GlubeanProjectConfigV1,
} from "./config.js";

function makeConfig(overrides?: Partial<GlubeanProjectConfigV1>): GlubeanProjectConfigV1 {
  return {
    version: 1,
    suites: {
      tests: { target: "./tests", kinds: ["test"] },
      contracts: { target: "./contracts", kinds: ["contract"] },
    },
    profiles: {
      local: { suites: ["tests"] },
      ci: {
        suites: ["contracts", "tests"],
        selection: { excludeTags: ["manual"], tagMode: "or" },
        execution: { failFast: true, concurrency: 2 },
        reporters: { console: "summary", junit: ".glubean/junit.xml" },
      },
    },
    ...overrides,
  };
}

describe("resolveRunPlan", () => {
  describe("profile resolution", () => {
    it("returns plan with config path + profile name", () => {
      const config = makeConfig();
      const plan = resolveRunPlan(config, "/abs/glubean.yaml", "local");
      expect(plan.profile).toBe("local");
      expect(plan.configPath).toBe("/abs/glubean.yaml");
    });

    it("expands profile.suites name list to full SuiteConfig+name objects", () => {
      const config = makeConfig();
      const plan = resolveRunPlan(config, "/p", "ci");
      expect(plan.suites).toEqual([
        { name: "contracts", target: "./contracts", kinds: ["contract"] },
        { name: "tests", target: "./tests", kinds: ["test"] },
      ]);
    });

    it("throws on missing profile with list of available", () => {
      const config = makeConfig();
      expect(() => resolveRunPlan(config, "/p", "missing")).toThrow(
        GlubeanConfigError,
      );
      expect(() => resolveRunPlan(config, "/p", "missing")).toThrow(
        /Available profiles: ci, local/,
      );
    });

    it('throws with "(none defined)" when config has zero profiles', () => {
      const config = makeConfig({ profiles: {} });
      expect(() => resolveRunPlan(config, "/p", "anything")).toThrow(
        /\(none defined\)/,
      );
    });
  });

  describe("4-layer merge: builtin → defaults → profile → CLI", () => {
    it("uses builtin defaults when nothing else sets a field", () => {
      const config = makeConfig();
      const plan = resolveRunPlan(config, "/p", "local");
      expect(plan.selection.tagMode).toBe(DEFAULTS.selection.tagMode);
      expect(plan.execution.timeoutMs).toBe(DEFAULTS.execution.timeoutMs);
      expect(plan.execution.concurrency).toBe(DEFAULTS.execution.concurrency);
      expect(plan.capabilities.browser).toBe(false);
      expect(plan.reporters.console).toBe("detailed");
      expect(plan.envFile).toBe(".env");
    });

    it("config.defaults overrides builtin", () => {
      const config = makeConfig({
        defaults: {
          envFile: ".env.test",
          execution: { timeoutMs: 60000, concurrency: 8 },
        },
      });
      const plan = resolveRunPlan(config, "/p", "local");
      expect(plan.envFile).toBe(".env.test");
      expect(plan.execution.timeoutMs).toBe(60000);
      expect(plan.execution.concurrency).toBe(8);
    });

    it("profile overrides config.defaults", () => {
      const config = makeConfig({
        defaults: { execution: { failFast: false, concurrency: 4 } },
      });
      const plan = resolveRunPlan(config, "/p", "ci");
      // ci profile sets failFast: true, concurrency: 2
      expect(plan.execution.failFast).toBe(true);
      expect(plan.execution.concurrency).toBe(2);
    });

    it("CLI override beats profile + defaults + builtin", () => {
      const config = makeConfig({
        defaults: { execution: { concurrency: 4 } },
      });
      const cli: CliProfileOverrides = { concurrency: 16, failFast: false };
      const plan = resolveRunPlan(config, "/p", "ci", cli);
      expect(plan.execution.concurrency).toBe(16);
      expect(plan.execution.failFast).toBe(false);
    });
  });

  describe("arrays REPLACE per layer (not concat)", () => {
    it("CLI tags fully replace profile tags", () => {
      const config = makeConfig({
        profiles: {
          ci: { suites: ["tests"], selection: { tags: ["smoke", "fast"] } },
        },
      });
      const plan = resolveRunPlan(config, "/p", "ci", { tags: ["nightly"] });
      expect(plan.selection.tags).toEqual(["nightly"]);
    });

    it("CLI excludeTags fully replace profile excludeTags", () => {
      const config = makeConfig({
        profiles: {
          ci: {
            suites: ["tests"],
            selection: { excludeTags: ["manual", "destructive"] },
          },
        },
      });
      const plan = resolveRunPlan(config, "/p", "ci", { excludeTags: ["slow"] });
      expect(plan.selection.excludeTags).toEqual(["slow"]);
    });
  });

  describe("failAfter null preservation", () => {
    it("explicit null in profile is preserved (not coalesced to builtin)", () => {
      const config = makeConfig({
        defaults: { execution: { failAfter: 5 } },
        profiles: {
          ci: { suites: ["tests"], execution: { failAfter: null } },
        },
      });
      const plan = resolveRunPlan(config, "/p", "ci");
      expect(plan.execution.failAfter).toBe(null);
    });

    it("explicit null in defaults is preserved when profile has nothing", () => {
      const config = makeConfig({
        defaults: { execution: { failAfter: null } },
        profiles: { ci: { suites: ["tests"] } },
      });
      const plan = resolveRunPlan(config, "/p", "ci");
      expect(plan.execution.failAfter).toBe(null);
    });

    it("CLI null beats profile number", () => {
      const config = makeConfig({
        profiles: { ci: { suites: ["tests"], execution: { failAfter: 5 } } },
      });
      const plan = resolveRunPlan(config, "/p", "ci", { failAfter: null });
      expect(plan.execution.failAfter).toBe(null);
    });
  });

  describe("reporters: per-channel override (NOT full dict replacement)", () => {
    it("CLI consoleReporter overrides only the console channel", () => {
      const config = makeConfig({
        profiles: {
          ci: {
            suites: ["tests"],
            reporters: {
              console: "summary",
              junit: ".glubean/junit.xml",
              resultJson: ".glubean/results/ci.json",
            },
          },
        },
      });
      const plan = resolveRunPlan(config, "/p", "ci", {
        consoleReporter: "detailed",
      });
      expect(plan.reporters.console).toBe("detailed");
      // junit + resultJson preserved from profile
      expect(plan.reporters.junit).toBe(".glubean/junit.xml");
      expect(plan.reporters.resultJson).toBe(".glubean/results/ci.json");
    });

    it("CLI junit override replaces only the junit path (Phase 3 task 6)", () => {
      const config = makeConfig({
        profiles: {
          ci: {
            suites: ["tests"],
            reporters: {
              console: "summary",
              junit: ".glubean/junit.xml",
              resultJson: ".glubean/results/ci.json",
            },
          },
        },
      });
      const plan = resolveRunPlan(config, "/p", "ci", {
        junit: "custom/out.junit.xml",
      });
      expect(plan.reporters.junit).toBe("custom/out.junit.xml");
      expect(plan.reporters.console).toBe("summary");
      expect(plan.reporters.resultJson).toBe(".glubean/results/ci.json");
    });

    it("CLI resultJson override replaces only the resultJson path (Phase 3 task 6)", () => {
      const config = makeConfig({
        profiles: {
          ci: {
            suites: ["tests"],
            reporters: {
              console: "summary",
              junit: ".glubean/junit.xml",
              resultJson: ".glubean/results/ci.json",
            },
          },
        },
      });
      const plan = resolveRunPlan(config, "/p", "ci", {
        resultJson: "custom/out.result.json",
      });
      expect(plan.reporters.resultJson).toBe("custom/out.result.json");
      expect(plan.reporters.console).toBe("summary");
      expect(plan.reporters.junit).toBe(".glubean/junit.xml");
    });

    it("CLI junit + resultJson combined override leaves console untouched", () => {
      const config = makeConfig({
        profiles: {
          ci: {
            suites: ["tests"],
            reporters: {
              console: "summary",
              junit: ".glubean/junit.xml",
              resultJson: ".glubean/results/ci.json",
            },
          },
        },
      });
      const plan = resolveRunPlan(config, "/p", "ci", {
        junit: "a.xml",
        resultJson: "a.json",
      });
      expect(plan.reporters).toMatchObject({
        console: "summary",
        junit: "a.xml",
        resultJson: "a.json",
      });
    });
  });

  describe("trace overrides + upload CLI (codex round-2 P2 fix)", () => {
    it("CLI inferSchema = true overrides profile + defaults", () => {
      const config = makeConfig({
        defaults: { reporters: { inferSchema: false } },
      });
      const plan = resolveRunPlan(config, "/p", "local", { inferSchema: true });
      expect(plan.reporters.inferSchema).toBe(true);
    });

    it("CLI truncateArrays = true overrides profile", () => {
      const config = makeConfig({
        profiles: {
          ci: { suites: ["tests"], reporters: { truncateArrays: false } },
        },
      });
      const plan = resolveRunPlan(config, "/p", "ci", { truncateArrays: true });
      expect(plan.reporters.truncateArrays).toBe(true);
    });

    it("CLI uploadEnabled = true forces upload on profile without it", () => {
      const config = makeConfig();
      const plan = resolveRunPlan(config, "/p", "local", { uploadEnabled: true });
      expect(plan.upload).toEqual({ enabled: true });
    });

    it("CLI uploadEnabled = true preserves profile.projectAlias", () => {
      const config = makeConfig({
        profiles: {
          "public-demo": {
            suites: ["tests"],
            upload: { enabled: false, projectAlias: "alias-x" },
          },
        },
      });
      const plan = resolveRunPlan(config, "/p", "public-demo", {
        uploadEnabled: true,
      });
      expect(plan.upload).toEqual({ enabled: true, projectAlias: "alias-x" });
    });

    it("CLI uploadEnabled = false force-disables a profile that had upload enabled", () => {
      const config = makeConfig({
        profiles: {
          "public-demo": {
            suites: ["tests"],
            upload: { enabled: true, projectAlias: "alias-x" },
          },
        },
      });
      const plan = resolveRunPlan(config, "/p", "public-demo", {
        uploadEnabled: false,
      });
      expect(plan.upload?.enabled).toBe(false);
      expect(plan.upload?.projectAlias).toBe("alias-x");
    });
  });

  describe("redaction format passthrough (codex round-1 P2 fix)", () => {
    it('honors replacementFormat: "simple"', () => {
      const config = makeConfig({
        defaults: { redaction: { replacementFormat: "simple" } },
      });
      const plan = resolveRunPlan(config, "/p", "local");
      expect(plan.redaction.replacementFormat).toBe("simple");
    });

    it('honors replacementFormat: "labeled"', () => {
      const config = makeConfig({
        defaults: { redaction: { replacementFormat: "labeled" } },
      });
      const plan = resolveRunPlan(config, "/p", "local");
      expect(plan.redaction.replacementFormat).toBe("labeled");
    });

    it('honors replacementFormat: "partial"', () => {
      const config = makeConfig({
        defaults: { redaction: { replacementFormat: "partial" } },
      });
      const plan = resolveRunPlan(config, "/p", "local");
      expect(plan.redaction.replacementFormat).toBe("partial");
    });

    it("resolves defaults.redaction extras (sensitiveKeys / customPatterns) into the plan", () => {
      const config = makeConfig({
        defaults: {
          redaction: {
            sensitiveKeys: ["x-internal-token"],
            customPatterns: [{ name: "ssn", regex: "\\d{3}-\\d{2}-\\d{4}" }],
          },
        },
      });
      const plan = resolveRunPlan(config, "/p", "local");
      expect(plan.redaction.globalRules.sensitiveKeys).toContain("x-internal-token");
      expect(plan.redaction.globalRules.customPatterns).toEqual(
        expect.arrayContaining([{ name: "ssn", regex: "\\d{3}-\\d{2}-\\d{4}" }]),
      );
    });
  });

  describe("thresholds (plan 06 P1 — defaults ∪ profile, profile wins per metric)", () => {
    it("defaults to {} when none declared", () => {
      const plan = resolveRunPlan(makeConfig(), "/p", "local");
      expect(plan.thresholds).toEqual({});
    });

    it("passes through defaults.thresholds", () => {
      const config = makeConfig({
        defaults: { thresholds: { http_duration_ms: { p95: "<200" } } },
      });
      const plan = resolveRunPlan(config, "/p", "local");
      expect(plan.thresholds).toEqual({ http_duration_ms: { p95: "<200" } });
    });

    it("merges defaults + profile, profile overrides on metric-key collision", () => {
      const config = makeConfig({
        defaults: {
          thresholds: { http_duration_ms: { p95: "<500" }, error_rate: "<0.05" },
        },
        profiles: {
          local: { suites: ["tests"] },
          ci: {
            suites: ["tests"],
            thresholds: { http_duration_ms: { p95: "<200", avg: "<100" } },
          },
        },
      });
      const plan = resolveRunPlan(config, "/p", "ci");
      // http_duration_ms fully replaced by profile (no deep-merge of avg into defaults)
      expect(plan.thresholds.http_duration_ms).toEqual({ p95: "<200", avg: "<100" });
      // error_rate inherited from defaults (profile didn't touch it)
      expect(plan.thresholds.error_rate).toBe("<0.05");
    });
  });

  describe("upload (per-profile)", () => {
    it("preserves profile upload directive", () => {
      const config = makeConfig({
        profiles: {
          "public-demo": {
            suites: ["tests"],
            upload: { enabled: true, projectAlias: "demo-alias" },
          },
        },
      });
      const plan = resolveRunPlan(config, "/p", "public-demo");
      expect(plan.upload).toEqual({ enabled: true, projectAlias: "demo-alias" });
    });

    it("omits upload when profile has none", () => {
      const config = makeConfig();
      const plan = resolveRunPlan(config, "/p", "local");
      expect(plan.upload).toBeUndefined();
    });
  });

  describe("CLI --suite override (Phase 3 task 2)", () => {
    it("filters profile suites to a subset when override is given", () => {
      const config = makeConfig();
      const overrides: CliProfileOverrides = { suites: ["contracts"] };
      const plan = resolveRunPlan(config, "/p", "ci", overrides);
      expect(plan.suites.map((s) => s.name)).toEqual(["contracts"]);
    });

    it("preserves CLI-given order (not profile.suites order)", () => {
      const config = makeConfig();
      const overrides: CliProfileOverrides = { suites: ["tests", "contracts"] };
      const plan = resolveRunPlan(config, "/p", "ci", overrides);
      expect(plan.suites.map((s) => s.name)).toEqual(["tests", "contracts"]);
    });

    it("falls back to profile.suites when override list is empty", () => {
      const config = makeConfig();
      const overrides: CliProfileOverrides = { suites: [] };
      const plan = resolveRunPlan(config, "/p", "ci", overrides);
      expect(plan.suites.map((s) => s.name)).toEqual(["contracts", "tests"]);
    });

    it("throws when override names a suite NOT in profile.suites", () => {
      const config = makeConfig();
      const overrides: CliProfileOverrides = { suites: ["explore"] };
      expect(() => resolveRunPlan(config, "/p", "ci", overrides)).toThrow(
        GlubeanConfigError,
      );
    });

    it("throws with all unknown names enumerated", () => {
      const config = makeConfig();
      const overrides: CliProfileOverrides = {
        suites: ["contracts", "explore", "phantom"],
      };
      try {
        resolveRunPlan(config, "/p", "ci", overrides);
        expect.fail("expected throw");
      } catch (err) {
        expect((err as Error).message).toMatch(/explore, phantom/);
      }
    });
  });
});
