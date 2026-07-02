/**
 * GLU-88 regression tests — `.glubean/active-env` resolution.
 *
 * Root cause: `resolveEnvFileName` is a persistent, un-TTL'd, un-warned
 * sticky lookup — a `glubean env use prod` run once (e.g. to debug
 * something) stays in effect for every future `glubean run` / `sync` /
 * `load` in that directory until someone remembers `glubean env reset`.
 * GLU-70's verification run left `.glubean/active-env` = "prod" in a demo
 * checkout; a later, unrelated `glubean run --upload` (no `--env-file`)
 * silently picked up `.env.prod` and shipped a passed run to the real
 * production project (no delete API to undo it).
 *
 * `run`/`ci run --help` also claimed "default: .env" with no mention of
 * this fallback — the documented default and the actual default diverged.
 *
 * Fix: `resolveEnvFileName` still honors `.glubean/active-env` for ordinary
 * names (that's the whole point of `glubean env use`) but throws
 * `SensitiveActiveEnvError` instead of silently resolving a prod-like name,
 * so the caller must explicitly opt in via `--env-file` rather than
 * inherit a stale sticky state. Explicit `--env-file` is untouched — CLI
 * call sites branch on `userSpecifiedEnvFile` before ever calling this
 * function.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  clearActiveEnv,
  readActiveEnv,
  resolveEnvFileName,
  SensitiveActiveEnvError,
  writeActiveEnv,
} from "./active_env.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "glubean-active-env-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("resolveEnvFileName (GLU-88 default-selection regression)", () => {
  test("no active-env set, even with .env AND .env.prod both present on disk, resolves '.env'", async () => {
    // resolveEnvFileName never scans the directory for .env.* files — this
    // guards against a future regression that turns it into a glob/mtime
    // pick. Presence of .env.prod alone must never influence the result.
    await import("node:fs/promises").then(({ writeFile }) =>
      Promise.all([
        writeFile(join(dir, ".env"), "GLUBEAN_API_URL=http://localhost:4102\n"),
        writeFile(join(dir, ".env.prod"), "GLUBEAN_API_URL=https://platform.glubean.com\n"),
      ]),
    );
    await expect(resolveEnvFileName(dir)).resolves.toBe(".env");
  });

  test("no active-env set, no .env.* files present, resolves '.env'", async () => {
    await expect(resolveEnvFileName(dir)).resolves.toBe(".env");
  });

  test("active-env set to an ordinary name resolves '.env.<name>' (active-env normal semantics preserved)", async () => {
    await writeActiveEnv(dir, "staging");
    await expect(resolveEnvFileName(dir)).resolves.toBe(".env.staging");
  });

  test("active-env set to 'prod' throws SensitiveActiveEnvError instead of silently resolving '.env.prod'", async () => {
    await writeActiveEnv(dir, "prod");
    await expect(resolveEnvFileName(dir)).rejects.toBeInstanceOf(SensitiveActiveEnvError);
  });

  test("active-env set to 'production' (case-insensitive, whitespace-tolerant) also throws", async () => {
    await writeActiveEnv(dir, "  PRODUCTION  \n");
    await expect(resolveEnvFileName(dir)).rejects.toBeInstanceOf(SensitiveActiveEnvError);
  });

  test("SensitiveActiveEnvError message names the offending env and both escape hatches", async () => {
    await writeActiveEnv(dir, "prod");
    await expect(resolveEnvFileName(dir)).rejects.toThrow(
      /--env-file .env.prod|glubean env reset/,
    );
  });

  test("a prod-LIKE-but-distinct name (e.g. 'preprod-mirror') is NOT treated as sensitive (exact match only, no false positives)", async () => {
    await writeActiveEnv(dir, "preprod-mirror");
    await expect(resolveEnvFileName(dir)).resolves.toBe(".env.preprod-mirror");
  });

  test("clearActiveEnv resets to the safe default even after a sensitive active-env was set", async () => {
    await writeActiveEnv(dir, "prod");
    await clearActiveEnv(dir);
    await expect(readActiveEnv(dir)).resolves.toBeUndefined();
    await expect(resolveEnvFileName(dir)).resolves.toBe(".env");
  });
});
