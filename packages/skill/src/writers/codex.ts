import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

const MARKER_START = "<!-- glubean-skill-start -->";
const MARKER_END = "<!-- glubean-skill-end -->";

/**
 * Write Glubean skill into AGENTS.md (project-level).
 * If AGENTS.md already exists, replaces only the glubean section.
 * If not, creates it with the glubean section.
 */
export async function writeCodex(coreContent: string, version: string, cwd: string): Promise<string> {
  const filePath = join(cwd, "AGENTS.md");
  const section = `${MARKER_START}\n<!-- @glubean/skill v${version} — run \`npx @glubean/skill\` to update -->\n\n${coreContent}\n${MARKER_END}`;

  if (existsSync(filePath)) {
    let existing = await readFile(filePath, "utf-8");
    const startIdx = existing.indexOf(MARKER_START);
    const endIdx = existing.indexOf(MARKER_END);

    if (startIdx !== -1 && endIdx !== -1) {
      // Replace existing section
      existing = existing.substring(0, startIdx) + section + existing.substring(endIdx + MARKER_END.length);
    } else {
      // Append section
      existing = existing.trimEnd() + "\n\n" + section + "\n";
    }
    await writeFile(filePath, existing);
  } else {
    await writeFile(filePath, section + "\n");
  }

  return filePath;
}
