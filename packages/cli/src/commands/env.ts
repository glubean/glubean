/**
 * `glubean env` — manage active environment.
 *
 * Subcommands:
 *   glubean env              Show current active environment
 *   glubean env use <name>   Set active environment (writes .glubean/active-env)
 *   glubean env reset        Clear active environment (use default .env)
 *   glubean env list         List available .env files in the project
 */

import { resolve } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { readActiveEnv, writeActiveEnv, clearActiveEnv } from "../lib/active_env.js";

function findProjectRoot(): string {
  return process.cwd();
}

export async function envShowCommand(): Promise<void> {
  const root = findProjectRoot();
  const active = await readActiveEnv(root);
  if (active) {
    console.log(`Active environment: ${active}`);
    console.log(`  env file:     .env.${active}`);
    console.log(`  secrets file: .env.${active}.secrets`);
  } else {
    console.log("No active environment set (using default .env)");
  }
}

export async function envUseCommand(name: string): Promise<void> {
  const root = findProjectRoot();
  const envPath = resolve(root, `.env.${name}`);

  // Check that the env file exists
  try {
    await stat(envPath);
  } catch {
    console.error(`Error: .env.${name} not found in ${root}`);
    // List available environments as a hint
    const available = await listEnvFiles(root);
    if (available.length > 0) {
      console.error(`Available: ${available.join(", ")}`);
    }
    process.exit(1);
  }

  await writeActiveEnv(root, name);
  console.log(`Switched to environment: ${name}`);
  console.log(`  env file:     .env.${name}`);
  console.log(`  secrets file: .env.${name}.secrets`);
}

export async function envResetCommand(): Promise<void> {
  const root = findProjectRoot();
  await clearActiveEnv(root);
  console.log("Active environment cleared (using default .env)");
}

export async function envListCommand(): Promise<void> {
  const root = findProjectRoot();
  const active = await readActiveEnv(root);
  const envFiles = await listEnvFiles(root);

  if (envFiles.length === 0) {
    console.log("No .env.<name> files found.");
    return;
  }

  console.log("Available environments:");
  for (const name of envFiles) {
    const marker = name === active ? " ← active" : "";
    console.log(`  ${name}${marker}`);
  }
}

async function listEnvFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root);
    return entries
      .filter((f) => f.startsWith(".env.") && !f.endsWith(".secrets") && !f.endsWith(".example"))
      .map((f) => f.slice(5)) // strip ".env." prefix
      .sort();
  } catch {
    return [];
  }
}
