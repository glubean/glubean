#!/usr/bin/env -S deno run -A
/**
 * Bump all workspace package versions to a new semver value.
 *
 * Updates:
 * - Every packages/x/deno.json version field
 * - Cross-references like @glubean/sdk: jsr:@glubean/sdk@^0.10.0
 *
 * Usage:
 *   deno task version 0.10.1
 *   deno task version patch   # 0.10.0 → 0.10.1
 *   deno task version minor   # 0.10.0 → 0.11.0
 *   deno task version major   # 0.10.0 → 1.0.0
 */

import { resolve, basename } from "jsr:@std/path@^1.0.0";

const PACKAGES_DIR = resolve(import.meta.dirname!, "..", "packages");

// Collect all package deno.json paths
const packagePaths: string[] = [];
for await (const entry of Deno.readDir(PACKAGES_DIR)) {
  if (!entry.isDirectory) continue;
  const denoJson = resolve(PACKAGES_DIR, entry.name, "deno.json");
  try {
    await Deno.stat(denoJson);
    packagePaths.push(denoJson);
  } catch {
    // No deno.json in this directory
  }
}

if (packagePaths.length === 0) {
  console.error("No packages found");
  Deno.exit(1);
}

// Read current version from first package
const firstPkg = JSON.parse(await Deno.readTextFile(packagePaths[0]));
const currentVersion = firstPkg.version as string;
const [major, minor, patch] = currentVersion.split(".").map(Number);

// Determine new version
const input = Deno.args[0];
if (!input) {
  console.error(`Current version: ${currentVersion}`);
  console.error("Usage: deno task version <version|patch|minor|major>");
  Deno.exit(1);
}

let newVersion: string;
switch (input) {
  case "patch":
    newVersion = `${major}.${minor}.${patch + 1}`;
    break;
  case "minor":
    newVersion = `${major}.${minor + 1}.0`;
    break;
  case "major":
    newVersion = `${major + 1}.0.0`;
    break;
  default:
    // Validate semver-ish format
    if (!/^\d+\.\d+\.\d+/.test(input)) {
      console.error(`Invalid version: ${input}`);
      Deno.exit(1);
    }
    newVersion = input;
}

if (newVersion === currentVersion) {
  console.log(`Already at ${currentVersion}`);
  Deno.exit(0);
}

// Compute the caret prefix for cross-references: ^0.10.0 → ^0.10.0 stays caret
const newMajor = newVersion.split(".")[0];
const newMinor = newVersion.split(".")[1];
const caretRange = `^${newMajor}.${newMinor}.0`;

console.log(`\n  ${currentVersion} → ${newVersion}\n`);

// Update each package
for (const pkgPath of packagePaths) {
  let content = await Deno.readTextFile(pkgPath);
  const pkg = JSON.parse(content);
  const name = pkg.name as string;
  const pkgDir = basename(resolve(pkgPath, ".."));

  // Update version field
  content = content.replace(
    /"version"\s*:\s*"[^"]+"/,
    `"version": "${newVersion}"`,
  );

  // Update @glubean/* cross-references in imports
  // e.g. "jsr:@glubean/sdk@^0.10.0" → "jsr:@glubean/sdk@^0.11.0"
  content = content.replace(
    /("jsr:@glubean\/[^@]+@)\^?\d+\.\d+\.\d+"/g,
    `$1${caretRange}"`,
  );

  await Deno.writeTextFile(pkgPath, content);
  console.log(`  ✓ ${name} (packages/${pkgDir}/deno.json)`);
}

console.log(`\nDone. All packages bumped to ${newVersion}`);
console.log(`\nNext steps:`);
console.log(`  git add -A && git commit -m "chore: bump version to ${newVersion}"`);
console.log(`  git tag v${newVersion}`);
console.log(`  git push && git push --tags`);
console.log(`  → Then create a GitHub Release from tag v${newVersion}`);
