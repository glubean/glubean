import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { __testing, discoverTests } from "./run.js";

const { matchesTags } = __testing;

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
        requires: undefined,
        defaultRun: undefined,
        kind: "test",
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

  // Contract case name matches SDK testName format `${id} — ${caseKey}`
  // so --filter (which checks meta.name) is consistent with the runtime.
  expect(byId.get("users.get.ok")?.meta.name).toBe("users.get — ok");
  expect(byId.get("users.get.browserCase")?.meta.name).toBe(
    "users.get — browserCase",
  );
});

test("discoverTests propagates requires + defaultRun + synthetic tags on test()", async () => {
  // .test.ts files don't dynamic-import, so tmpdir is fine here.
  const dir = await mkdtemp(join(tmpdir(), "cli-test-requires-"));
  const filePath = join(dir, "browser-only.test.ts");
  await writeFile(filePath, `
import { test } from "@glubean/sdk";

export const needsBrowser = test(
  { id: "needs-browser", requires: "browser" },
  async () => {},
);

export const optInOnly = test(
  { id: "opt-in", defaultRun: "opt-in", tags: ["smoke"] },
  async () => {},
);

export const plain = test("plain", async () => {});
`);

  try {
    const tests = await discoverTests(filePath);
    const byId = new Map(tests.map((t) => [t.meta.id, t]));

    const browserTest = byId.get("needs-browser")!;
    expect(browserTest.meta.requires).toBe("browser");
    // Non-headless implicitly opt-in (matches contract case derivation):
    // both synthetic tags should be present, like the contract path emits.
    expect(browserTest.meta.tags).toEqual([
      "requires:browser",
      "default-run:opt-in",
    ]);

    const optInTest = byId.get("opt-in")!;
    expect(optInTest.meta.defaultRun).toBe("opt-in");
    expect(optInTest.meta.tags).toEqual(["smoke", "default-run:opt-in"]);

    // Plain headless/always test: no synthetic tags, no meta.tags.
    const plainTest = byId.get("plain")!;
    expect(plainTest.meta.requires).toBeUndefined();
    expect(plainTest.meta.defaultRun).toBeUndefined();
    expect(plainTest.meta.tags).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverTests ignores .meta() calls inside test callback bodies", async () => {
  // Static extractor's scope spans from `test` to next export, so a
  // body-internal `.meta({ requires: "browser" })` could accidentally
  // be parsed as builder metadata — including the harder case where
  // the method chains off a function call (`fn().meta(...)`) which
  // matches a naive `).meta(` anchor.
  const dir = await mkdtemp(join(tmpdir(), "cli-meta-scope-"));
  const filePath = join(dir, "scope-leak.test.ts");
  await writeFile(filePath, `
import { test } from "@glubean/sdk";

export const headlessTest = test("headless-id", async (_ctx) => {
  const client = {
    request: () => ({ meta: (_obj: unknown) => {} }),
    meta: (_obj: unknown) => {},
  };
  client.meta({ requires: "browser" });
  client.request().meta({ requires: "out-of-band" });
});
`);

  try {
    const tests = await discoverTests(filePath);
    expect(tests).toHaveLength(1);
    expect(tests[0].meta.id).toBe("headless-id");
    // Neither the dotted `client.meta(...)` nor the chained
    // `client.request().meta(...)` should bleed into builder metadata.
    expect(tests[0].meta.requires).toBeUndefined();
    expect(tests[0].meta.tags).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverTests fails closed on non-HTTP contract when runtime import fails", async () => {
  // Bad import path forces runtime extraction to fail. The static
  // fallback should NOT fire for non-HTTP protocols because the static
  // extractor cannot represent them — a partial result would silently
  // drop contracts. Matches MCP server's policy.
  const filePath = join(contractFixtureDir, "grpc-broken.contract.ts");
  await writeFile(filePath, `
import { contract } from "@glubean/sdk";
import "this-module-does-not-exist";

export const svc = contract.grpc("user.service", {
  cases: {
    list: { description: "list users" },
  },
});
`);

  // Silence the expected import-error log so test output stays clean.
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const tests = await discoverTests(filePath);
    expect(tests).toEqual([]);
  } finally {
    errSpy.mockRestore();
  }
});

test("discoverTests fails closed when broken file mixes contract.http with contract.flow", async () => {
  // Static extractor can't represent flows. If runtime fails for a mixed
  // file, falling back to static would silently drop the flow runnable
  // — worse than failing closed. CLI gate is stricter than MCP here.
  // Multi-line fluent `contract\n  .flow(...)` chain is the canonical
  // style for non-trivial flows in this repo, so the detector must
  // tolerate whitespace between `contract` and `.flow`.
  const filePath = join(contractFixtureDir, "http-flow-broken.contract.ts");
  await writeFile(filePath, `
import { contract } from "@glubean/sdk";
import "this-module-does-not-exist";

export const ping = contract.http("ping", {
  endpoint: "GET /ping",
  cases: { ok: { description: "ok", expect: { status: 200 } } },
});

export const userFlow = contract
  .flow("user-flow")
  .build();
`);

  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const tests = await discoverTests(filePath);
    expect(tests).toEqual([]);
  } finally {
    errSpy.mockRestore();
  }
});

test("discoverTests static fallback fires for HTTP-only file with broken import", async () => {
  // Same broken-import scenario but file is pure HTTP — static fallback
  // IS allowed, since the static extractor faithfully represents HTTP
  // contracts. Confirms the fail-closed gate doesn't over-fire.
  const filePath = join(contractFixtureDir, "http-broken.contract.ts");
  await writeFile(filePath, `
import { contract } from "@glubean/sdk";
import "this-module-does-not-exist";

export const ping = contract.http("ping", {
  endpoint: "GET /ping",
  cases: {
    ok: { description: "200 path", expect: { status: 200 } },
  },
});
`);

  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const tests = await discoverTests(filePath);
    expect(tests).toHaveLength(1);
    expect(tests[0].meta.id).toBe("ping.ok");
    expect(tests[0].meta.name).toBe("ping — ok");
  } finally {
    errSpy.mockRestore();
  }
});

test("discoverTests ignores .meta() in sibling expressions between exports", async () => {
  // Previously builderChainScope ran until the next `export`, so a
  // sibling expression with `().meta({ requires: "browser" })` between
  // a test() and the next export could mis-attribute browser metadata.
  // The depth-0-semicolon bound stops scope at the test statement's end.
  const dir = await mkdtemp(join(tmpdir(), "cli-sibling-meta-"));
  const filePath = join(dir, "sibling-leak.test.ts");
  await writeFile(filePath, `
import { test } from "@glubean/sdk";

export const headless = test("plain-test", async (_ctx) => {});

const _stray = (() => ({ meta: (_o: unknown) => {} }))().meta({ requires: "browser" });

export const another = test("another", async (_ctx) => {});
`);

  try {
    const tests = await discoverTests(filePath);
    expect(tests).toHaveLength(2);
    const byId = new Map(tests.map((t) => [t.meta.id, t]));
    expect(byId.get("plain-test")?.meta.requires).toBeUndefined();
    expect(byId.get("another")?.meta.requires).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--tag selects test() + contract case + flow uniformly when all share a tag", async () => {
  // Phase 2 task 6: positive --tag matching must hit all three discovery
  // kinds. Composed regression — earlier tests cover each kind in
  // isolation; this one wires them together so a single matchesTags
  // call sees the full set.
  const testPath = join(contractFixtureDir, "thing.test.ts");
  await writeFile(testPath, `
import { test } from "@glubean/sdk";
export const smokeTest = test(
  { id: "smoke-test", tags: ["smoke"] },
  async () => {},
);
`);

  const contractPath = join(contractFixtureDir, "users.contract.ts");
  await writeFile(contractPath, `
import { contract } from "@glubean/sdk";

const api = contract.http.with("usersApi", { endpoint: "https://api.example.com" });

export const getUser = api("users.get", {
  endpoint: "GET /users/:id",
  cases: {
    ok: { description: "ok", tags: ["smoke"], expect: { status: 200 } },
    cold: { description: "cold path", expect: { status: 200 } },
  },
});
`);

  const flowPath = join(contractFixtureDir, "signup.flow.ts");
  await writeFile(flowPath, `
import { workflow } from "@glubean/sdk";
import { getUser } from "./users.contract.js";

export const signup = workflow({ id: "signup-flow", tags: ["smoke", "public-demo"] })
  .call("get-user", getUser.case("ok"))
  .build();
`);

  const testResults = await discoverTests(testPath);
  const contractResults = await discoverTests(contractPath);
  const flowResults = await discoverTests(flowPath);

  const all = [...testResults, ...contractResults, ...flowResults];
  const selected = all.filter((t) => matchesTags(t, ["smoke"]));
  const selectedIds = selected.map((t) => t.meta.id).sort();
  expect(selectedIds).toEqual(["signup-flow", "smoke-test", "users.get.ok"]);

  const notSmoke = all.filter((t) => !matchesTags(t, ["smoke"]));
  expect(notSmoke.map((t) => t.meta.id)).toEqual(["users.get.cold"]);
});

test("discoverTests propagates workflow tags + only + skip (as deferred)", async () => {
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
import { workflow } from "@glubean/sdk";
import { getUser } from "./users.contract.js";

export const signup = workflow({
  id: "signup-flow",
  tags: ["public-demo", "smoke"],
  only: true,
  skip: "manual review pending",
})
  .call("get-user", getUser.case("ok"))
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

test("discoverTests omits workflow only/deferred when unset", async () => {
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
import { workflow } from "@glubean/sdk";
import { getUser } from "./users.contract.js";

export const bare = workflow("bare-flow")
  .call("get-user", getUser.case("ok"))
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
