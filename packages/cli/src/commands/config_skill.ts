/**
 * glubean config skill — install Glubean test-writing skill for AI coding tools.
 *
 * Supported targets:
 * - claude-code: writes ~/.claude/skills/glubean/SKILL.md
 * - codex: writes ~/.codex/skills/glubean/SKILL.md
 * - cursor: writes .cursor/skills/glubean/SKILL.md (project-level)
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "glubean";

type Target = "claude-code" | "codex" | "cursor";

interface ConfigSkillOptions {
  target?: Target;
  remove?: boolean;
}

export async function configSkillCommand(options: ConfigSkillOptions): Promise<void> {
  const target = options.target ?? (await promptTarget());
  const remove = options.remove ?? false;

  if (remove) {
    await removeSkill(target);
  } else {
    await installSkill(target);
  }
}

async function promptTarget(): Promise<Target> {
  const { select } = await import("@inquirer/prompts");
  return await select<Target>({
    message: "Which AI tool do you use?",
    choices: [
      { name: "Claude Code", value: "claude-code" },
      { name: "Codex (OpenAI)", value: "codex" },
      { name: "Cursor", value: "cursor" },
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

function skillDir(target: Target): string {
  switch (target) {
    case "claude-code":
      return join(homedir(), ".claude", "skills", SKILL_NAME);
    case "codex":
      return join(homedir(), ".codex", "skills", SKILL_NAME);
    case "cursor":
      return resolve(process.cwd(), ".cursor", "skills", SKILL_NAME);
  }
}

function targetLabel(target: Target): string {
  switch (target) {
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Install
// ─────────────────────────────────────────────────────────────────────────────

async function installSkill(target: Target): Promise<void> {
  const templatePath = getTemplatePath();
  const template = await readFile(templatePath, "utf-8");

  const dir = skillDir(target);
  const skillPath = join(dir, "SKILL.md");

  await mkdir(dir, { recursive: true });
  await writeFile(skillPath, template);

  const label = targetLabel(target);
  console.log(`✓ Glubean skill installed for ${label}`);
  console.log(`  Written to: ${skillPath}`);

  if (target === "cursor") {
    console.log(`  Scope: project-level (committed to repo)`);
  } else {
    console.log(`  Scope: user-level (all projects)`);
  }

  console.log(`\n  Usage: type /glubean in your AI tool to generate tests.`);
  console.log(`  ⚠ Restart your ${label} session to activate.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Remove
// ─────────────────────────────────────────────────────────────────────────────

async function removeSkill(target: Target): Promise<void> {
  const dir = skillDir(target);
  const label = targetLabel(target);

  try {
    await rm(dir, { recursive: true });
    console.log(`✓ Glubean skill removed from ${label} (${dir}).`);
  } catch {
    console.log(`✓ Glubean skill was not installed for ${label}.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getTemplatePath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // dist/commands/config_skill.js → templates/claude-skill-glubean-test.md
  return join(dirname(thisFile), "..", "..", "templates", "claude-skill-glubean-test.md");
}
