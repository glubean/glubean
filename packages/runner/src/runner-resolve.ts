/**
 * Shared runner-resolution internals — the delicate "where does the runner
 * harness live + how do we spawn it" code, factored out of `executor.ts` so the
 * test harness (`TestExecutor`) AND the load harness (`runLoadFileInSubprocess`)
 * resolve the SAME project-local runner the SAME way.
 *
 * Three reused seams:
 *  - `resolveRunnerRoot` — the **dual-package hazard fix**: prefer the project's
 *    own `@glubean/runner` dist (so the spawned harness + the user file co-resolve
 *    the project's `@glubean/sdk`), fall back to the bundled copy with a warning.
 *    **Most delicate code in the package — change with care.**
 *  - `resolveTsxPath` — locate the tsx CLI to transform the user's TypeScript.
 *  - `prepareZeroProject` — scratch-mode (no node_modules) `--import` register +
 *    `GLUBEAN_VENDORED_ROOT` redirect + temp package.json, with a cleanup closure.
 *
 * Internal to `@glubean/runner` — not part of the public `index.ts` surface.
 */
import { existsSync, unlinkSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { createRequire } from "node:module";

// ── Project-local runner resolution (Plan 1) ────────────────────────────────

/**
 * Walk up from a starting file path looking for the first package.json
 * whose `name` field matches `expectedName`. Layout-independent — works
 * regardless of dist/ depth.
 *
 * Returns the realpath of the package root, or undefined if not found.
 */
function findPackageRoot(startFile: string, expectedName: string): string | undefined {
  let dir = dirname(startFile);
  for (let i = 0; i < 16; i++) {
    const candidate = resolve(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
        if (pkg?.name === expectedName) {
          try {
            return realpathSync(dir);
          } catch {
            return dir;
          }
        }
      } catch {
        // corrupt / non-json; keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * Compare two version strings (numeric major.minor.patch). Returns true
 * if `a < b`. Tolerant of missing fields and non-numeric tails.
 */
function semverLt(a: string, b: string): boolean {
  const parse = (s: string) =>
    s.split(/[.\-+]/).slice(0, 3).map((p) => parseInt(p, 10) || 0);
  const [aMajor, aMinor, aPatch] = parse(a);
  const [bMajor, bMinor, bPatch] = parse(b);
  if (aMajor !== bMajor) return aMajor < bMajor;
  if (aMinor !== bMinor) return aMinor < bMinor;
  return aPatch < bPatch;
}

/** Diagnostic warning emitted by the executor's runner resolver. */
export interface RunnerWarning {
  /** Human-readable message. */
  message: string;
  /** Stable code for filtering / consumer dedupe. */
  code: "runner_fallback_no_project" | "runner_fallback_no_dist" | "runner_protocol_old" | "runner_pkg_root_not_found";
}

export interface ResolvedRunner {
  distDir: string;
  pkgRoot: string;
  source: "project" | "bundled";
  resolvedFrom?: string;
  version?: string;
  pendingWarnings: RunnerWarning[];
}

/**
 * Resolve the runner dist/ directory + package root.
 *
 * Preference: project-local `@glubean/runner` (found from `projectCwd`'s
 * `node_modules` chain). Fallback: bundled (the consumer's own runner copy).
 *
 * Returns warnings to be yielded as `{ type: "warning", ... }` events at
 * the start of every `run()` call. Always emits a warning when falling
 * back to bundled (so users see why "configure() values..." errors may
 * appear in a misconfigured project).
 */
export function resolveRunnerRoot(
  projectCwd: string,
  bundledDistDir: string,
  bundledPkgRoot: string,
): ResolvedRunner {
  const warnings: RunnerWarning[] = [];
  try {
    // Root `createRequire` at a stub path INSIDE the project cwd — not
    // at `import.meta.url` (the workspace executor file). If we use the
    // workspace URL, Node's resolver returns the workspace's own
    // `@glubean/runner` via package self-reference (the `exports` field
    // points back at itself), regardless of `paths: [projectCwd]`. With
    // a cwd-rooted stub there's no self-reference and Node walks the
    // project's node_modules chain correctly.
    const req = createRequire(resolve(projectCwd, "__glubean_resolve_stub__.js"));
    const mainEntry = req.resolve("@glubean/runner");

    const pkgRoot = findPackageRoot(mainEntry, "@glubean/runner");
    if (!pkgRoot) {
      warnings.push({
        code: "runner_pkg_root_not_found",
        message: `Could not locate @glubean/runner's package.json above ${mainEntry}; using bundled runner.`,
      });
      return {
        distDir: bundledDistDir,
        pkgRoot: bundledPkgRoot,
        source: "bundled",
        pendingWarnings: warnings,
      };
    }

    const projectDistDir = dirname(mainEntry);
    if (!existsSync(resolve(projectDistDir, "harness.js"))) {
      warnings.push({
        code: "runner_fallback_no_dist",
        message: `Project @glubean/runner at ${pkgRoot} has no built harness.js (looked in ${projectDistDir}); using bundled runner.`,
      });
      return {
        distDir: bundledDistDir,
        pkgRoot: bundledPkgRoot,
        source: "bundled",
        pendingWarnings: warnings,
      };
    }

    let version: string | undefined;
    let projectProtocol: string | undefined;
    try {
      const pkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf-8"));
      version = pkg.version;
      projectProtocol = pkg.glubeanRunnerProtocol;
    } catch {
      // best effort
    }

    // Min-protocol check: emit a warning if project's protocol is older
    // than what this consumer needs, but DON'T fall back. Using project-
    // local runner with an old protocol just means some new env channels
    // may be silently ignored. Falling back to bundled when the project
    // has its own SDK would re-introduce the dual-package hazard the
    // whole fix exists to prevent. Project-local wins; missing features
    // are surfaced via warning so the user knows to upgrade.
    try {
      const bundledPkg = JSON.parse(
        readFileSync(resolve(bundledPkgRoot, "package.json"), "utf-8"),
      );
      const bundledMin: string | undefined = bundledPkg.glubeanRunnerProtocolMinimum;
      if (bundledMin && (!projectProtocol || semverLt(projectProtocol, bundledMin))) {
        warnings.push({
          code: "runner_protocol_old",
          message:
            `Project @glubean/runner ${version ?? "<unknown>"} declares glubeanRunnerProtocol=${projectProtocol ?? "<unset>"}, ` +
            `but this consumer was built for >= ${bundledMin}. ` +
            `Using project-local runner anyway; some newer features may be silently unavailable. ` +
            `Run \`npm i -D @glubean/runner@latest\` to silence.`,
        });
      }
    } catch {
      // bundled pkg.json unreadable — skip the check; happens in test fixtures
    }

    return {
      distDir: projectDistDir,
      pkgRoot,
      source: "project",
      resolvedFrom: mainEntry,
      version,
      pendingWarnings: warnings,
    };
  } catch {
    // No project-local runner installed. Plan 1 AC4: emit a warning whenever
    // bundled is used so users see why version-skew "configure() values..."
    // errors may appear.
    warnings.push({
      code: "runner_fallback_no_project",
      message:
        `No project-local @glubean/runner found at ${projectCwd}; using consumer's bundled runner. ` +
        `If your tests import @glubean/sdk from this project, install runner to keep module identity ` +
        `consistent: \`npm i -D @glubean/runner\`.`,
    });
    return {
      distDir: bundledDistDir,
      pkgRoot: bundledPkgRoot,
      source: "bundled",
      pendingWarnings: warnings,
    };
  }
}

// ── End of project-local resolution ─────────────────────────────────────────

// ── tsx path resolution ─────────────────────────────────────────────────────

let _tsxPath: string | undefined;

/** Resolve the tsx CLI entry used to transform the user's TypeScript in the
 *  spawned harness subprocess. Cached after the first lookup. */
export function resolveTsxPath(): string {
  if (_tsxPath) return _tsxPath;
  const req = createRequire(import.meta.url);
  _tsxPath = resolve(dirname(req.resolve("tsx/package.json")), "dist/cli.mjs");
  return _tsxPath;
}

// ── Zero-project (scratch) setup ─────────────────────────────────────────────

/** A computed zero-project plan: extra tsx `--import` args, env redirects, and a
 *  cleanup that undoes any temp package.json. */
export interface ZeroProjectSetup {
  /** tsx args to prepend (`--import <zero-project-register.mjs>`), or `[]`. */
  tsxArgs: string[];
  /** Env additions (`GLUBEAN_VENDORED_ROOT`), or `{}`. */
  env: Record<string, string>;
  /** Restore the working dir's package.json to its original state. Idempotent. */
  cleanup(): void;
}

/**
 * Set up zero-project (scratch) mode for a spawn rooted at `cwd`: when the cwd
 * has no `@glubean/sdk` in node_modules, redirect the user file's `@glubean/*`
 * imports to the resolved runner's vendored copy (via the register hook +
 * `GLUBEAN_VENDORED_ROOT`) and ensure a `"type":"module"` package.json so the
 * `.ts` file loads as ESM. When the cwd already has `@glubean/sdk`, this is a
 * no-op (empty args/env, no-op cleanup).
 *
 * Pure w.r.t. instance state — both `TestExecutor` and the load spawn call it
 * and own the returned `tsxArgs`/`env`/`cleanup`.
 */
export function prepareZeroProject(
  cwd: string,
  runnerDistDir: string,
  runnerPkgRoot: string,
): ZeroProjectSetup {
  if (existsSync(join(cwd, "node_modules", "@glubean", "sdk"))) {
    return { tsxArgs: [], env: {}, cleanup: () => {} };
  }

  // Plan 1: relocate zero-project subpaths with the harness — if harness moved
  // to project-local runner, register + vendored root must move too, otherwise
  // scratch mode mixes project harness with bundled @glubean/* resolution.
  const registerPath = resolve(runnerDistDir, "zero-project-register.mjs");
  const tsxArgs = ["--import", registerPath];

  // Use the runner package root as the synthetic parent. From there, Node's
  // normal package resolution finds sibling @glubean/* packages in both
  // workspace installs (packages/runner/node_modules) and published installs
  // (ancestor node_modules).
  const env: Record<string, string> = { GLUBEAN_VENDORED_ROOT: runnerPkgRoot };

  const pkgPath = join(cwd, "package.json");
  let tempPackageJson: "created" | "patched" | false = false;
  let originalPackageJson: string | undefined;
  if (!existsSync(pkgPath)) {
    try {
      writeFileSync(pkgPath, '{"type":"module"}\n');
      tempPackageJson = "created";
    } catch {
      // Non-critical
    }
  } else {
    try {
      const original = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(original);
      if (pkg.type !== "module") {
        originalPackageJson = original;
        pkg.type = "module";
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
        tempPackageJson = "patched";
      }
    } catch {
      // Non-critical
    }
  }

  return {
    tsxArgs,
    env,
    cleanup() {
      if (!tempPackageJson) return;
      try {
        if (tempPackageJson === "created") {
          unlinkSync(pkgPath);
        } else if (tempPackageJson === "patched" && originalPackageJson) {
          writeFileSync(pkgPath, originalPackageJson);
        }
      } catch {
        // Non-critical
      }
      tempPackageJson = false;
    },
  };
}
