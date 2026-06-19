/**
 * Phase 1 sub-task C: loadProjectConfigV1 unit tests.
 *
 * Covers: file missing / YAML parse / schema validation hard-errors / valid
 * canonical config round-trip / unknown-key rejection / profile→suite cross-ref.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GlubeanConfigError,
  loadProjectConfigV1,
} from "./config.js";

async function withTempDir<T>(
  files: Record<string, string>,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "glubean-v1-loader-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      await writeFile(join(dir, path), content, "utf-8");
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("loadProjectConfigV1", () => {
  describe("happy path", () => {
    it("loads a valid canonical config", async () => {
      const yaml = `
version: 1
suites:
  tests:
    target: ./tests
    kinds: [test]
  contracts:
    target: ./contracts
    kinds: [contract, flow]
profiles:
  local:
    suites: [tests]
  ci:
    suites: [contracts, tests]
    selection:
      excludeTags: [manual, destructive]
      tagMode: or
    execution:
      failFast: true
      concurrency: 2
    reporters:
      console: summary
      junit: .glubean/results/junit.xml
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        const { config, configPath } = await loadProjectConfigV1(dir);
        expect(config.version).toBe(1);
        expect(configPath).toBe(join(dir, "glubean.yaml"));
        expect(Object.keys(config.suites).sort()).toEqual(["contracts", "tests"]);
        expect(config.suites.contracts.target).toBe("./contracts");
        expect(config.suites.contracts.kinds).toEqual(["contract", "flow"]);
        expect(Object.keys(config.profiles).sort()).toEqual(["ci", "local"]);
        expect(config.profiles.ci.selection?.excludeTags).toEqual([
          "manual",
          "destructive",
        ]);
        expect(config.profiles.ci.execution?.failFast).toBe(true);
        expect(config.profiles.ci.reporters?.junit).toBe(
          ".glubean/results/junit.xml",
        );
      });
    });

    it("rejects kinds: [load] — load runs via `glubean load`, not a profile suite (M4)", async () => {
      const yaml = `
version: 1
suites:
  perf:
    target: ./load
    kinds: [load]
profiles:
  bench:
    suites: [perf]
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(/Invalid kind "load"/);
      });
    });

    it("accepts defaults block", async () => {
      const yaml = `
version: 1
defaults:
  envFile: .env.test
  execution:
    timeoutMs: 60000
    concurrency: 4
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  local: { suites: [tests] }
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        const { config } = await loadProjectConfigV1(dir);
        expect(config.defaults?.envFile).toBe(".env.test");
        expect(config.defaults?.execution?.timeoutMs).toBe(60000);
      });
    });

    it("accepts upload block with projectId + tokenEnv", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  public-demo:
    suites: [tests]
    upload:
      enabled: true
      projectId: prj_abc123
      tokenEnv: GLUBEAN_TOKEN_DEMO
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        const { config } = await loadProjectConfigV1(dir);
        expect(config.profiles["public-demo"].upload).toEqual({
          enabled: true,
          projectId: "prj_abc123",
          tokenEnv: "GLUBEAN_TOKEN_DEMO",
        });
      });
    });

    it("maps deprecated upload.projectAlias to projectId", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  public-demo:
    suites: [tests]
    upload:
      enabled: true
      projectAlias: legacy-alias
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        const { config } = await loadProjectConfigV1(dir);
        expect(config.profiles["public-demo"].upload?.projectId).toBe("legacy-alias");
      });
    });

    it("rejects an unknown key in the upload block", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  public-demo:
    suites: [tests]
    upload:
      enabled: true
      bogusKey: x
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(/Unknown key.*bogusKey/);
      });
    });

    it("rejects a blank upload.tokenEnv (would silently fall back to GLUBEAN_TOKEN)", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  public-demo:
    suites: [tests]
    upload:
      enabled: true
      tokenEnv: ""
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(/tokenEnv.*non-empty/);
      });
    });

    it("accepts thresholds in defaults + profile (object rules + shorthand string)", async () => {
      const yaml = `
version: 1
defaults:
  thresholds:
    error_rate: "<0.05"
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  ci:
    suites: [tests]
    thresholds:
      http_duration_ms: { p95: "<200", avg: "<100" }
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        const { config } = await loadProjectConfigV1(dir);
        expect(config.defaults?.thresholds).toEqual({ error_rate: "<0.05" });
        expect(config.profiles.ci.thresholds).toEqual({
          http_duration_ms: { p95: "<200", avg: "<100" },
        });
      });
    });
  });

  describe("thresholds validation (plan 06 P1)", () => {
    it("hard-errors on an unknown aggregation key", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  ci:
    suites: [tests]
    thresholds:
      http_duration_ms: { pXX: "<200" }
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(/Unknown key.*pXX/);
      });
    });

    it("hard-errors when an expression is not a string", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  ci:
    suites: [tests]
    thresholds:
      http_duration_ms: { p95: 200 }
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(/p95.*expression string/);
      });
    });
  });

  describe("mcp config (plan 06 P3 — MCP trace settings)", () => {
    it("accepts a top-level mcp.trace block", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  local: { suites: [tests] }
mcp:
  trace:
    keepResponseHeaders: [content-type, x-request-id]
    keepRequestHeaders: [authorization]
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        const { config } = await loadProjectConfigV1(dir);
        expect(config.mcp?.trace?.keepResponseHeaders).toEqual(["content-type", "x-request-id"]);
        expect(config.mcp?.trace?.keepRequestHeaders).toEqual(["authorization"]);
      });
    });

    it("hard-errors on an unknown key under mcp.trace", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  local: { suites: [tests] }
mcp:
  trace:
    keepEverything: true
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(/Unknown key.*keepEverything/);
      });
    });
  });

  describe("file-level errors", () => {
    it("hard-errors when glubean.yaml is missing", async () => {
      await withTempDir({}, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(
          GlubeanConfigError,
        );
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(/not found/);
      });
    });

    it("hard-errors on invalid YAML", async () => {
      await withTempDir(
        { "glubean.yaml": "version: 1\n  bad: indent: oops" },
        async (dir) => {
          await expect(loadProjectConfigV1(dir)).rejects.toThrow(
            GlubeanConfigError,
          );
        },
      );
    });

    it("rejects non-mapping top-level (array)", async () => {
      await withTempDir({ "glubean.yaml": "- 1\n- 2\n" }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(
          /must contain a top-level mapping/,
        );
      });
    });
  });

  describe("schema validation hard-errors", () => {
    it("requires version: 1", async () => {
      await withTempDir(
        { "glubean.yaml": "suites: {}\nprofiles: {}\n" },
        async (dir) => {
          await expect(loadProjectConfigV1(dir)).rejects.toThrow(/version/);
        },
      );
    });

    it("rejects version other than 1", async () => {
      await withTempDir(
        { "glubean.yaml": "version: 2\nsuites: {}\nprofiles: {}\n" },
        async (dir) => {
          await expect(loadProjectConfigV1(dir)).rejects.toThrow(/version.*1/);
        },
      );
    });

    it("hard-errors on unknown top-level key (was a warning in legacy loader)", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  local: { suites: [tests] }
typo_key_should_fail: 42
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(
          /Unknown key.*typo_key_should_fail/,
        );
      });
    });

    it("hard-errors on unknown nested suite key", async () => {
      const yaml = `
version: 1
suites:
  tests:
    target: ./tests
    kinds: [test]
    typo: wrong
profiles:
  local: { suites: [tests] }
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(
          /Unknown key.*suites\.tests.*typo/,
        );
      });
    });

    it("hard-errors on unknown selection key", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  ci:
    suites: [tests]
    selection:
      tag: wrong
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(/Unknown key.*tag/);
      });
    });

    it("requires suite.target", async () => {
      const yaml = `
version: 1
suites:
  tests: { kinds: [test] }
profiles:
  local: { suites: [tests] }
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(/target/);
      });
    });

    it("requires suite.kinds non-empty", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [] }
profiles:
  local: { suites: [tests] }
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(/empty/);
      });
    });

    it("rejects invalid suite kind value", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test, bogus] }
profiles:
  local: { suites: [tests] }
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(
          /Invalid kind.*bogus/,
        );
      });
    });

    it("rejects tagMode other than or|and", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  ci:
    suites: [tests]
    selection:
      tagMode: xor
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(/tagMode.*or.*and/);
      });
    });

    it("rejects wrong-type field (failFast as string)", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  ci:
    suites: [tests]
    execution:
      failFast: "yes"
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(/failFast.*boolean/);
      });
    });

    it("rejects profile referencing undefined suite", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  ci:
    suites: [tests, missing-suite]
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(
          /undefined suite "missing-suite"/,
        );
      });
    });
  });

  describe("positive-integer execution numbers (codex round-3 P2 fix)", () => {
    it("rejects failAfter: 0 (would run zero tests)", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  ci:
    suites: [tests]
    execution:
      failAfter: 0
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(
          /failAfter.*positive integer/,
        );
      });
    });

    it("rejects negative failAfter", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  ci:
    suites: [tests]
    execution:
      failAfter: -1
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(
          /failAfter.*positive integer/,
        );
      });
    });

    it("rejects concurrency: 0", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  ci:
    suites: [tests]
    execution:
      concurrency: 0
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(
          /concurrency.*positive integer/,
        );
      });
    });

    it("rejects negative timeoutMs", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  ci:
    suites: [tests]
    execution:
      timeoutMs: -100
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(
          /timeoutMs.*positive integer/,
        );
      });
    });

    it("accepts failAfter: null (documented disable)", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  ci:
    suites: [tests]
    execution:
      failAfter: null
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        const { config } = await loadProjectConfigV1(dir);
        expect(config.profiles.ci.execution?.failAfter).toBe(null);
      });
    });
  });

  describe("non-finite numbers (codex round-2 P2 fix)", () => {
    it("rejects NaN concurrency", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  ci:
    suites: [tests]
    execution:
      concurrency: .nan
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(/NaN/);
      });
    });

    it("rejects Infinity timeoutMs", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  ci:
    suites: [tests]
    execution:
      timeoutMs: .inf
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(/Infinity/);
      });
    });
  });

  describe("reporters.inferSchema / truncateArrays (codex sub-task D round-3 P2 fix)", () => {
    it("accepts inferSchema + truncateArrays in profile reporters", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  ci:
    suites: [tests]
    reporters:
      console: summary
      emitFullTrace: true
      inferSchema: true
      truncateArrays: true
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        const { config } = await loadProjectConfigV1(dir);
        expect(config.profiles.ci.reporters?.inferSchema).toBe(true);
        expect(config.profiles.ci.reporters?.truncateArrays).toBe(true);
        expect(config.profiles.ci.reporters?.emitFullTrace).toBe(true);
      });
    });

    it("rejects non-boolean inferSchema", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  ci:
    suites: [tests]
    reporters:
      inferSchema: "yes"
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(
          /inferSchema.*boolean/,
        );
      });
    });
  });

  describe("defaults.redaction validation (codex round-1 P2 fix)", () => {
    it("rejects sensitiveKeys non-array", async () => {
      const yaml = `
version: 1
defaults:
  redaction:
    sensitiveKeys: "password"
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  local: { suites: [tests] }
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(
          /sensitiveKeys.*array/,
        );
      });
    });

    it("rejects sensitiveKeys with non-string element", async () => {
      const yaml = `
version: 1
defaults:
  redaction:
    sensitiveKeys: [password, 42]
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  local: { suites: [tests] }
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(
          /sensitiveKeys.*string/,
        );
      });
    });

    it("rejects customPatterns missing required name", async () => {
      const yaml = `
version: 1
defaults:
  redaction:
    customPatterns:
      - regex: "[0-9]+"
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  local: { suites: [tests] }
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(
          /customPatterns.*name.*required/,
        );
      });
    });

    it("rejects customPatterns with invalid regex", async () => {
      const yaml = `
version: 1
defaults:
  redaction:
    customPatterns:
      - { name: bad, regex: "[unclosed" }
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  local: { suites: [tests] }
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(
          /not a valid regular expression/,
        );
      });
    });

    it("rejects replacementFormat with invalid value", async () => {
      const yaml = `
version: 1
defaults:
  redaction:
    replacementFormat: typo
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  local: { suites: [tests] }
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(
          /replacementFormat.*simple.*labeled.*partial/,
        );
      });
    });

    it("accepts valid redaction config", async () => {
      const yaml = `
version: 1
defaults:
  redaction:
    sensitiveKeys: [password, ssn]
    customPatterns:
      - { name: phone, regex: "\\\\d{10}" }
    replacementFormat: labeled
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  local: { suites: [tests] }
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        const { config } = await loadProjectConfigV1(dir);
        expect(config.defaults?.redaction?.sensitiveKeys).toEqual([
          "password",
          "ssn",
        ]);
        expect(config.defaults?.redaction?.customPatterns?.[0]?.name).toBe("phone");
        expect(config.defaults?.redaction?.replacementFormat).toBe("labeled");
      });
    });
  });

  describe("selection.excludeTags", () => {
    it("parses excludeTags as string[]", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  ci:
    suites: [tests]
    selection:
      excludeTags: [manual, destructive]
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        const { config } = await loadProjectConfigV1(dir);
        expect(config.profiles.ci.selection?.excludeTags).toEqual([
          "manual",
          "destructive",
        ]);
      });
    });

    it("rejects excludeTags as non-array", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  ci:
    suites: [tests]
    selection:
      excludeTags: manual
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(/excludeTags.*array/);
      });
    });

    it("rejects excludeTags array containing non-string", async () => {
      const yaml = `
version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  ci:
    suites: [tests]
    selection:
      excludeTags: [manual, 42]
`;
      await withTempDir({ "glubean.yaml": yaml }, async (dir) => {
        await expect(loadProjectConfigV1(dir)).rejects.toThrow(
          /excludeTags.*strings/,
        );
      });
    });
  });
});
