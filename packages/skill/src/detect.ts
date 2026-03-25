import { existsSync } from "node:fs";
import { join } from "node:path";

export type Editor = "claude-code" | "cursor" | "codex" | "windsurf";

/**
 * Auto-detect which AI coding tool the user is likely using
 * by checking for editor-specific config directories.
 *
 * Checks both project-level and user-level signals.
 */
export function detectEditor(cwd: string, home: string): Editor | undefined {
  // Project-level signals (strongest)
  if (existsSync(join(cwd, ".cursor"))) return "cursor";

  // User-level signals
  if (existsSync(join(home, ".claude"))) return "claude-code";
  if (existsSync(join(home, ".codex"))) return "codex";
  if (existsSync(join(home, ".codeium", "windsurf"))) return "windsurf";

  return undefined;
}

export function editorLabel(editor: Editor): string {
  switch (editor) {
    case "claude-code": return "Claude Code";
    case "cursor": return "Cursor";
    case "codex": return "Codex";
    case "windsurf": return "Windsurf";
  }
}

export const ALL_EDITORS: Editor[] = ["claude-code", "cursor", "codex", "windsurf"];
