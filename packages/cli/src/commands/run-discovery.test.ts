import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { discoverTests } from "./run.js";

// Contract fixtures must sit inside the package so dynamic-import in
// extractContractFromFile can resolve `@glubean/sdk` via the workspace.
const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT_FIXTURE_ROOT = join(HERE, "..", "..", ".tmp-run-discovery-contract");
let contractFixtureSeq = 0;
let contractFixtureDir = "";

beforeEach(async () => {
  contractFixtureSeq += 1;
  contractFixtureDir = join(CONTRACT_FIXTURE_ROOT, String(contractFixtureSeq));
  await mkdir(contractFixtureDir, { recursive: true });
});

afterEach(async () => {
  if (contractFixtureDir) {
    await rm(contractFixtureDir, { recursive: true, force: true });
  }
});

afterAll(async () => {
  await rm(CONTRACT_FIXTURE_ROOT, { recursive: true, force: true });
});

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

test("discoverTests emits combined contract+case+runtime tags on contract cases", async () => {
  const filePath = join(contractFixtureDir, "users.contract.ts");
  await writeFile(filePath, `
import { contract } from "@glubean/sdk";

const api = contract.http.with("usersApi", { endpoint: "https://api.example.com" });

export const getUser = api("users.get", {
  endpoint: "GET /users/:id",
  tags: ["users"],
  cases: {
    ok: { description: "200 path", tags: ["smoke"], expect: { status: 200 } },
    manualOnly: { description: "manual only", tags: ["manual"], expect: { status: 200 } },
    browserCase: {
      description: "needs browser",
      requires: "browser",
      tags: ["smoke"],
      expect: { status: 200 },
    },
  },
});
`);

  const tests = await discoverTests(filePath);
  const byId = new Map(tests.map((t) => [t.meta.id, t]));

  // Contract-level "users" tag merges with case-level tags.
  expect(byId.get("users.get.ok")?.meta.tags).toEqual(["users", "smoke"]);
  expect(byId.get("users.get.manualOnly")?.meta.tags).toEqual([
    "users",
    "manual",
  ]);
  // requires:browser case picks up the synthetic runtime tags AND the
  // default-run:opt-in tag (defaultRun derives to "opt-in" when requires
  // is non-headless and the case doesn't override).
  expect(byId.get("users.get.browserCase")?.meta.tags).toEqual([
    "users",
    "smoke",
    "requires:browser",
    "default-run:opt-in",
  ]);
});

test("discoverTests propagates flow tags + only + skip (as deferred)", async () => {
  // Need both a referenced contract (so flow.step() resolves) and the flow.
  const contractPath = join(contractFixtureDir, "users.contract.ts");
  await writeFile(contractPath, `
import { contract } from "@glubean/sdk";

const api = contract.http.with("usersApi", { endpoint: "https://api.example.com" });

export const getUser = api("users.get", {
  endpoint: "GET /users/:id",
  cases: {
    ok: { description: "ok", expect: { status: 200 } },
  },
});
`);

  const flowPath = join(contractFixtureDir, "signup.flow.ts");
  await writeFile(flowPath, `
import { contract } from "@glubean/sdk";
import { getUser } from "./users.contract.js";

export const signup = contract
  .flow("signup-flow")
  .meta({
    tags: ["public-demo", "smoke"],
    only: true,
    skip: "manual review pending",
  })
  .step(getUser.case("ok"))
  .build();
`);

  const tests = await discoverTests(flowPath);
  expect(tests).toHaveLength(1);
  expect(tests[0]).toMatchObject({
    exportName: "signup",
    meta: {
      id: "signup-flow",
      tags: ["public-demo", "smoke"],
      only: true,
      deferred: "manual review pending",
    },
  });
});

test("discoverTests omits flow only/deferred when unset", async () => {
  const contractPath = join(contractFixtureDir, "users.contract.ts");
  await writeFile(contractPath, `
import { contract } from "@glubean/sdk";

const api = contract.http.with("usersApi", { endpoint: "https://api.example.com" });

export const getUser = api("users.get", {
  endpoint: "GET /users/:id",
  cases: {
    ok: { description: "ok", expect: { status: 200 } },
  },
});
`);

  const flowPath = join(contractFixtureDir, "bare.flow.ts");
  await writeFile(flowPath, `
import { contract } from "@glubean/sdk";
import { getUser } from "./users.contract.js";

export const bare = contract
  .flow("bare-flow")
  .step(getUser.case("ok"))
  .build();
`);

  const tests = await discoverTests(flowPath);
  expect(tests).toHaveLength(1);
  const m = tests[0].meta;
  expect(m.tags).toBeUndefined();
  expect(m.only).toBeUndefined();
  expect(m.deferred).toBeUndefined();
});

test("discoverTests omits meta.tags when contract+case have none", async () => {
  const filePath = join(contractFixtureDir, "ping.contract.ts");
  await writeFile(filePath, `
import { contract } from "@glubean/sdk";

const api = contract.http.with("pingApi", { endpoint: "https://api.example.com" });

export const ping = api("ping.get", {
  endpoint: "GET /ping",
  cases: {
    ok: { description: "ok", expect: { status: 200 } },
  },
});
`);

  const tests = await discoverTests(filePath);
  expect(tests).toHaveLength(1);
  expect(tests[0].meta.tags).toBeUndefined();
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
