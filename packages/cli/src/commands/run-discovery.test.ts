import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { discoverTests } from "./run.js";

test("discoverTests keeps one parallel test.each template sentinel with grouping metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-data-driven-"));
  const filePath = join(dir, "cases.test.ts");
  await writeFile(filePath, `
import { test } from "@glubean/sdk";

export const cases = test.each([
  { id: "alpha" },
  { id: "beta" },
  { id: "gamma" },
], { parallel: true })(
  { id: "case-$id", name: "case $id", tags: ["data"] },
  async (_ctx, _row) => {},
);
`);

  try {
    const tests = await discoverTests(filePath);
    expect(tests).toHaveLength(1);
    expect(tests[0]).toEqual({
      exportName: "cases",
      meta: {
        id: "case-$id",
        name: "case $id",
        tags: ["data"],
        timeout: undefined,
        skip: undefined,
        only: undefined,
        groupId: "case-$id",
        parallel: true,
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverTests keeps one test.pick template sentinel with grouping metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-pick-"));
  const filePath = join(dir, "pick.test.ts");
  await writeFile(filePath, `
import { test } from "@glubean/sdk";

export const picked = test.pick({
  alpha: { q: "a" },
  beta: { q: "b" },
  gamma: { q: "g" },
})(
  { id: "pick-$_pick", name: "pick $_pick" },
  async (_ctx, _row) => {},
);
`);

  try {
    const tests = await discoverTests(filePath);
    expect(tests).toHaveLength(1);
    expect(tests[0]).toMatchObject({
      exportName: "picked",
      meta: {
        id: "pick-$_pick",
        name: "pick $_pick",
        groupId: "pick-$_pick",
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
