/**
 * glubean config mcp — configure MCP server for AI coding tools.
 *
 * Supported targets:
 * - claude-code: uses `claude mcp add/remove` CLI
 * - codex: appends [mcp_servers.glubean] to ~/.codex/config.toml
 * - cursor: writes .cursor/mcp.json in project root
 * - windsurf: writes ~/.codeium/windsurf/mcp_config.json
 */

import { execSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

const MCP_SERVER_NAME = "glubean";
const MCP_COMMAND = "npx";
const MCP_ARGS = ["-y", "@glubean/mcp@latest"];

type Target = "claude-code" | "codex" | "cursor" | "windsurf";

interface ConfigMcpOptions {
  target?: Target;
  remove?: boolean;
}

export async function configMcpCommand(options: ConfigMcpOptions): Promise<void> {
  const target = options.target ?? (await promptTarget());
  const remove = options.remove ?? false;

  if (remove) {
    await removeTarget(target);
  } else {
    await installTarget(target);
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
// Install
// ─────────────────────────────────────────────────────────────────────────────

async function installTarget(target: Target): Promise<void> {
  switch (target) {
    case "claude-code":
      return installClaudeCode();
    case "codex":
      return installCodex();
    case "cursor":
      return installCursor();
    case "windsurf":
      return installWindsurf();
  }
}

async function installClaudeCode(): Promise<void> {
  const claudeBin = findClaudeBin();
  if (!claudeBin) {
    console.error("✗ Claude Code CLI not found. Install it first: https://docs.anthropic.com/en/docs/claude-code");
    process.exit(1);
  }

  // Remove existing (may be stale Deno version) then add fresh
  try {
    execSync(`${claudeBin} mcp remove ${MCP_SERVER_NAME} -s user`, { stdio: "pipe" });
  } catch {
    // Ignore if not found
  }

  const cmd = `${claudeBin} mcp add ${MCP_SERVER_NAME} -s user -- ${MCP_COMMAND} ${MCP_ARGS.join(" ")}`;

  try {
    execSync(cmd, { stdio: "pipe" });
    console.log(`✓ MCP server configured for Claude Code (user scope)`);
    console.log(`  Command: ${MCP_COMMAND} ${MCP_ARGS.join(" ")}`);
    console.log(`  To verify: claude mcp get ${MCP_SERVER_NAME}`);
    console.log(`\n  ⚠ Restart your Claude Code session to activate the MCP server.`);
  } catch {
    console.error(`✗ Failed to configure Claude Code MCP.`);
    console.error(`  Try manually: ${cmd}`);
    process.exit(1);
  }
}

async function installCodex(): Promise<void> {
  const configPath = join(homedir(), ".codex", "config.toml");
  let content = await readFileSafe(configPath);

  // Remove existing glubean section if present
  content = removeTomlSection(content, MCP_SERVER_NAME);

  // Append new section
  const section = buildTomlSection();
  content = content.trimEnd() + (content.trim() ? "\n\n" : "") + section + "\n";

  await mkdir(join(homedir(), ".codex"), { recursive: true });
  await writeFile(configPath, content);

  console.log(`✓ MCP server configured for Codex`);
  console.log(`  Written to: ${configPath}`);
  console.log(`\n  ⚠ Restart Codex to activate the MCP server.`);
}

async function installCursor(): Promise<void> {
  const configPath = resolve(process.cwd(), ".cursor", "mcp.json");
  const config = await readJsonSafe(configPath);

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  config.mcpServers[MCP_SERVER_NAME] = {
    command: MCP_COMMAND,
    args: MCP_ARGS,
  };

  await mkdir(resolve(process.cwd(), ".cursor"), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");

  console.log(`✓ MCP server configured for Cursor`);
  console.log(`  Written to: ${configPath}`);
  console.log(`\n  ⚠ Restart Cursor to activate the MCP server.`);
}

async function installWindsurf(): Promise<void> {
  const configPath = join(homedir(), ".codeium", "windsurf", "mcp_config.json");
  const config = await readJsonSafe(configPath);

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  config.mcpServers[MCP_SERVER_NAME] = {
    command: MCP_COMMAND,
    args: MCP_ARGS,
  };

  await mkdir(join(homedir(), ".codeium", "windsurf"), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");

  console.log(`✓ MCP server configured for Windsurf`);
  console.log(`  Written to: ${configPath}`);
  console.log(`\n  ⚠ Restart Windsurf to activate the MCP server.`);
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
 * Build TOML section for Codex config.
 * Format: [mcp_servers.glubean]
 */
function buildTomlSection(): string {
  const argsToml = MCP_ARGS.map((a) => `"${a}"`).join(", ");
  return [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = "${MCP_COMMAND}"`,
    `args = [${argsToml}]`,
  ].join("\n");
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
