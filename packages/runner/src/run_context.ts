import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { RunContext } from "@glubean/sdk";

/**
 * Read version from a package.json file.
 * Returns "unknown" if the file can't be read.
 */
function readVersion(packageJsonPath: string): string {
  try {
    const content = readFileSync(packageJsonPath, "utf-8");
    return JSON.parse(content).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Build runtime context for inclusion in result.json.
 *
 * Captures versions, platform, and timestamp.
 * CLI and VSCode add command/cwd/envFile on top.
 */
export function buildRunContext(): RunContext {
  // Runner's own directory: dist/run_context.js → dist → runner package root
  const runnerDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const runnerVersion = readVersion(resolve(runnerDir, "package.json"));

  // SDK version: runner depends on @glubean/sdk
  let sdkVersion = "unknown";
  try {
    const sdkUrl = import.meta.resolve("@glubean/sdk");
    const sdkEntry = fileURLToPath(sdkUrl);
    // sdkEntry is .../dist/index.js → go up to package root
    const sdkDir = resolve(dirname(sdkEntry), "..");
    sdkVersion = readVersion(resolve(sdkDir, "package.json"));
  } catch {
    // SDK not resolvable (shouldn't happen)
  }

  return {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    sdkVersion,
    runnerVersion,
    platform: process.platform,
    arch: process.arch,
  };
}
