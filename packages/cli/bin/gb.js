#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = resolve(__dirname, "../src/main.ts");

// Find tsx binary from our own node_modules
const require = createRequire(import.meta.url);
const tsxBin = resolve(dirname(require.resolve("tsx/package.json")), "dist/cli.mjs");

try {
  execFileSync("node", [tsxBin, entry, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd(),
  });
} catch (e) {
  process.exit(e.status ?? 1);
}
