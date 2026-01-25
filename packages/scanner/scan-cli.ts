#!/usr/bin/env -S deno run -A
/**
 * CLI wrapper for the scanner - used by the server to scan test directories.
 *
 * Usage: deno run -A scan-cli.ts <directory>
 *
 * Outputs JSON result to stdout.
 */

import { scan } from "./mod.ts";

const dir = Deno.args[0];

if (!dir) {
  console.error("Usage: scan-cli.ts <directory>");
  Deno.exit(1);
}

try {
  const result = await scan(dir);
  console.log(JSON.stringify(result));
  Deno.exit(0);
} catch (error) {
  console.error("Scan error:", error.message);
  Deno.exit(1);
}
