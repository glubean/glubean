import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const CORE_PROJECT_PACKAGES = ["glubean", "@glubean/cli", "@glubean/sdk", "@glubean/runner"];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function realpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function findPackageRoot(startFile, expectedName) {
  let dir = dirname(startFile);
  for (let depth = 0; depth < 24; depth += 1) {
    const packagePath = resolve(dir, "package.json");
    if (existsSync(packagePath)) {
      const pkg = readJson(packagePath);
      if (pkg?.name === expectedName) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function nearestProjectPackage(cwd) {
  let dir = resolve(cwd);
  for (let depth = 0; depth < 24; depth += 1) {
    const packagePath = resolve(dir, "package.json");
    if (existsSync(packagePath)) {
      const pkg = readJson(packagePath);
      if (pkg) return pkg;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function declaredGlubeanPackages(cwd) {
  const pkg = nearestProjectPackage(cwd);
  if (!pkg) return [];
  const sections = [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies, pkg.peerDependencies];
  return sections
    .flatMap((section) => (section && typeof section === "object" ? Object.keys(section) : []))
    .filter((name) => name === "glubean" || name.startsWith("@glubean/"));
}

function resolveInstalledPackage(req, name) {
  try {
    const entry = req.resolve(name === "glubean" ? "glubean/bin/glubean.js" : name);
    const root = findPackageRoot(entry, name);
    if (!root) return null;
    const pkg = readJson(resolve(root, "package.json"));
    return typeof pkg?.version === "string" ? { name, version: pkg.version, root } : null;
  } catch {
    return null;
  }
}

export function detectProjectVersionDrift({ cwd, launcherPath }) {
  const launcher = realpath(launcherPath);
  const globalPackage = readJson(resolve(dirname(launcher), "../package.json"));
  const globalVersion = globalPackage?.version;
  if (typeof globalVersion !== "string") return null;

  const req = createRequire(resolve(cwd, "__glubean_project_version_stub__.js"));
  const localMeta = resolveInstalledPackage(req, "glubean");

  // An explicitly selected project-local meta launcher remains local. The
  // global-only rule applies when the shell selected a different launcher.
  if (localMeta && realpath(resolve(localMeta.root, "bin/glubean.js")) === launcher) {
    return null;
  }

  const names = [...new Set([...CORE_PROJECT_PACKAGES, ...declaredGlubeanPackages(cwd)])];
  const installed = names
    .map((name) => resolveInstalledPackage(req, name))
    .filter((pkg) => pkg !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  const mismatches = installed.filter((pkg) => pkg.version !== globalVersion);
  if (mismatches.length === 0) return null;

  return { globalVersion, mismatches };
}

export function formatProjectVersionDrift({ globalVersion, mismatches }) {
  const projectVersions = mismatches.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ");
  return [
    `⚠ Glubean project version drift detected: global CLI ${globalVersion}; project ${projectVersions}.`,
    `  Running the global CLI ${globalVersion}. Project scripts and VS Code may still use project-local versions.`,
  ].join("\n");
}
