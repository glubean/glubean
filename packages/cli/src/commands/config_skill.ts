/**
 * glubean config skill — install/update Glubean test-writing skill for AI coding tools.
 *
 * Delegates to `npx @glubean/skill@latest` which is independently versioned
 * and always fetches the latest skill content from npm.
 *
 * Supported targets: claude-code, cursor, codex, windsurf
 */

import { execSync } from "node:child_process";

type Target = "claude-code" | "codex" | "cursor" | "windsurf";

interface ConfigSkillOptions {
  target?: Target;
  remove?: boolean;
}

export async function configSkillCommand(options: ConfigSkillOptions): Promise<void> {
  if (options.remove) {
    console.log("To remove the skill, delete the skill file written by the installer.");
    console.log("Run `npx @glubean/skill@latest --help` for file locations.");
    return;
  }

  const args = options.target ? ` ${options.target}` : "";
  const cmd = `npx -y @glubean/skill@latest${args}`;

  try {
    execSync(cmd, { stdio: "inherit" });
  } catch {
    console.error("\nFailed to install skill via npx. You can install manually:");
    console.error("  npx @glubean/skill@latest");
  }
}
