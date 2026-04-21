import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  __resetBootstrapForTesting,
  bootstrap,
  discoverSetupFile,
} from "./bootstrap.js";

// Each test gets its own isolated temp directory.
let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "glubean-bootstrap-test-"));
  __resetBootstrapForTesting();
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("discoverSetupFile", () => {
  test("returns undefined when no setup file exists", () => {
    expect(discoverSetupFile(tmpRoot, tmpRoot)).toBeUndefined();
  });

  test("finds glubean.setup.ts in the start directory", async () => {
    const setupPath = join(tmpRoot, "glubean.setup.ts");
    await writeFile(setupPath, "// empty\n");

    expect(discoverSetupFile(tmpRoot, tmpRoot)).toBe(setupPath);
  });

  test("finds glubean.setup.js when .ts is absent", async () => {
    const setupPath = join(tmpRoot, "glubean.setup.js");
    await writeFile(setupPath, "// empty\n");

    expect(discoverSetupFile(tmpRoot, tmpRoot)).toBe(setupPath);
  });

  test("prefers .ts over .js when both exist", async () => {
    await writeFile(join(tmpRoot, "glubean.setup.ts"), "// ts\n");
    await writeFile(join(tmpRoot, "glubean.setup.js"), "// js\n");

    expect(discoverSetupFile(tmpRoot, tmpRoot)).toBe(
      join(tmpRoot, "glubean.setup.ts"),
    );
  });

  test("walks up from a subdirectory to find the setup file", async () => {
    const setupPath = join(tmpRoot, "glubean.setup.ts");
    await writeFile(setupPath, "// empty\n");

    const subDir = join(tmpRoot, "packages", "foo", "tests");
    await mkdir(subDir, { recursive: true });

    expect(discoverSetupFile(subDir, tmpRoot)).toBe(setupPath);
  });

  test("stops at stopDir without ascending further", async () => {
    // Setup file lives ABOVE the stopDir — should NOT be found.
    await writeFile(join(tmpRoot, "glubean.setup.ts"), "// empty\n");
    const subDir = join(tmpRoot, "subpackage");
    await mkdir(subDir, { recursive: true });

    expect(discoverSetupFile(subDir, subDir)).toBeUndefined();
  });
});

describe("bootstrap", () => {
  test("no-op when no setup file exists (silent)", async () => {
    await expect(bootstrap(tmpRoot, tmpRoot)).resolves.toBeUndefined();
  });

  test("imports the setup file and awaits its top-level side effects", async () => {
    // The setup file writes a marker file as a proxy for "ran top-level code".
    // Writing synchronously via node:fs in top-level ESM requires a static-
    // resolvable module; simplest portable trick: write the marker from the
    // setup file via dynamic import of node:fs.
    const markerPath = join(tmpRoot, "ran.marker");
    const setupPath = join(tmpRoot, "glubean.setup.mjs");
    await writeFile(
      setupPath,
      `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(markerPath)}, "ran\\n");
`,
    );

    await bootstrap(tmpRoot, tmpRoot);

    const { existsSync } = await import("node:fs");
    expect(existsSync(markerPath)).toBe(true);
  });

  test("is idempotent — second call with same root does not re-import", async () => {
    // Counter file incremented each time the setup file runs. Confirms
    // idempotency via "file was only written once" semantics.
    const counterPath = join(tmpRoot, "counter");
    const setupPath = join(tmpRoot, "glubean.setup.mjs");
    await writeFile(
      setupPath,
      `
import { writeFileSync, existsSync, readFileSync } from "node:fs";
const prev = existsSync(${JSON.stringify(counterPath)})
  ? parseInt(readFileSync(${JSON.stringify(counterPath)}, "utf8"), 10)
  : 0;
writeFileSync(${JSON.stringify(counterPath)}, String(prev + 1));
`,
    );

    await bootstrap(tmpRoot, tmpRoot);
    await bootstrap(tmpRoot, tmpRoot);
    await bootstrap(tmpRoot, tmpRoot);

    const { readFileSync } = await import("node:fs");
    // Setup file side-effect ran exactly once (1); Node's ESM module cache
    // would also make this 1 even without our explicit Set, but the `loaded`
    // Set short-circuits before `import()` to avoid repeated URL resolution.
    expect(readFileSync(counterPath, "utf8")).toBe("1");
  });

  test("propagates errors from the setup file", async () => {
    const setupPath = join(tmpRoot, "glubean.setup.mjs");
    await writeFile(
      setupPath,
      `throw new Error("setup blew up");`,
    );

    await expect(bootstrap(tmpRoot, tmpRoot)).rejects.toThrow("setup blew up");
  });

  test("does not retry a setup file that threw on first import (within same process)", async () => {
    // Arrange: setup file always throws. First bootstrap() should throw and
    // record the path as loaded; second bootstrap() should NOT re-import.
    const setupPath = join(tmpRoot, "glubean.setup.mjs");
    await writeFile(
      setupPath,
      `throw new Error("persistent failure");`,
    );

    await expect(bootstrap(tmpRoot, tmpRoot)).rejects.toThrow(
      "persistent failure",
    );

    // Second call: we expect silent no-op. The path was recorded as loaded
    // BEFORE the import was awaited, so we don't retry — consistent with
    // installPlugin's "failed setup is process-unrecoverable" stance.
    await expect(bootstrap(tmpRoot, tmpRoot)).resolves.toBeUndefined();
  });
});
