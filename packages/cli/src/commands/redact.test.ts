/**
 * `glubean redact` — redaction-config resolution (config consolidation,
 * docs/06 P2). Redaction now comes from glubean.yaml `defaults.redaction`.
 * Security invariant: an explicit `--config` or a present-but-malformed
 * glubean.yaml must FAIL rather than silently fall back to default rules
 * (which could leave declared secrets un-redacted). Only a genuinely-absent
 * config falls back to the safe full-redaction default.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCli } from "../test-helpers.js";

const RESULT_JSON = JSON.stringify({ tests: [{ events: [] }] });

let dir: string;
let resultPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "glubean-p2-redact-"));
  resultPath = join(dir, "glubean-run.result.json");
  await writeFile(resultPath, RESULT_JSON, "utf-8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("glubean redact — config resolution", () => {
  test("no glubean.yaml → falls back to default full redaction (succeeds)", async () => {
    const { code } = await runCli(["redact", "-i", resultPath, "--stdout"], { cwd: dir });
    expect(code).toBe(0);
  });

  test("explicit --config that doesn't exist is fatal (no silent default)", async () => {
    const { code } = await runCli(
      ["redact", "-i", resultPath, "--stdout", "--config", "nope.yaml"],
      { cwd: dir },
    );
    expect(code).not.toBe(0);
  });

  test("present-but-malformed glubean.yaml is fatal", async () => {
    await writeFile(join(dir, "glubean.yaml"), "version: 1\nsuites: not-a-map\n", "utf-8");
    const { code } = await runCli(["redact", "-i", resultPath, "--stdout"], { cwd: dir });
    expect(code).not.toBe(0);
  });
});
