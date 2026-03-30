/**
 * glubean upgrade — upgrade CLI to latest version.
 */

import { execSync } from "node:child_process";
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

  // 2. Run npm install
  try {
    execSync("npm install -g glubean@latest", { stdio: "inherit" });
  } catch {
    console.error(
      `\n${colors.red}Upgrade failed.${colors.reset} Try manually: npm install -g glubean@latest`,
    );
    process.exit(1);
  }

  // 3. Verify
  let installed: string | undefined;
  try {
    const output = execSync("glubean --version", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = output.match(/(\d+\.\d+\.\d+)/);
    installed = match?.[1];
  } catch {
    // ignore
  }

  if (installed && parseSemver(installed)) {
    console.log(
      `\n${colors.green}✓ Upgraded to glubean v${installed}${colors.reset}`,
    );
  } else {
    console.log(
      `\n${colors.green}✓ Upgrade complete.${colors.reset}`,
    );
  }
}
