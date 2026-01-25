/**
 * Glubean Hover Provider — shows resolved env variable values when
 * hovering over `vars.require("KEY")` or `secrets.require("KEY")` calls
 * in .test.ts and .explore.ts files.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

/**
 * Parse a simple .env file into a key-value map.
 * Supports lines like KEY=value, KEY="quoted value", and # comments.
 */
function parseEnvFile(filePath: string): Map<string, string> {
  const result = new Map<string, string>();
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;

      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();

      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      result.set(key, value);
    }
  } catch {
    // File doesn't exist or can't be read — return empty map
  }
  return result;
}

/**
 * Regex to match `vars.require("KEY")` or `secrets.require("KEY")`.
 * Also matches single-quoted strings.
 */
const REQUIRE_PATTERN =
  /(?:vars|secrets)\.require\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Create a Glubean hover provider.
 *
 * @param getEnvFile - callback returning the selected env file name
 *                     (e.g. ".env.staging") or undefined for default ".env"
 */
export function createHoverProvider(
  getEnvFile: () => string | undefined
): vscode.HoverProvider {
  return {
    provideHover(
      document: vscode.TextDocument,
      position: vscode.Position
    ): vscode.Hover | undefined {
      const lineText = document.lineAt(position.line).text;

      // Find all require() calls on this line
      let match: RegExpExecArray | null;
      REQUIRE_PATTERN.lastIndex = 0;
      while ((match = REQUIRE_PATTERN.exec(lineText)) !== null) {
        const matchStart = match.index;
        const matchEnd = matchStart + match[0].length;

        // Check if the cursor is within this match
        if (position.character < matchStart || position.character > matchEnd) {
          continue;
        }

        const varName = match[1];
        const isSecret = match[0].startsWith("secrets.");

        // Resolve the workspace root
        const workspaceRoot =
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return undefined;

        // Determine which env file to read
        const envFileName = getEnvFile() || ".env";

        if (isSecret) {
          // For secrets, read from the .secrets companion file
          const secretsFileName = `${envFileName}.secrets`;
          const secretsPath = path.join(workspaceRoot, secretsFileName);
          const secrets = parseEnvFile(secretsPath);
          const value = secrets.get(varName);

          if (value) {
            // Mask secret values — show first 4 and last 2 chars only
            const masked =
              value.length > 8
                ? `${value.slice(0, 4)}${"•".repeat(value.length - 6)}${value.slice(-2)}`
                : "•".repeat(value.length);

            const md = new vscode.MarkdownString();
            md.appendMarkdown(
              `**${varName}** = \`${masked}\` *(${secretsFileName})*`
            );
            const range = new vscode.Range(
              position.line,
              matchStart,
              position.line,
              matchEnd
            );
            return new vscode.Hover(md, range);
          }

          // Key not found in secrets file
          const md = new vscode.MarkdownString();
          md.appendMarkdown(
            `⚠️ **${varName}** — not found in \`${secretsFileName}\``
          );
          const range = new vscode.Range(
            position.line,
            matchStart,
            position.line,
            matchEnd
          );
          return new vscode.Hover(md, range);
        }

        // Regular vars — read from the env file
        const envPath = path.join(workspaceRoot, envFileName);
        const vars = parseEnvFile(envPath);
        const value = vars.get(varName);

        const md = new vscode.MarkdownString();
        if (value !== undefined) {
          md.appendMarkdown(
            `**${varName}** = \`${value}\` *(${envFileName})*`
          );
        } else {
          md.appendMarkdown(
            `⚠️ **${varName}** — not found in \`${envFileName}\``
          );
        }
        const range = new vscode.Range(
          position.line,
          matchStart,
          position.line,
          matchEnd
        );
        return new vscode.Hover(md, range);
      }

      return undefined;
    },
  };
}
