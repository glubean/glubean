import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

const MARKER_START = "<!-- glubean-skill-start -->";
const MARKER_END = "<!-- glubean-skill-end -->";

/**
 * Write Glubean skill to .cursor/rules/glubean.mdc (project-level).
 * Uses Cursor's MDC rule format.
 */
export async function writeCursor(coreContent: string, version: string, cwd: string): Promise<string> {
  const dir = join(cwd, ".cursor", "rules");
  const filePath = join(dir, "glubean.mdc");

  const frontmatter = `---
description: Generate, run, and fix Glubean API tests
globs: "**/*.test.ts"
alwaysApply: false
---
`;

  const content = `${MARKER_START}\n<!-- @glubean/skill v${version} — run \`npx @glubean/skill\` to update -->\n${frontmatter}${coreContent}\n${MARKER_END}\n`;

  await mkdir(dir, { recursive: true });
  await writeFile(filePath, content);
  return filePath;
}
