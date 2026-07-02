/**
 * Shared test helpers for CLI integration tests.
 */

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(__dirname, "main.ts");

// Resolve tsx binary
const require = createRequire(import.meta.url);
const tsxBin = resolve(
  dirname(require.resolve("tsx/package.json")),
  "dist/cli.mjs",
);

export interface RunCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunCliOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
}

/**
 * Run the CLI as a subprocess using tsx.
 * Returns exit code + captured stdout/stderr.
 */
export function runCli(
  args: string[],
  options: RunCliOptions = {},
): Promise<RunCliResult> {
  return new Promise((res) => {
    const child = execFile(
      "node",
      [tsxBin, CLI_ENTRY, ...args],
      {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        encoding: "utf-8",
        // GLU-79: hung-process kill-net only — sized ABOVE the widest
        // per-test vitest timeout that funnels through runCli (init.test.ts:
        // 90s), so a slow-but-alive subprocess surfaces as a readable vitest
        // timeout instead of an opaque SIGTERM exit 143. The old 30s value
        // fired under contended load (full-monorepo `pnpm -r test`) on init
        // runs and flaked the suite. Test-infra only.
        timeout: 120_000,
      },
      (error, stdout, stderr) => {
        const code = error ? (error as any).code ?? 1 : 0;
        res({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );

    if (options.stdin && child.stdin) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });
}
