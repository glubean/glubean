import { describe, expect, test } from "vitest";

import { detectGlobalPackageManager, globalInstallCommand } from "./upgrade.js";

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

  test.each([
    ["npm", "npm", ["install", "-g", "glubean@0.10.5"]],
    ["pnpm", "pnpm", ["add", "-g", "glubean@0.10.5"]],
    ["yarn", "yarn", ["global", "add", "glubean@0.10.5"]],
    ["bun", "bun", ["add", "-g", "glubean@0.10.5"]],
  ] as const)("builds the %s upgrade command", (manager, command, args) => {
    expect(globalInstallCommand(manager, "0.10.5")).toEqual({ command, args });
  });
});
