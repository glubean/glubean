/**
 * SDK / runner version compat probe for the MCP server.
 *
 * Companion to Plan 1's project-local runner resolution. Plan 1 transparently
 * routes spawn-time SDK identity through the project-local runner when one is
 * installed. When NO project-local runner is installed (sdk-only projects),
 * Plan 1 falls back to bundled and emits a `runner_fallback_no_project`
 * warning — but the dual-package hazard still reproduces because the bundled
 * harness's `@glubean/sdk` won't match user code's `@glubean/sdk`.
 *
 * This module's job: detect that scenario at MCP tool entry time, BEFORE we
 * spawn the harness, and return a structured `sdk_version_skew` error to the
 * agent so it surfaces an actionable install command instead of the user
 * hitting the misleading "configure() values can only be accessed..." error.
 *
 * Discriminator: this probe is MCP-specific because (a) MCP responses go to
 * an LLM agent who needs structured `versionInfo`, not a stack trace; (b)
 * `npx -y @glubean/mcp@latest` causes silent version drift via the npm cache
 * TTL — users don't pin MCP the way they pin CLI.
 */

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";

export interface CompatResult {
  ok: boolean;
  /**
   * Differentiates failure modes when `ok: false`:
   *   - "sdk_version_skew" — project pins @glubean/sdk at a realpath
   *     different from bundled AND no project @glubean/runner is
   *     installed. The dual-package hazard would reproduce. Recoverable
   *     by `npm i -D @glubean/runner`.
   *   - "mcp_packaging_bug" — MCP process can't resolve its own bundled
   *     @glubean/sdk. Not the user's fault — file an issue against MCP.
   * Omitted when `ok: true`.
   */
  failureCode?: "sdk_version_skew" | "mcp_packaging_bug";
  projectSdkVersion?: string;
  bundledSdkVersion: string;
  projectRunnerInstalled: boolean;
  projectRunnerVersion?: string;
  bundledRunnerVersion?: string;
  message?: string;
}

/**
 * Walk up from a starting file looking for a package.json whose `name` field
 * matches `expectedName`. Layout-independent — mirrors the helper in
 * `@glubean/runner`'s executor.ts so MCP's probe survives the same bundler
 * topologies. Returns the realpath of the package root.
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
        // continue walking — corrupt / non-json
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

interface PkgInfo {
  pkgDir: string;  // realpath of package root
  version: string;
}

/**
 * Resolve a package's main entry, then walk up to its package.json by name.
 * Uses a cwd-rooted createRequire to avoid the workspace self-reference trap
 * (see Plan 1 §3.1 for context). Returns undefined when not resolvable.
 */
function probePkg(name: string, projectCwd?: string): PkgInfo | undefined {
  try {
    const stubPath = projectCwd
      ? resolve(projectCwd, "__glubean_compat_stub__.js")
      : resolve(dirname(new URL(import.meta.url).pathname), "__bundled_stub__.js");
    const req = createRequire(stubPath);
    const mainEntry = req.resolve(name);
    const pkgDir = findPackageRoot(mainEntry, name);
    if (!pkgDir) return undefined;
    const pkg = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf-8"));
    return { pkgDir, version: pkg.version };
  } catch {
    return undefined;
  }
}

/**
 * Probe the SDK + runner identities of the running MCP process and the
 * caller's project. Returns `ok: false` only when the hazard is real:
 * project has its own @glubean/sdk, the realpath differs from MCP's
 * bundled SDK, AND project has no @glubean/runner installed (so Plan 1's
 * project-local resolution would fall back to bundled).
 *
 * Every other case (no project SDK at all / matching SDK / project has
 * runner) returns ok with structured metadata so the agent has full context.
 */
export function checkSdkCompat(projectRoot: string): CompatResult {
  const bundledSdk = probePkg("@glubean/sdk");
  const bundledRunner = probePkg("@glubean/runner");

  if (!bundledSdk) {
    return {
      ok: false,
      failureCode: "mcp_packaging_bug",
      bundledSdkVersion: "<unresolved>",
      projectRunnerInstalled: false,
      message:
        `@glubean/mcp is missing its runtime dependency on @glubean/sdk. ` +
        `This is a packaging bug — please file an issue.`,
    };
  }

  const projectSdk = probePkg("@glubean/sdk", projectRoot);
  const projectRunner = probePkg("@glubean/runner", projectRoot);
  const projectRunnerInstalled = projectRunner !== undefined;

  if (!projectSdk) {
    return {
      ok: true,
      bundledSdkVersion: bundledSdk.version,
      bundledRunnerVersion: bundledRunner?.version,
      projectRunnerInstalled,
      projectRunnerVersion: projectRunner?.version,
    };
  }

  if (projectSdk.pkgDir === bundledSdk.pkgDir) {
    return {
      ok: true,
      projectSdkVersion: projectSdk.version,
      bundledSdkVersion: bundledSdk.version,
      bundledRunnerVersion: bundledRunner?.version,
      projectRunnerInstalled,
      projectRunnerVersion: projectRunner?.version,
    };
  }

  if (projectRunnerInstalled && projectRunner) {
    // Partial-upgrade hazard guard: project's @glubean/runner may have
    // nested its OWN @glubean/sdk in its private node_modules (npm/pnpm
    // sometimes leaves a nested copy when versions can't dedup). In that
    // case the harness loads the runner's nested SDK while user test code
    // loads project's direct SDK → different realpaths → dual-package
    // hazard reproduces despite Plan 1's project-local runner resolution.
    //
    // Verify the runner's resolved SDK realpath matches the project's
    // direct SDK realpath. If not, this is a real skew worth reporting.
    const runnerNestedSdk = probePkg("@glubean/sdk", projectRunner.pkgDir);
    if (runnerNestedSdk && runnerNestedSdk.pkgDir !== projectSdk.pkgDir) {
      return {
        ok: false,
        failureCode: "sdk_version_skew",
        projectSdkVersion: projectSdk.version,
        bundledSdkVersion: bundledSdk.version,
        bundledRunnerVersion: bundledRunner?.version,
        projectRunnerInstalled: true,
        projectRunnerVersion: projectRunner.version,
        message:
          `Project pins @glubean/sdk ${projectSdk.version} at ${projectSdk.pkgDir}, ` +
          `but @glubean/runner ${projectRunner.version} resolves its own nested ` +
          `@glubean/sdk ${runnerNestedSdk.version} at ${runnerNestedSdk.pkgDir}. ` +
          `These are different module instances; tests will fail with a misleading ` +
          `"configure() values can only be accessed during test execution" error. ` +
          `Fix: align versions — e.g. \`npm dedupe\`, or update @glubean/runner to a ` +
          `version that uses your pinned @glubean/sdk.`,
      };
    }

    return {
      ok: true,
      projectSdkVersion: projectSdk.version,
      bundledSdkVersion: bundledSdk.version,
      bundledRunnerVersion: bundledRunner?.version,
      projectRunnerInstalled: true,
      projectRunnerVersion: projectRunner.version,
    };
  }

  return {
    ok: false,
    failureCode: "sdk_version_skew",
    projectSdkVersion: projectSdk.version,
    bundledSdkVersion: bundledSdk.version,
    bundledRunnerVersion: bundledRunner?.version,
    projectRunnerInstalled: false,
    message:
      `Project pins @glubean/sdk ${projectSdk.version} but has no @glubean/runner installed; ` +
      `MCP is using its bundled @glubean/runner${bundledRunner ? ` ${bundledRunner.version}` : ""} ` +
      `+ @glubean/sdk ${bundledSdk.version}. These are different module instances; tests will fail ` +
      `with a misleading "configure() values can only be accessed during test execution" error. ` +
      `Fix: run "npm i -D @glubean/runner@${bundledRunner?.version ?? bundledSdk.version}" in the project.`,
  };
}
