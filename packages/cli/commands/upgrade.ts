/**
 * `glubean upgrade` — Check for updates and self-upgrade the CLI.
 *
 * Fetches the latest version from JSR and runs `deno install` to upgrade.
 */

import { CLI_VERSION } from "../version.ts";

const JSR_META_URL = "https://jsr.io/@glubean/cli/meta.json";

function parseSemver(version: string): number[] | null {
  const parts = version.split(".").map((p) => Number(p));
  if (parts.length < 3 || parts.some((p) => Number.isNaN(p))) return null;
  return parts.slice(0, 3);
}

function isNewer(latest: string, current: string): boolean {
  const l = parseSemver(latest);
  const c = parseSemver(current);
  if (!l || !c) return false;
  for (let i = 0; i < 3; i++) {
    if (l[i] > c[i]) return true;
    if (l[i] < c[i]) return false;
  }
  return false;
}

export async function upgradeCommand(options: {
  force?: boolean;
}): Promise<void> {
  console.log(`Current version: v${CLI_VERSION}`);
  console.log("Checking for updates...\n");

  let latest: string;
  try {
    const resp = await fetch(JSR_META_URL);
    if (!resp.ok) {
      console.error(`Failed to check JSR (HTTP ${resp.status})`);
      Deno.exit(1);
    }
    const data = (await resp.json()) as { latest?: string };
    if (!data.latest) {
      console.error("Could not determine latest version from JSR");
      Deno.exit(1);
    }
    latest = data.latest;
  } catch (err) {
    console.error(
      `Failed to reach JSR: ${err instanceof Error ? err.message : err}`
    );
    Deno.exit(1);
  }

  if (!isNewer(latest, CLI_VERSION) && !options.force) {
    console.log(`Already up to date (v${CLI_VERSION})`);
    return;
  }

  if (isNewer(latest, CLI_VERSION)) {
    console.log(`New version available: v${latest}`);
  } else {
    console.log(`Forcing reinstall of v${latest}`);
  }

  console.log("Upgrading...\n");

  const cmd = new Deno.Command("deno", {
    args: ["install", "-Agf", "-n", "glubean", `jsr:@glubean/cli@${latest}`],
    stdout: "inherit",
    stderr: "inherit",
  });

  const { code } = await cmd.output();

  if (code === 0) {
    console.log(`\nSuccessfully upgraded to glubean v${latest}`);
  } else {
    console.error(`\nUpgrade failed (exit code ${code})`);
    Deno.exit(1);
  }
}
