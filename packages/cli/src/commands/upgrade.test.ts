import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { detectGlobalPackageManager, globalInstallCommand } from "./upgrade.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("upgrade installation ownership", () => {
  test.each([
    ["/Users/me/.nvm/versions/node/v24/lib/node_modules/glubean/bin/glubean.js", "npm"],
    ["/Users/me/.nvm/versions/node/v24/lib/node_modules/@glubean/cli/bin/gb.js", "npm"],
    ["/usr/local/lib/node_modules/glubean/bin/glubean.js", "npm"],
    ["/Users/me/Library/pnpm/global/5/.pnpm/glubean@0.10.4/node_modules/glubean/bin/glubean.js", "pnpm"],
    ["/Users/me/.config/yarn/global/node_modules/glubean/bin/glubean.js", "yarn"],
    ["/Users/me/.bun/install/global/node_modules/glubean/bin/glubean.js", "bun"],
  ] as const)("detects %s as %s", (path, expected) => {
    expect(detectGlobalPackageManager(path)).toBe(expected);
  });

  test("does not mistake a project-local CLI for a global install", () => {
    expect(detectGlobalPackageManager("/work/api/node_modules/@glubean/cli/bin/gb.js")).toBeNull();
  });

  test("follows an npm global bin symlink before detecting its owner", () => {
    const prefix = mkdtempSync(join(tmpdir(), "glubean-upgrade-"));
    tempDirs.push(prefix);
    const packageBin = join(prefix, "lib/node_modules/glubean/bin/glubean.js");
    const launcher = join(prefix, "bin/glubean");
    mkdirSync(join(prefix, "lib/node_modules/glubean/bin"), { recursive: true });
    mkdirSync(join(prefix, "bin"), { recursive: true });
    writeFileSync(packageBin, "#!/usr/bin/env node\n");
    symlinkSync("../lib/node_modules/glubean/bin/glubean.js", launcher);

    expect(detectGlobalPackageManager(launcher)).toBe("npm");
  });

  test.each([
    ["npm", "npm", ["install", "-g", "glubean@0.10.5"]],
    ["pnpm", "pnpm", ["add", "-g", "glubean@0.10.5"]],
    ["yarn", "yarn", ["global", "add", "glubean@0.10.5"]],
    ["bun", "bun", ["add", "-g", "glubean@0.10.5"]],
  ] as const)("builds the %s upgrade command", (manager, command, args) => {
    expect(globalInstallCommand(manager, "0.10.5")).toEqual({ command, args });
  });
});
