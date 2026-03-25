#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { detectEditor, editorLabel, ALL_EDITORS, type Editor } from "./detect.js";
import { writeClaudeCode } from "./writers/claude-code.js";
import { writeCursor } from "./writers/cursor.js";
import { writeCodex } from "./writers/codex.js";
import { writeWindsurf } from "./writers/windsurf.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function getVersion(): Promise<string> {
  const pkgPath = join(__dirname, "..", "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
  return pkg.version;
}

async function getCoreContent(): Promise<string> {
  const contentPath = join(__dirname, "..", "content", "skill-core.md");
  return readFile(contentPath, "utf-8");
}

async function writeSkill(editor: Editor, coreContent: string, version: string, cwd: string): Promise<string> {
  switch (editor) {
    case "claude-code":
      return writeClaudeCode(coreContent, version);
    case "cursor":
      return writeCursor(coreContent, version, cwd);
    case "codex":
      return writeCodex(coreContent, version, cwd);
    case "windsurf":
      return writeWindsurf(coreContent, version, cwd);
  }
}

async function promptEditor(): Promise<Editor> {
  // Simple stdin prompt without dependencies
  const editors = ALL_EDITORS;
  console.log("\nWhich AI coding tool do you use?\n");
  editors.forEach((e, i) => console.log(`  ${i + 1}. ${editorLabel(e)}`));
  console.log();

  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question("Enter number (1-4): ", (answer) => {
      rl.close();
      const idx = parseInt(answer.trim(), 10) - 1;
      if (idx >= 0 && idx < editors.length) {
        resolve(editors[idx]);
      } else {
        console.error("Invalid choice. Defaulting to Claude Code.");
        resolve("claude-code");
      }
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const cwd = process.cwd();
  const home = homedir();

  // Parse flags
  const checkOnly = args.includes("--check");
  const editorArg = args.find((a) => !a.startsWith("-")) as Editor | undefined;

  // Resolve editor
  let editor: Editor;
  if (editorArg && ALL_EDITORS.includes(editorArg)) {
    editor = editorArg;
  } else {
    const detected = detectEditor(cwd, home);
    if (detected) {
      editor = detected;
      console.log(`Detected: ${editorLabel(editor)}`);
    } else {
      editor = await promptEditor();
    }
  }

  const version = await getVersion();

  if (checkOnly) {
    console.log(`@glubean/skill v${version} for ${editorLabel(editor)}`);
    // TODO: compare with installed version
    return;
  }

  const coreContent = await getCoreContent();
  const filePath = await writeSkill(editor, coreContent, version, cwd);

  console.log(`\n✓ Glubean skill installed for ${editorLabel(editor)}`);
  console.log(`  Version: v${version}`);
  console.log(`  Written to: ${filePath}`);
  console.log(`\n  Update anytime: npx @glubean/skill`);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
