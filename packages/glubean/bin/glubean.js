#!/usr/bin/env node
// Local-bin delegation (defense in depth for version-skew).
//
// When a project has its own `glubean` install in `node_modules/.bin/`, npm /
// pnpm / yarn run it directly via PATH and the local copy executes. But when
// a user runs the global `glubean` from a project root that ALSO has a local
// install — e.g. they typed `glubean ...` directly instead of via `npm test`
// — the global binary executes against the project's `@glubean/sdk`, which
// may be a different version. Some non-spawn CLI commands (`glubean scan`,
// `glubean init`, `glubean contracts`, `glubean validate-metadata`,
// `glubean migrate`) don't go through `TestExecutor.run()`'s project-local
// runner resolution, so they would silently use the global's bundled SDK and
// drift from the project's pinned version.
//
// Fix: if a project-local `glubean` is reachable from `process.cwd()`, exec it
// and exit. Otherwise fall through to the global. Standard pattern used by
// jest, vitest, eslint, pnpm.
//
// Escape hatches:
//   * GLUBEAN_NO_LOCAL_BIN_DELEGATE=1 — skip delegation for unusual setups
//   * --inspect / --inspect-brk (via execArgv or NODE_OPTIONS) — skip
//     delegation so the inspector socket isn't lost in the spawned child

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const selfPath = realpathSync(fileURLToPath(import.meta.url));
const projectCwd = process.cwd();

const optOut = process.env["GLUBEAN_NO_LOCAL_BIN_DELEGATE"] === "1";

// Inspector guard: re-exec drops the debug socket. Both execArgv and
// NODE_OPTIONS can carry --inspect / --inspect-brk (with optional =port).
const inspectorPattern = /--inspect(-brk)?(?=\s|=|$)/;
const debugging =
  process.execArgv.some((a) => inspectorPattern.test(a)) ||
  inspectorPattern.test(process.env["NODE_OPTIONS"] ?? "");

let localBinPath;
if (!optOut && !debugging) {
  try {
    // Root the require at a stub inside projectCwd — NOT at import.meta.url
    // (which is the global install location). With cwd-rooted resolution we
    // walk the project's node_modules chain and avoid resolving back to the
    // global install via self-reference.
    const req = createRequire(`${projectCwd}/__glubean_local_bin_stub__.js`);
    localBinPath = realpathSync(req.resolve("glubean/bin/glubean.js"));
  } catch {
    // No local install — fall through to global.
  }
}

if (localBinPath && localBinPath !== selfPath) {
  const result = spawnSync(
    process.execPath,
    [localBinPath, ...process.argv.slice(2)],
    { stdio: "inherit", env: process.env },
  );
  process.exit(result.status ?? 1);
}

await import("@glubean/cli");
