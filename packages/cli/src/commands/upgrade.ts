/**
 * glubean upgrade — upgrade CLI to latest version.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isNewer, parseSemver } from "../update_check.js";

const REGISTRY_URL = "https://registry.npmjs.org/glubean/latest";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
};

export type GlobalPackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** Identify the manager that owns the CLI process selected by the shell. */
export function detectGlobalPackageManager(executablePath: string): GlobalPackageManager | null {
  let resolvedPath = executablePath;
  try {
    resolvedPath = realpathSync(executablePath);
  } catch {
    // Keep the supplied path for synthetic paths and actionable diagnostics.
  }
  const path = resolvedPath.replaceAll("\\", "/").toLowerCase();
  const cliPackage = String.raw`(?:glubean|@glubean/cli)`;
  if (path.includes("/.pnpm/") || path.includes("/pnpm/global/") || path.includes("/library/pnpm/")) {
    return "pnpm";
  }
  if (path.includes("/.bun/install/global/") || path.includes("/bun/install/global/")) return "bun";
  if (path.includes("/yarn/global/") || path.includes("/.config/yarn/global/")) return "yarn";
  if (
    new RegExp(`/lib/node_modules/${cliPackage}/`).test(path) ||
    new RegExp(`/npm/node_modules/${cliPackage}/`).test(path)
  ) {
    return "npm";
  }
  return null;
}

export function globalInstallCommand(manager: GlobalPackageManager, version: string): { command: string; args: string[] } {
  switch (manager) {
    case "npm":
      return { command: "npm", args: ["install", "-g", `glubean@${version}`] };
    case "pnpm":
      return { command: "pnpm", args: ["add", "-g", `glubean@${version}`] };
    case "yarn":
      return { command: "yarn", args: ["global", "add", `glubean@${version}`] };
    case "bun":
      return { command: "bun", args: ["add", "-g", `glubean@${version}`] };
  }
}

export async function upgradeCommand(currentVersion: string): Promise<void> {
  // 1. Check latest version
  console.log(`${colors.dim}Checking latest version...${colors.reset}`);

  let latest: string | undefined;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(REGISTRY_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const data = (await res.json()) as { version?: string };
      latest = data.version;
    }
  } catch {
    // fall through
  }

  if (!latest) {
    console.error(`${colors.red}Could not reach npm registry.${colors.reset}`);
    process.exit(1);
  }

  if (!isNewer(latest, currentVersion)) {
    console.log(
      `${colors.green}Already up to date: glubean v${currentVersion}${colors.reset}`,
    );
    return;
  }

  console.log(
    `${colors.cyan}Upgrading: v${currentVersion} → v${latest}${colors.reset}\n`,
  );

  // 2. Upgrade the SAME global installation that launched this process. npm,
  // pnpm, Yarn, Bun, and each nvm Node version have independent global roots.
  // Updating a different root can succeed while the active CLI stays stale.
  const executablePath = process.argv[1] ?? "";
  const manager = detectGlobalPackageManager(executablePath);
  if (!manager) {
    console.error(
      `${colors.red}Upgrade failed: this CLI is not a recognized global npm, pnpm, Yarn, or Bun installation.${colors.reset}`,
    );
    console.error(
      `${colors.dim}Active executable: ${executablePath || "<unknown>"}. Update the installation that owns this path.${colors.reset}`,
    );
    process.exit(1);
  }

  const install = globalInstallCommand(manager, latest);
  try {
    execFileSync(install.command, install.args, { stdio: "inherit" });
  } catch {
    console.error(
      `\n${colors.red}Upgrade failed.${colors.reset} Try manually: ${install.command} ${install.args.join(" ")}`,
    );
    process.exit(1);
  }

  // 3. Verify
  let installed: string | undefined;
  try {
    const output = execFileSync("glubean", ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = output.match(/(\d+\.\d+\.\d+)/);
    installed = match?.[1];
  } catch {
    // ignore
  }

  if (!installed || !parseSemver(installed) || installed !== latest) {
    console.error(
      `\n${colors.red}Upgrade did not update the active CLI.${colors.reset} ` +
        `${colors.dim}Expected v${latest}, but PATH resolved ${installed ? `v${installed}` : "an unreadable version"}.${colors.reset}`,
    );
    console.error(`${colors.dim}Run 'type -a glubean' to find duplicate installations.${colors.reset}`);
    process.exit(1);
  }

  console.log(`\n${colors.green}✓ Upgraded ${manager} global glubean to v${installed}${colors.reset}`);
}
