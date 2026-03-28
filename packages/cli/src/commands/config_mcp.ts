/**
 * glubean config mcp — configure Glubean MCP server for AI coding tools.
 *
 * Install: delegates to `npx add-mcp` which auto-detects installed tools.
 * Remove:  manually removes from Claude Code / Codex / Cursor / Windsurf.
 */

import { execSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

const MCP_SERVER_NAME = "glubean";
const MCP_ARGS = `"npx -y @glubean/mcp@latest"`;

type Target = "claude-code" | "codex" | "cursor" | "windsurf";

interface ConfigMcpOptions {
  target?: Target;
  remove?: boolean;
}

export async function configMcpCommand(options: ConfigMcpOptions): Promise<void> {
  const remove = options.remove ?? false;

  if (remove) {
    const target = options.target ?? (await promptTarget());
    await removeTarget(target);
  } else {
    installWithAddMcp();
  }
}

function installWithAddMcp(): void {
  console.log(`Running: npx add-mcp ${MCP_ARGS}\n`);
  try {
    execSync(`npx add-mcp ${MCP_ARGS}`, { stdio: "inherit" });
  } catch {
    console.error(`\n✗ Failed. Run manually: npx add-mcp ${MCP_ARGS}`);
    process.exit(1);
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
      { name: "Windsurf", value: "windsurf" },
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Remove
// ─────────────────────────────────────────────────────────────────────────────

async function removeTarget(target: Target): Promise<void> {
  switch (target) {
    case "claude-code":
      return removeClaudeCode();
    case "codex":
      return removeCodex();
    case "cursor":
      return removeCursor();
    case "windsurf":
      return removeWindsurf();
  }
}

async function removeClaudeCode(): Promise<void> {
  const claudeBin = findClaudeBin();
  if (!claudeBin) {
    console.log(`✓ Claude Code CLI not found — nothing to remove.`);
    return;
  }
  try {
    execSync(`${claudeBin} mcp remove ${MCP_SERVER_NAME} -s user`, { stdio: "pipe" });
    console.log(`✓ MCP server removed from Claude Code.`);
  } catch {
    console.log(`✓ MCP server was not configured in Claude Code.`);
  }
}

async function removeCodex(): Promise<void> {
  const configPath = join(homedir(), ".codex", "config.toml");
  const content = await readFileSafe(configPath);
  const cleaned = removeTomlSection(content, MCP_SERVER_NAME);

  if (cleaned !== content) {
    await writeFile(configPath, cleaned);
    console.log(`✓ MCP server removed from Codex (${configPath}).`);
  } else {
    console.log(`✓ MCP server was not configured in Codex.`);
  }
}

async function removeCursor(): Promise<void> {
  const configPath = resolve(process.cwd(), ".cursor", "mcp.json");
  const config = await readJsonSafe(configPath);

  if (config.mcpServers?.[MCP_SERVER_NAME]) {
    delete config.mcpServers[MCP_SERVER_NAME];
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
    console.log(`✓ MCP server removed from Cursor (${configPath}).`);
  } else {
    console.log(`✓ MCP server was not configured in Cursor.`);
  }
}

async function removeWindsurf(): Promise<void> {
  const configPath = join(homedir(), ".codeium", "windsurf", "mcp_config.json");
  const config = await readJsonSafe(configPath);

  if (config.mcpServers?.[MCP_SERVER_NAME]) {
    delete config.mcpServers[MCP_SERVER_NAME];
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
    console.log(`✓ MCP server removed from Windsurf (${configPath}).`);
  } else {
    console.log(`✓ MCP server was not configured in Windsurf.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the claude CLI binary. Checks PATH first, then the well-known install location.
 */
function findClaudeBin(): string | undefined {
  // Try PATH
  try {
    execSync("claude --version", { stdio: "pipe" });
    return "claude";
  } catch {
    // Not in PATH
  }
  // Try well-known location
  const wellKnown = join(homedir(), ".claude", "local", "claude");
  try {
    execSync(`${wellKnown} --version`, { stdio: "pipe" });
    return wellKnown;
  } catch {
    return undefined;
  }
}

async function readJsonSafe(path: string): Promise<Record<string, any>> {
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function readFileSafe(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Remove an [mcp_servers.<name>] section from TOML content.
 * Removes from the header line until the next section header or EOF.
 */
function removeTomlSection(content: string, name: string): string {
  const header = `[mcp_servers.${name}]`;
  const idx = content.indexOf(header);
  if (idx === -1) return content;

  // Find the next section header after this one
  const afterHeader = idx + header.length;
  const nextSection = content.indexOf("\n[", afterHeader);

  const before = content.slice(0, idx).replace(/\n+$/, "");
  const after = nextSection === -1 ? "" : content.slice(nextSection);

  return (before + after).trim() + (before || after ? "\n" : "");
}
