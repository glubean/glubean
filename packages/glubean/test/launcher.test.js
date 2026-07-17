import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = resolve(packageRoot, "bin/glubean.js");
const globalVersion = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")).version;

function installFakePackage(project, name, version, { launcherMarker } = {}) {
  const root = resolve(project, "node_modules", ...name.split("/"));
  mkdirSync(root, { recursive: true });
  const pkg = {
    name,
    version,
    type: "module",
    main: "./index.js",
    ...(name === "glubean" ? { bin: { glubean: "./bin/glubean.js" } } : {}),
  };
  writeFileSync(resolve(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(resolve(root, "index.js"), "export {};\n");
  if (name === "glubean") {
    mkdirSync(resolve(root, "bin"), { recursive: true });
    writeFileSync(
      resolve(root, "bin/glubean.js"),
      `#!/usr/bin/env node\nconsole.log(${JSON.stringify(launcherMarker ?? "PROJECT-CLI-RAN")});\n`,
    );
  }
}

function makeProject(version) {
  const project = mkdtempSync(resolve(tmpdir(), "glubean-global-launcher-"));
  writeFileSync(
    resolve(project, "package.json"),
    `${JSON.stringify({
      name: "fixture",
      private: true,
      dependencies: {
        glubean: version,
        "@glubean/sdk": version,
        "@glubean/runner": version,
      },
    }, null, 2)}\n`,
  );
  installFakePackage(project, "glubean", version);
  installFakePackage(project, "@glubean/sdk", version);
  installFakePackage(project, "@glubean/runner", version);
  return project;
}

function runGlobal(project) {
  return spawnSync(process.execPath, [launcher, "-V"], {
    cwd: project,
    encoding: "utf8",
    env: process.env,
  });
}

test("global launcher never re-execs a different project-local CLI", () => {
  const project = makeProject("0.0.1");
  const result = runGlobal(project);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), globalVersion);
  assert.doesNotMatch(result.stdout, /PROJECT-CLI-RAN/);
  assert.match(result.stderr, /project version drift detected/i);
  assert.match(result.stderr, new RegExp(`Running the global CLI ${globalVersion.replaceAll(".", "\\.")}`));
});

test("version drift warning stays on stderr so -V stdout remains machine-readable", () => {
  const project = makeProject("0.0.2");
  const result = runGlobal(project);

  assert.equal(result.stdout, `${globalVersion}\n`);
  assert.match(result.stderr, /glubean@0\.0\.2/);
  assert.match(result.stderr, /@glubean\/runner@0\.0\.2/);
  assert.match(result.stderr, /@glubean\/sdk@0\.0\.2/);
});

test("matching project packages do not produce a drift warning", () => {
  const project = makeProject(globalVersion);
  const result = runGlobal(project);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${globalVersion}\n`);
  assert.equal(result.stderr, "");
});
