import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const FRONTMATTER = `---
name: glubean
description: Generate, run, and fix Glubean API tests. Uses cheatsheet docs for SDK patterns and CLI for execution.
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - mcp__glubean__glubean_run_local_file
  - mcp__glubean__glubean_discover_tests
  - mcp__glubean__glubean_list_test_files
  - mcp__glubean__glubean_diagnose_config
  - mcp__glubean__glubean_get_last_run_summary
  - mcp__glubean__glubean_get_local_events
---

`;

export async function writeClaudeCode(coreContent: string, version: string): Promise<string> {
  const dir = join(homedir(), ".claude", "skills", "glubean");
  const filePath = join(dir, "SKILL.md");

  const content = `<!-- @glubean/skill v${version} — run \`npx @glubean/skill\` to update -->\n${FRONTMATTER}${coreContent}`;

  await mkdir(dir, { recursive: true });
  await writeFile(filePath, content);
  return filePath;
}
