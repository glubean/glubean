import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, expect, test } from "vitest";

import { runCli } from "../test-helpers.js";

const fixtureDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    fixtureDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test("an explicitly targeted browser journey with an unrecognized suffix gets a naming hint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "glubean-browser-filename-"));
  fixtureDirs.push(dir);
  await writeFile(
    join(dir, "login.journey.ts"),
    `// @contract\nexport const loginJourney = { cases: {} };\n`,
    "utf-8",
  );

  const { code, stdout, stderr } = await runCli(
    ["run", "login.journey.ts", "--no-session"],
    { cwd: dir },
  );
  const output = stdout + stderr;

  expect(code).not.toBe(0);
  expect(output).toContain("No test cases found");
  expect(output).toContain("Name browser journeys *.browser.ts or *.contract.ts");
  expect(output).toContain("login.journey.ts are not imported as contracts");
});
