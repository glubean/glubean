/**
 * GLU-244: resolveLoadPlan unit tests.
 *
 * Covers: missing profile / profile with no load.plans / merge order for
 * envFile (builtin → defaults → profile → CLI) / --plan narrowing / upload
 * passthrough / unknown --plan name.
 */

import { describe, it, expect } from "vitest";
import {
  GlubeanConfigError,
  resolveLoadPlan,
  type CliLoadProfileOverrides,
  type GlubeanProjectConfigV1,
} from "./config.js";

function makeConfig(overrides?: Partial<GlubeanProjectConfigV1>): GlubeanProjectConfigV1 {
  return {
    version: 1,
    suites: {},
    profiles: {
      local: { suites: ["local-suite"] },
      perf: {
        suites: [],
        load: { plans: ["runtime-comparison", "large-json"] },
      },
    },
    load: {
      plans: {
        "runtime-comparison": { target: "./tests/load/runtime-comparison.load.ts" },
        "large-json": { target: "./tests/load/large-json.load.ts" },
      },
    },
    ...overrides,
  };
}

describe("resolveLoadPlan", () => {
  describe("profile resolution", () => {
    it("returns plan with config path + profile name + expanded plans", () => {
      const config = makeConfig();
      const plan = resolveLoadPlan(config, "/abs/glubean.yaml", "perf");
      expect(plan.profile).toBe("perf");
      expect(plan.configPath).toBe("/abs/glubean.yaml");
      expect(plan.plans).toEqual([
        { name: "runtime-comparison", target: "./tests/load/runtime-comparison.load.ts" },
        { name: "large-json", target: "./tests/load/large-json.load.ts" },
      ]);
    });

    it("throws on missing profile with list of available", () => {
      const config = makeConfig();
      expect(() => resolveLoadPlan(config, "/p", "missing")).toThrow(GlubeanConfigError);
      expect(() => resolveLoadPlan(config, "/p", "missing")).toThrow(
        /Available profiles: local, perf/,
      );
    });

    it("throws when the profile has no load.plans declared", () => {
      const config = makeConfig();
      expect(() => resolveLoadPlan(config, "/p", "local")).toThrow(
        /Profile "local" has no `load.plans` declared/,
      );
    });

    it("throws when profile.load.plans is present but empty", () => {
      const config = makeConfig({
        profiles: {
          local: { suites: ["local-suite"] },
          empty: { suites: [], load: { plans: [] } },
        },
      });
      expect(() => resolveLoadPlan(config, "/p", "empty")).toThrow(
        /Profile "empty" has no `load.plans` declared/,
      );
    });
  });

  describe("--plan narrowing", () => {
    it("narrows to a single plan when --plan matches", () => {
      const config = makeConfig();
      const plan = resolveLoadPlan(config, "/p", "perf", { plan: "large-json" });
      expect(plan.plans).toEqual([
        { name: "large-json", target: "./tests/load/large-json.load.ts" },
      ]);
    });

    it("throws when --plan isn't in the profile's load.plans", () => {
      const config = makeConfig();
      expect(() =>
        resolveLoadPlan(config, "/p", "perf", { plan: "nonexistent" }),
      ).toThrow(/--plan "nonexistent" is not declared in profile "perf"/);
    });
  });

  describe("envFile merge: builtin → defaults → profile → CLI", () => {
    it("falls back to the builtin default (.env) when nothing sets it", () => {
      const config = makeConfig();
      const plan = resolveLoadPlan(config, "/p", "perf");
      expect(plan.envFile).toBe(".env");
    });

    it("config.defaults.envFile overrides the builtin", () => {
      const config = makeConfig({ defaults: { envFile: ".env.defaults" } });
      const plan = resolveLoadPlan(config, "/p", "perf");
      expect(plan.envFile).toBe(".env.defaults");
    });

    it("profile.envFile overrides config.defaults", () => {
      const config = makeConfig({
        defaults: { envFile: ".env.defaults" },
        profiles: {
          local: { suites: ["local-suite"] },
          perf: {
            suites: [],
            envFile: ".env.staging",
            load: { plans: ["runtime-comparison"] },
          },
        },
      });
      const plan = resolveLoadPlan(config, "/p", "perf");
      expect(plan.envFile).toBe(".env.staging");
    });

    it("CLI --env-file override beats profile.envFile", () => {
      const config = makeConfig({
        profiles: {
          local: { suites: ["local-suite"] },
          perf: {
            suites: [],
            envFile: ".env.staging",
            load: { plans: ["runtime-comparison"] },
          },
        },
      });
      const cli: CliLoadProfileOverrides = { envFile: ".env.cli" };
      const plan = resolveLoadPlan(config, "/p", "perf", cli);
      expect(plan.envFile).toBe(".env.cli");
    });
  });

  describe("envFileExplicit (codex GLU-244 R2 P2 — distinguish explicit `.env` from no override)", () => {
    it("is false when nothing sets envFile (falls through to the builtin default)", () => {
      const config = makeConfig();
      const plan = resolveLoadPlan(config, "/p", "perf");
      expect(plan.envFile).toBe(".env");
      expect(plan.envFileExplicit).toBe(false);
    });

    it("is true when a profile explicitly sets envFile to the SAME string as the builtin default", () => {
      // The bug this guards: `envFile !== ".env"` can't tell "profile
      // explicitly chose .env" apart from "nothing set it" — both produce
      // the string ".env". `envFileExplicit` must still read true here.
      const config = makeConfig({
        profiles: {
          local: { suites: ["local-suite"] },
          perf: {
            suites: [],
            envFile: ".env",
            load: { plans: ["runtime-comparison"] },
          },
        },
      });
      const plan = resolveLoadPlan(config, "/p", "perf");
      expect(plan.envFile).toBe(".env");
      expect(plan.envFileExplicit).toBe(true);
    });

    it("is true when only config.defaults.envFile is set (even to '.env')", () => {
      const config = makeConfig({ defaults: { envFile: ".env" } });
      const plan = resolveLoadPlan(config, "/p", "perf");
      expect(plan.envFileExplicit).toBe(true);
    });

    it("is true when only the CLI --env-file override is given", () => {
      const config = makeConfig();
      const plan = resolveLoadPlan(config, "/p", "perf", { envFile: ".env" });
      expect(plan.envFileExplicit).toBe(true);
    });
  });

  describe("upload passthrough (profile.upload, GLU-244 reuses run's shape)", () => {
    it("carries profile.upload through unchanged", () => {
      const config = makeConfig({
        profiles: {
          local: { suites: ["local-suite"] },
          perf: {
            suites: [],
            load: { plans: ["runtime-comparison"] },
            upload: { projectId: "prj_x", targetId: "tgt_x", tokenEnv: "TOKEN_X" },
          },
        },
      });
      const plan = resolveLoadPlan(config, "/p", "perf");
      expect(plan.upload).toEqual({ projectId: "prj_x", targetId: "tgt_x", tokenEnv: "TOKEN_X" });
    });

    it("omits upload when the profile has none", () => {
      const config = makeConfig();
      const plan = resolveLoadPlan(config, "/p", "perf");
      expect(plan.upload).toBeUndefined();
    });
  });
});
