import { test, expect } from "vitest";
import {
  extractAliasesFromSource,
  extractWorkflowExtendAliasesFromSource,
  buildWorkflowFnRegistry,
  resolveExternalWorkflowFns,
  isGlubeanFile,
} from "./extractor-static.js";
// P1/P2/P1-pick: extractFromSource + extractContractCases + extractPickExamples are
// now AST-based (@babel/parser). The existing suites run unchanged against them as
// the conformance contract.
import { extractFromSource, extractContractCases, extractPickExamples, extractFlows } from "./extractor-ast.js";

// =============================================================================
// Empty / no-export cases
// =============================================================================

test("extractFromSource returns empty array for empty content", () => {
  expect(extractFromSource("")).toEqual([]);
});

test("extractFromSource returns empty array when no test exports exist", () => {
  const content = `
import { something } from "some-lib";

export const helper = () => "not a test";
const internal = test("hidden", async () => {});
`;
  expect(extractFromSource(content)).toEqual([]);
});

// =============================================================================
// Simple test — string ID
// =============================================================================

test("extracts simple test with string ID", () => {
  const content = `
import { test } from "@glubean/sdk";

export const healthCheck = test("health-check", async (ctx) => {
  const res = await ctx.http.get(ctx.vars.require("BASE_URL"));
  ctx.assert(res.ok, "Should be healthy");
});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].type).toBe("test");
  expect(result[0].id).toBe("health-check");
  expect(result[0].exportName).toBe("healthCheck");
  expect(result[0].name).toBeUndefined();
  expect(result[0].tags).toBeUndefined();
  expect(result[0].steps).toBeUndefined();
});

// =============================================================================
// vNext workflow — discovered as a runnable test (S2.5)
// =============================================================================

test("extracts a workflow() export (built or not) as a runnable test", () => {
  const content = `
import { workflow } from "@glubean/sdk";

export const signup = workflow("signup-journey")
  .meta({ name: "Signup Journey", tags: ["journey"] })
  .setup(async () => ({ email: "a@b.c" }))
  .action("seed", async (ctx, s) => s)
  .check("verify", async (ctx, s) => {})
  .build();

export const unbuilt = workflow({ id: "wf-unbuilt", tags: ["journey"] })
  .compute("derive", (s) => s);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(2);
  expect(result[0]).toMatchObject({
    type: "test",
    id: "signup-journey",
    exportName: "signup",
    name: "Signup Journey",
    tags: ["journey"],
    workflow: true, // static marker — classifies as a graph orchestrator (S2.6 R10)
  });
  expect(result[0].workflowHasBranchOrPoll).toBeUndefined(); // linear chain
  expect(result[1]).toMatchObject({ type: "test", id: "wf-unbuilt", exportName: "unbuilt", workflow: true });
});

test("aliased workflow imports are still classified as workflows (S2.6 R12)", () => {
  const content = `
import { workflow as journeyTest } from "@glubean/sdk";
import { workflow as wf } from "@glubean/sdk";

// alias satisfying the *Test convention — must NOT pass as a plain test
export const j = journeyTest("aliased-branched")
  .setup(async () => ({ ok: true }))
  .branch("route", {
    when: (w) => w.when((s) => s.ok).eq(true),
    then: (b) => b.compute("c", (s) => s),
  })
  .build();

// alias matching NO convention — must still be discovered AND classified
export const w = wf("aliased-linear").compute("c", (s) => s).build();
`;
  const result = extractFromSource(content);
  const byId = Object.fromEntries(
    result.map((m) => [m.id, [m.workflow ?? false, m.workflowHasBranchOrPoll ?? false]]),
  );
  expect(byId).toEqual({
    "aliased-branched": [true, true],
    "aliased-linear": [true, false],
  });
});

test("workflow.each factory bodies are scanned for builder-rooted branch/poll (S2.12 R1)", () => {
  const content = `
import { workflow } from "@glubean/sdk";

export const matrix = workflow.each([{ region: "us" }])(
  { id: "m-$region", parallel: true },
  (wf, row) =>
    wf.setup(async () => ({}))
      .branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (b) => b.compute("c", (s) => s) }),
);

export const clean = workflow.each([{ region: "us" }])(
  { id: "c-$region" },
  (wf, row) =>
    wf.setup(async () => ({}))
      .action("probe", async (ctx, s) => { await client.poll(); return s; }), // foreign receiver — no flag
);
`;
  const result = extractFromSource(content);
  const byId = Object.fromEntries(
    result.map((m) => [m.id, [m.workflowHasBranchOrPoll ?? false, m.parallel ?? false]]),
  );
  expect(byId).toEqual({
    "m-$region": [true, true], // builder-rooted .branch( flagged; meta parallel parsed
    "c-$region": [false, false], // client.poll() inside the factory must NOT flag
  });
});

test("a nested closure capturing the builder is flagged; redeclared names stay clean (S2.12 R12)", () => {
  const content = `
import { workflow } from "@glubean/sdk";

// closure HIDES the branch — must flag
export const hidden = workflow.each([{ region: "us" }])(
  { id: "hi-$region" },
  (wf, row) => {
    const make = () => wf.branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (x) => x.compute("c", (s) => s) });
    return make();
  },
);

// nested callback REDECLARES the name with a foreign value — must NOT flag
export const redeclared = workflow.each([{ region: "us" }])(
  { id: "re-$region" },
  (wf, row) =>
    wf.setup(async () => ({}))
      .action("probe", async (ctx, s) => {
        const wf = makeClient();
        await wf.poll();
        return s;
      }),
);
`;
  const result = extractFromSource(content);
  const byId = Object.fromEntries(result.map((m) => [m.id, m.workflowHasBranchOrPoll ?? false]));
  expect(byId).toEqual({ "hi-$region": true, "re-$region": false });
});

test("imported extended factories classify via externalWorkflowFns (S2.15 R5)", () => {
  // fixtures.ts: export const wf = workflow.extend({...})
  const fixturesContent = `
import { workflow } from "@glubean/sdk";
export const wf = workflow.extend({ inbox: () => ({}) });
export const wf2 = wf.extend({ auth: () => "t" });
`;
  expect(extractWorkflowExtendAliasesFromSource(fixturesContent).sort()).toEqual(["wf", "wf2"]);
  // …and a NON-workflow extend (test.extend) is NOT classified as workflow
  const testFixtures = `
import { test } from "@glubean/sdk";
export const authedTest = test.extend({ auth: () => "t" });
`;
  expect(extractWorkflowExtendAliasesFromSource(testFixtures)).toEqual([]);

  // consumer.test.ts: imports wf — module-aware resolution (codex R7): the
  // registry ties names to DEFINING FILES; resolveExternalWorkflowFns walks
  // this file's imports and yields the LOCAL names that genuinely match.
  const registry = new Map([["wf", ["/proj/tests/fixtures.ts"]]]);
  const consumer = `
import { wf } from "./fixtures";
export const journey = wf("wfx-imported")
  .setup(async (ctx) => ({ ok: true }))
  .branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (x) => x.compute("c", (s) => s) })
  .build();
`;
  const resolved = resolveExternalWorkflowFns(consumer, "/proj/tests/checkout.test.ts", registry);
  expect(resolved).toEqual(["wf"]);
  const withClassification = extractFromSource(consumer, ["wf"], resolved);
  expect(withClassification[0]).toMatchObject({
    id: "wfx-imported",
    workflow: true,
    workflowHasBranchOrPoll: true,
  });

  // import RENAME maps to the LOCAL name (codex R6/R7)
  const renamed = `
import { wf as journey } from "./fixtures";
export const j = journey("wfx-renamed")
  .setup(async (ctx) => ({}))
  .compute("c", (s) => s)
  .build();
`;
  const renResolved = resolveExternalWorkflowFns(renamed, "/proj/tests/a.test.ts", registry);
  expect(renResolved).toEqual(["journey"]);
  const viaRename = extractFromSource(renamed, ["wf", "journey"], renResolved);
  expect(viaRename[0]).toMatchObject({ id: "wfx-renamed", workflow: true });

  // an import of an UNRELATED same-name symbol (different source file) — no match
  const unrelatedImport = `
import { wf } from "./helpers/other";
export const notAWorkflow = wf("plain-thing");
`;
  expect(
    resolveExternalWorkflowFns(unrelatedImport, "/proj/tests/b.test.ts", registry),
  ).toEqual([]);

  // a LOCAL `wf` (no import at all) — no match either
  const unrelatedLocal = `
const wf = (id) => makeSomething(id);
export const notAWorkflow = wf("plain-thing");
`;
  expect(resolveExternalWorkflowFns(unrelatedLocal, "/proj/tests/c.test.ts", registry)).toEqual(
    [],
  );

  // duplicate names across fixtures modules: each definer matches (codex R8)
  const dupRegistry = new Map([
    ["wf", ["/proj/a/fixtures.ts", "/proj/b/fixtures.ts"]],
  ]);
  expect(
    resolveExternalWorkflowFns(
      `import { wf } from "../b/fixtures";
export const x = wf("id");`,
      "/proj/c/u.test.ts",
      dupRegistry,
    ),
  ).toEqual(["wf"]);

  // TYPE-ANNOTATED fixture exports register (codex R13)
  expect(
    extractWorkflowExtendAliasesFromSource(
      `import { workflow } from "@glubean/sdk";
export const wf: ExtendedWorkflowFactory<MyCtx> = workflow.extend({ a: () => 1 });`,
    ),
  ).toEqual(["wf"]);

  // ROOT-LEVEL consumer (no directory separator in its path) resolves ./siblings (codex R13)
  expect(
    resolveExternalWorkflowFns(
      `import { wf } from "./fixtures";
export const x = wf("id");`,
      "smoke.test.ts",
      new Map([["wf", ["fixtures.ts"]]]),
    ),
  ).toEqual(["wf"]);

  // ESM-style `.js` specifier resolves to the .ts source (codex R10)
  expect(
    resolveExternalWorkflowFns(
      `import { wf } from "./fixtures.js";
export const x = wf("id");`,
      "/proj/tests/esm.test.ts",
      new Map([["wf", ["/proj/tests/fixtures.ts"]]]),
    ),
  ).toEqual(["wf"]);

  // .mjs fixture modules match symmetrically (codex R11)
  expect(
    resolveExternalWorkflowFns(
      `import { wf } from "./fixtures.mjs";
export const x = wf("id");`,
      "/proj/tests/m.test.ts",
      new Map([["wf", ["/proj/tests/fixtures.mjs"]]]),
    ),
  ).toEqual(["wf"]);

  // CHAINED fixtures across files reach the registry fixed point (codex R9):
  // base.ts defines wf; auth.ts re-extends it; the consumer imports authed.
  const chainedRegistry = buildWorkflowFnRegistry([
    {
      path: "/proj/fixtures/base.ts",
      content: `import { workflow } from "@glubean/sdk";
export const wf = workflow.extend({ a: () => 1 });`,
    },
    {
      path: "/proj/fixtures/auth.ts",
      content: `import { wf } from "./base";
export const authed = wf.extend({ auth: () => "t" });`,
    },
  ]);
  expect(chainedRegistry.get("wf")).toEqual(["/proj/fixtures/base.ts"]);
  expect(chainedRegistry.get("authed")).toEqual(["/proj/fixtures/auth.ts"]);
  expect(
    resolveExternalWorkflowFns(
      `import { authed } from "../fixtures/auth";
export const x = authed("id");`,
      "/proj/tests/y.test.ts",
      chainedRegistry,
    ),
  ).toEqual(["authed"]);

  // BARREL re-exports make the barrel a definer too (codex R14)
  const barrelRegistry = buildWorkflowFnRegistry([
    {
      path: "/proj/fixtures/base.ts",
      content: `import { workflow } from "@glubean/sdk";
export const wf = workflow.extend({ a: () => 1 });`,
    },
    {
      path: "/proj/fixtures/index.ts",
      content: `export { wf } from "./base";
export { wf as journey } from "./base";`,
    },
  ]);
  expect(barrelRegistry.get("wf")?.sort()).toEqual([
    "/proj/fixtures/base.ts",
    "/proj/fixtures/index.ts",
  ]);
  expect(barrelRegistry.get("journey")).toEqual(["/proj/fixtures/index.ts"]);
  expect(
    resolveExternalWorkflowFns(
      `import { wf } from "../fixtures";
export const x = wf("id");`,
      "/proj/tests/z.test.ts",
      barrelRegistry,
    ),
  ).toEqual(["wf"]);

  // export * barrels forward every name (codex R14)
  const starRegistry = buildWorkflowFnRegistry([
    {
      path: "/proj/fixtures/base.ts",
      content: `import { workflow } from "@glubean/sdk";
export const wf = workflow.extend({ a: () => 1 });`,
    },
    {
      path: "/proj/fixtures/index.ts",
      content: `export * from "./base";`,
    },
  ]);
  expect(starRegistry.get("wf")?.sort()).toEqual([
    "/proj/fixtures/base.ts",
    "/proj/fixtures/index.ts",
  ]);

  // a LOCAL re-extend of an imported factory classifies too (codex R8):
  // pre-resolved names seed the extend fixed point
  const reExtend = `
import { wf } from "./fixtures";
const authed = wf.extend({ auth: () => "t" });
export const j = authed("wfx-reextend")
  .setup(async () => ({}))
  .compute("c", (s) => s)
  .build();
`;
  const reExtendMetas = extractFromSource(reExtend, ["wf", "authed"], ["wf"]);
  expect(reExtendMetas[0]).toMatchObject({ id: "wfx-reextend", workflow: true });
});

test("inline extended each is discovered (S2.15 R4)", () => {
  const content = `
import { workflow } from "@glubean/sdk";
export const matrix = workflow.extend({ auth: () => "t" }).each([{ region: "us" }])(
  { id: "wfx-each-$region" },
  (wf, row) => wf.setup(async (ctx) => ({ t: ctx.auth })).compute("c", (s) => s),
);
`;
  const result = extractFromSource(content);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ id: "wfx-each-$region", workflow: true });
});

test("CHAINED extend in one expression — bound and inline (S2.15 R3)", () => {
  const content = `
import { workflow } from "@glubean/sdk";

const wf = workflow.extend({ a: () => 1 }).extend({ b: () => 2 });
export const bound = wf("wfx-chain-bound")
  .setup(async () => ({}))
  .compute("c", (s) => s)
  .build();

export const inline = workflow.extend({ a: () => 1 }).extend({ b: () => 2 })("wfx-chain-inline")
  .setup(async () => ({ ok: true }))
  .branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (x) => x.compute("c2", (s) => s) })
  .build();
`;
  const result = extractFromSource(content);
  const byId = Object.fromEntries(
    result.map((m) => [m.id, [m.workflow ?? false, m.workflowHasBranchOrPoll ?? false]]),
  );
  expect(byId).toEqual({
    "wfx-chain-bound": [true, false],
    "wfx-chain-inline": [true, true],
  });
});

test("INLINE workflow.extend factories are discovered too (S2.15 R2)", () => {
  const content = `
import { workflow } from "@glubean/sdk";
export const oneShot = workflow.extend({ inbox: () => ({}) })("wfx-inline")
  .setup(async (ctx) => ({ ok: true }))
  .branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (x) => x.compute("c", (s) => s) })
  .build();
`;
  const result = extractFromSource(content);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    id: "wfx-inline",
    workflow: true,
    workflowHasBranchOrPoll: true,
  });
});

test("workflow.extend factories are recognized as workflow factories (S2.15)", () => {
  const content = `
import { workflow as base } from "@glubean/sdk";

const workflow2 = base.extend({ inbox: () => ({}) });
const workflow3 = workflow2.extend({ auth: () => "t" });

export const extended = workflow2("wfx-one")
  .setup(async (ctx) => ({}))
  .compute("c", (s) => s)
  .build();

export const chained = workflow3("wfx-two")
  .setup(async (ctx) => ({ ok: true }))
  .branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (x) => x.compute("c2", (s) => s) })
  .build();
`;
  const result = extractFromSource(content);
  const byId = Object.fromEntries(
    result.map((m) => [m.id, [m.workflow ?? false, m.workflowHasBranchOrPoll ?? false]]),
  );
  expect(byId).toEqual({
    "wfx-one": [true, false],
    "wfx-two": [true, true], // chained extend + branch still gated
  });
});

test(".group() bodies are scanned like fragments (S2.14)", () => {
  const content = `
import { workflow } from "@glubean/sdk";
import { payBody } from "./helpers";

// inline group body with a branch — flagged
export const gBranch = workflow("g-branch")
  .setup(async () => ({ ok: true }))
  .group("pay", (b) => b.branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (x) => x.compute("c", (s) => s) }))
  .build();

// inline LINEAR group — clean
export const gLinear = workflow("g-linear")
  .setup(async () => ({ n: 1 }))
  .group("pay", (b) => b.compute("bump", (s) => ({ n: s.n + 1 })))
  .build();

// delegated body — fail closed
export const gDelegated = workflow("g-delegated")
  .setup(async () => ({}))
  .group("pay", payBody)
  .build();
`;
  const result = extractFromSource(content);
  const byId = Object.fromEntries(result.map((m) => [m.id, m.workflowHasBranchOrPoll ?? false]));
  expect(byId).toEqual({
    "g-branch": true,
    "g-linear": false,
    "g-delegated": true,
  });
});

test(".use() fragments: inline scanned precisely; references fail closed (S2.13)", () => {
  const content = `
import { workflow } from "@glubean/sdk";
import { importedFragment } from "./fragments";

// inline fragment WITH a branch — must flag
export const inlineBranch = workflow("u-branch")
  .setup(async () => ({ ok: true }))
  .use((b) => b.branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (x) => x.compute("c", (s) => s) }))
  .build();

// inline LINEAR fragment — must NOT flag
export const inlineLinear = workflow("u-linear")
  .setup(async () => ({ n: 1 }))
  .use((b) => b.compute("bump", (s) => ({ n: s.n + 1 })))
  .build();

// imported fragment reference — uninspectable, fails closed
export const delegated = workflow("u-delegated")
  .setup(async () => ({}))
  .use(importedFragment)
  .build();
`;
  const result = extractFromSource(content);
  const byId = Object.fromEntries(result.map((m) => [m.id, m.workflowHasBranchOrPoll ?? false]));
  expect(byId).toEqual({
    "u-branch": true,
    "u-linear": false,
    "u-delegated": true, // fail closed
  });
});

test("a TS `this` parameter does not displace the builder param (S2.13 R21)", () => {
  const content = `
import { workflow } from "@glubean/sdk";
export const thisParam = workflow("u-this-param")
  .setup(async () => ({ ok: true }))
  .use(function (this: void, b) {
    return b.branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (x) => x.compute("c", (s) => s) });
  })
  .build();
`;
  const result = extractFromSource(content);
  expect(result[0].workflowHasBranchOrPoll).toBe(true);
});

test("a closure under a block-local shadow is NOT scanned against the outer builder (S2.13 R20)", () => {
  const content = `
import { workflow } from "@glubean/sdk";
import { makeClient, retry } from "./helpers";
export const blockClosure = workflow("u-block-closure")
  .setup(async () => ({}))
  .use((b) => b.action("probe", async () => {
    {
      const b = makeClient();          // block-local foreign shadow
      await retry(() => b.poll());     // closure captures the SHADOW, not the builder
    }
  }))
  .build();
`;
  const result = extractFromSource(content);
  expect(result[0].workflowHasBranchOrPoll ?? false).toBe(false); // linear — no false flag
});

test("a foreign 'use' on a tainted container fails closed (S2.13 R19)", () => {
  const content = `
import { workflow } from "@glubean/sdk";
import { importedRunner } from "./helpers";
export const fakeUse = workflow("u-fake-use")
  .setup(async () => ({}))
  .use((b) => {
    const h = { b, use: importedRunner };
    return h.use((x) => x.compute("c", (s) => s));
  })
  .build();
`;
  const result = extractFromSource(content);
  expect(result[0].workflowHasBranchOrPoll).toBe(true);
});

test("a builder-method NAME on a tainted container is still foreign (S2.13 R18)", () => {
  const content = `
import { workflow } from "@glubean/sdk";
import { makeFlow } from "./helpers";

// container smuggles a foreign fn under a builder-method name — closure deep-checked
export const disguised = workflow("u-disguised")
  .setup(async () => ({}))
  .use((b) => {
    const h = { b, compute: makeFlow };
    return h.compute(() => b);
  })
  .build();

// …while a DIRECT chain alias keeps the own-chain exemption (no false flag)
export const directAlias = workflow("u-direct-alias")
  .setup(async () => ({ n: 1 }))
  .use((b) => {
    const c = b.compute("bump", (s) => ({ n: s.n + 1 }));
    return c.check("ok", async (ctx, s) => { const fn = () => s.n; fn(); });
  })
  .build();
`;
  const result = extractFromSource(content);
  const byId = Object.fromEntries(result.map((m) => [m.id, m.workflowHasBranchOrPoll ?? false]));
  expect(byId).toEqual({
    "u-disguised": true,
    "u-direct-alias": false,
  });
});

test("constructor delegation and live-container callbacks fail closed (S2.13 R17)", () => {
  const content = `
import { workflow } from "@glubean/sdk";
import { Fragment, makeFlow } from "./helpers";

export const ctor = workflow("u-ctor")
  .setup(async () => ({}))
  .use((b) => new Fragment(b).chain)
  .build();

export const containerMethod = workflow("u-container-method")
  .setup(async () => ({}))
  .use((b) => {
    const h = { b, makeFlow };
    return h.makeFlow(() => b);
  })
  .build();
`;
  const result = extractFromSource(content);
  const byId = Object.fromEntries(result.map((m) => [m.id, m.workflowHasBranchOrPoll ?? false]));
  expect(byId).toEqual({
    "u-ctor": true,
    "u-container-method": true,
  });
});

test("TS expression wrappers and logical assignments cannot hide a builder (S2.13 R16)", () => {
  const content = `
import { workflow } from "@glubean/sdk";
import { makeFlow } from "./helpers";

// builder behind \`as any\` inside a wrapper object — still delegation
export const asAny = workflow("u-as-any")
  .setup(async () => ({}))
  .use((b) => makeFlow({ b: b as any }))
  .build();

// builder stored via logical assignment — alias taints
export const logicalAssign = workflow("u-logical-assign")
  .setup(async () => ({ ok: true }))
  .use((b) => {
    let x;
    x ??= b;
    return x.branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (y) => y.compute("c", (s) => s) });
  })
  .build();
`;
  const result = extractFromSource(content);
  const byId = Object.fromEntries(result.map((m) => [m.id, m.workflowHasBranchOrPoll ?? false]));
  expect(byId).toEqual({
    "u-as-any": true,
    "u-logical-assign": true,
  });
});

test("closure capture to foreign calls flags; TS type args don't taint (S2.13 R15)", () => {
  const content = `
import { workflow } from "@glubean/sdk";
import { makeFlow, makeClient } from "./helpers";

// a closure CAPTURING the builder handed to a foreign call — fail closed
export const closureCapture = workflow("u-closure-capture")
  .setup(async () => ({}))
  .use((b) => makeFlow(() => b))
  .build();

// a TYPE argument colliding with the builder name — type-only, clean
export const typeArg = workflow("u-type-arg")
  .setup(async () => ({}))
  .use((b) => b.action("probe", async (ctx, s) => {
    const client = makeClient<b>();
    await client.poll();
    return s;
  }))
  .build();
`;
  const result = extractFromSource(content);
  const byId = Object.fromEntries(result.map((m) => [m.id, m.workflowHasBranchOrPoll ?? false]));
  expect(byId).toEqual({
    "u-closure-capture": true,
    "u-type-arg": false,
  });
});

test("member writes and expression receivers cannot hide a branch (S2.13 R14)", () => {
  const content = `
import { workflow } from "@glubean/sdk";
import { other } from "./helpers";

export const memberWrite = workflow("u-member-write")
  .setup(async () => ({ ok: true }))
  .use((b) => {
    const h = {};
    h.b = b;
    return h.b.branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (y) => y.compute("c", (s) => s) });
  })
  .build();

export const condReceiver = workflow("u-cond-receiver")
  .setup(async () => ({ ok: true }))
  .use((b) => (Math.random() > 0.5 ? b : other).branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (y) => y.compute("c", (s) => s) }))
  .build();
`;
  const result = extractFromSource(content);
  const byId = Object.fromEntries(result.map((m) => [m.id, m.workflowHasBranchOrPoll ?? false]));
  expect(byId).toEqual({
    "u-member-write": true,
    "u-cond-receiver": true,
  });
});

test("destructuring defaults and extracted method aliases cannot hide a branch (S2.13 R13)", () => {
  const content = `
import { workflow } from "@glubean/sdk";

// builder smuggled through a destructuring DEFAULT with a clean RHS — flagged
export const destrDefault = workflow("u-destr-default")
  .setup(async () => ({ ok: true }))
  .use((b) => {
    const { x = b } = {};
    return x.branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (y) => y.compute("c", (s) => s) });
  })
  .build();

// extracted method alias called bare — flagged (fail closed)
export const extracted = workflow("u-extracted")
  .setup(async () => ({ ok: true }))
  .use((b) => {
    const branch = b.branch;
    return branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (y) => y.compute("c", (s) => s) });
  })
  .build();
`;
  const result = extractFromSource(content);
  const byId = Object.fromEntries(result.map((m) => [m.id, m.workflowHasBranchOrPoll ?? false]));
  expect(byId).toEqual({
    "u-destr-default": true,
    "u-extracted": true,
  });
});

test("a closure inside a parameter default cannot hide a branch (S2.13 R12)", () => {
  const content = `
import { workflow } from "@glubean/sdk";
export const initClosure = workflow("u-init-closure")
  .setup(async () => ({ ok: true }))
  .use((b) => {
    const make = (x = () => b.branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (y) => y.compute("c", (s) => s) })) => x();
    return make();
  })
  .build();
`;
  const result = extractFromSource(content);
  expect(result[0].workflowHasBranchOrPoll).toBe(true);
});

test("pattern-nested defaults flag; object-method NAMES don't false-positive (S2.13 R11)", () => {
  const content = `
import { workflow } from "@glubean/sdk";
import { makeFlow } from "./helpers";

// initializer hidden INSIDE a destructuring pattern default — flagged
export const nestedDefault = workflow("u-nested-default")
  .setup(async () => ({ ok: true }))
  .use((b) => {
    const make = ({ x = b.branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (y) => y.compute("c", (s) => s) }) } = {}) => x;
    return make();
  })
  .build();

// an object METHOD whose name collides with the builder — pure label, clean
export const methodName = workflow("u-method-name")
  .setup(async () => ({}))
  .use((b) => b.action("probe", async (ctx, s) => { await makeFlow({ b() { return 1; } }); return s; }))
  .build();
`;
  const result = extractFromSource(content);
  const byId = Object.fromEntries(result.map((m) => [m.id, m.workflowHasBranchOrPoll ?? false]));
  expect(byId).toEqual({
    "u-nested-default": true,
    "u-method-name": false,
  });
});

test("destructured aliases and param-default initializers cannot hide the branch family (S2.13 R10)", () => {
  const content = `
import { workflow } from "@glubean/sdk";

// builder re-extracted via destructuring from a live container — flagged
export const destructuredAlias = workflow("u-destr-alias")
  .setup(async () => ({ ok: true }))
  .use((b) => {
    const h = { b };
    const { b: x } = h;
    return x.branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (y) => y.compute("c", (s) => s) });
  })
  .build();

// nested fn's default-parameter initializer authors the chain — flagged
export const paramDefault = workflow("u-param-default")
  .setup(async () => ({ ok: true }))
  .use((b) => {
    const make = (x = b.branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (y) => y.compute("c", (s) => s) })) => x;
    return make();
  })
  .build();
`;
  const result = extractFromSource(content);
  const byId = Object.fromEntries(result.map((m) => [m.id, m.workflowHasBranchOrPoll ?? false]));
  expect(byId).toEqual({
    "u-destr-alias": true,
    "u-param-default": true,
  });
});

test("block-scoped shadows and optional chaining cannot hide the branch family (S2.13 R9)", () => {
  const content = `
import { workflow } from "@glubean/sdk";
import { makeFlow } from "./helpers";

// a block-scoped shadow must not kill the outer builder for the rest of the fn
export const blockShadow = workflow("u-block-shadow")
  .setup(async () => ({ ok: true }))
  .use((b) => {
    { const b = makeClient(); b.poll(); } // block-local foreign b
    return b.branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (x) => x.compute("c", (s) => s) });
  })
  .build();

// optional chaining — both delegation and method forms
export const optionalDelegate = workflow("u-opt-delegate")
  .setup(async () => ({}))
  .use((b) => makeFlow?.(b))
  .build();

export const optionalBranch = workflow("u-opt-branch")
  .setup(async () => ({ ok: true }))
  .use((b) => b?.branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (x) => x.compute("c", (s) => s) }))
  .build();
`;
  const result = extractFromSource(content);
  const byId = Object.fromEntries(result.map((m) => [m.id, m.workflowHasBranchOrPoll ?? false]));
  expect(byId).toEqual({
    "u-block-shadow": true,
    "u-opt-delegate": true,
    "u-opt-branch": true,
  });
});

test("computed access cannot hide the branch family (S2.13 R8)", () => {
  const content = `
import { workflow } from "@glubean/sdk";

// bracket syntax with a literal name resolves statically — flagged
export const literalKey = workflow("u-literal-key")
  .setup(async () => ({ ok: true }))
  .use((b) => b["branch"]("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (x) => x.compute("c", (s) => s) }))
  .build();

// wrapper + computed hop — roots at the live container, flagged
export const computedHop = workflow("u-computed-hop")
  .setup(async () => ({ ok: true }))
  .use((b) => {
    const h = { b };
    return h["b"].branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (x) => x.compute("c", (s) => s) });
  })
  .build();

// dynamic method name on the live builder — unresolvable, fails closed
export const dynamicKey = workflow("u-dynamic-key")
  .setup(async () => ({}))
  .use((b) => { const m = pickMethod(); return b[m]("x", (s) => s); })
  .build();
`;
  const result = extractFromSource(content);
  const byId = Object.fromEntries(result.map((m) => [m.id, m.workflowHasBranchOrPoll ?? false]));
  expect(byId).toEqual({
    "u-literal-key": true,
    "u-computed-hop": true,
    "u-dynamic-key": true,
  });
});

test("a builder hidden in a wrapper object or member access fails closed (S2.13 R7)", () => {
  const content = `
import { workflow } from "@glubean/sdk";
import { makeFlow } from "./helpers";

// builder wrapped in an object literal argument — delegation, fail closed
export const wrapped = workflow("u-wrapped")
  .setup(async () => ({}))
  .use((b) => makeFlow({ b }))
  .build();

// builder stored in a container; chain authored via member access — flagged
export const viaMember = workflow("u-member")
  .setup(async () => ({ ok: true }))
  .use((b) => {
    const h = { b };
    return h.b.branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (x) => x.compute("c", (s) => s) });
  })
  .build();

// a FOREIGN object whose property name merely collides — must NOT flag
export const propertyName = workflow("u-propname")
  .setup(async () => ({}))
  .use((b) => b.action("probe", async (ctx, s) => { await client.b.poll(); return s; }))
  .build();
`;
  const result = extractFromSource(content);
  const byId = Object.fromEntries(result.map((m) => [m.id, m.workflowHasBranchOrPoll ?? false]));
  expect(byId).toEqual({
    "u-wrapped": true,
    "u-member": true,
    "u-propname": false,
  });
});

test("a DESTRUCTURED row parameter stays scannable — no false flag (S2.13 R6)", () => {
  const content = `
import { workflow } from "@glubean/sdk";
export const destructured = workflow.each([{ region: "us" }])(
  { id: "d-$region" },
  (wf, { region }) => wf.setup(async () => ({ region })).compute("c", (s) => s),
);
`;
  const result = extractFromSource(content);
  expect(result[0].workflowHasBranchOrPoll ?? false).toBe(false); // linear — pure binding
});

test("a default-parameter initializer authoring the chain fails closed (S2.13 R5)", () => {
  const content = `
import { workflow } from "@glubean/sdk";
export const paramInit = workflow("u-param-init")
  .setup(async () => ({ ok: true }))
  .use((b, r = b.branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (x) => x.compute("c", (s) => s) })) => r)
  .build();
`;
  const result = extractFromSource(content);
  expect(result[0].workflowHasBranchOrPoll).toBe(true);
});

test("DELEGATING the builder to an uninspectable call fails closed (S2.12 R18)", () => {
  const content = `
import { workflow } from "@glubean/sdk";
import { makeFlow } from "./helpers";
export const delegated = workflow.each([{ region: "us" }])(
  { id: "dg-$region" },
  (wf, row) => makeFlow(wf),
);
`;
  const result = extractFromSource(content);
  expect(result[0].workflowHasBranchOrPoll).toBe(true); // graph handed to unseen code
});

test("closures capture BINDINGS: alias assigned after closure definition still flags (S2.12 R15)", () => {
  const content = `
import { workflow } from "@glubean/sdk";
export const lateBind = workflow.each([{ region: "us" }])(
  { id: "lb-$region" },
  (wf, row) => {
    let base;
    const make = () => base.branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (x) => x.compute("c", (s) => s) });
    base = wf.setup(async () => ({ ok: true }));
    return make();
  },
);
`;
  const result = extractFromSource(content);
  expect(result[0].workflowHasBranchOrPoll).toBe(true);
});

test("aliases bound INSIDE nested closures are tracked (S2.12 R13)", () => {
  const content = `
import { workflow } from "@glubean/sdk";
export const nestedAlias = workflow.each([{ region: "us" }])(
  { id: "na-$region" },
  (wf, row) => {
    const make = () => {
      const base = wf.setup(async () => ({ ok: true }));
      return base.branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (x) => x.compute("c", (s) => s) });
    };
    return make();
  },
);
`;
  const result = extractFromSource(content);
  expect(result[0].workflowHasBranchOrPoll).toBe(true);
});

test("ASSIGNED builder aliases are tracked too (S2.12 R10)", () => {
  const content = `
import { workflow } from "@glubean/sdk";
export const assigned = workflow.each([{ region: "us" }])(
  { id: "as-$region" },
  (wf, row) => {
    let b;
    b = wf.setup(async () => ({ ok: true }));
    return b.branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (x) => x.compute("c", (s) => s) });
  },
);
`;
  const result = extractFromSource(content);
  expect(result[0].workflowHasBranchOrPoll).toBe(true);
});

test("a helper-reference factory fails CLOSED on the branch/poll flag (S2.12 R9)", () => {
  const content = `
import { workflow } from "@glubean/sdk";
import { makeFlow } from "./helpers";
export const matrix = workflow.each([{ region: "us" }])({ id: "h-$region" }, makeFlow);
`;
  const result = extractFromSource(content);
  expect(result[0].workflowHasBranchOrPoll).toBe(true); // uninspectable — gate closed
});

test("shadowing locals inside nested runtime callbacks do NOT flag (S2.12 R4)", () => {
  const content = `
import { workflow } from "@glubean/sdk";

export const shadowed = workflow.each([{ region: "us" }])(
  { id: "sh-$region" },
  (wf, row) =>
    wf.setup(async () => ({}))
      .action("probe", async (ctx, s) => {
        const wf = makeClient(); // shadows the builder param inside a RUNTIME callback
        await wf.poll();
        return s;
      }),
);
`;
  const result = extractFromSource(content);
  expect(result[0].workflowHasBranchOrPoll).toBeUndefined(); // linear graph — no flag
});

test("factory branch calls through LOCAL builder aliases are flagged too (S2.12 R2)", () => {
  const content = `
import { workflow } from "@glubean/sdk";

export const aliased = workflow.each([{ region: "us" }])(
  { id: "a-$region" },
  (wf, row) => {
    const base = wf.setup(async () => ({ ok: true }));
    return base.branch("route", { when: (w) => w.when((s) => s.ok).eq(true), then: (b) => b.compute("c", (s) => s) });
  },
);
`;
  const result = extractFromSource(content);
  expect(result[0].workflowHasBranchOrPoll).toBe(true);
});

test("workflow exports carry a static branch/poll flag for the upload gate (S2.6 R10)", () => {
  const content = `
import { workflow } from "@glubean/sdk";

export const branched = workflow("wf-branched")
  .setup(async () => ({ ok: true }))
  .branch("route", {
    when: (w) => w.when((s) => s.ok).eq(true),
    then: (b) => b.compute("c", (s) => s),
  })
  .build();

export const polling = workflow("wf-polling")
  .setup(async () => ({}))
  .poll("wait", ref, { until: (w) => w.when((r) => r.status).eq("done"), timeout: 1000 });

export const linear = workflow("wf-linear").compute("c", (s) => s).build();

// a CALLBACK body calling something named .poll()/.branch() must NOT flag —
// only the builder chain's own method names count (codex S2.6 R11 P2).
export const callbackNoise = workflow("wf-callback-noise")
  .setup(async () => ({}))
  .action("a", async (ctx, s) => { await client.poll(); other.branch(); return s; })
  .build();

// a plain test whose body merely CALLS something named branch() must not flag
export const plain = test("plain-test", async (ctx) => { ctx.log("x"); });
`;
  const result = extractFromSource(content);
  const byId = Object.fromEntries(
    result.map((m) => [m.id, [m.workflow ?? false, m.workflowHasBranchOrPoll ?? false]]),
  );
  expect(byId).toEqual({
    "wf-branched": [true, true],
    "wf-polling": [true, true],
    "wf-linear": [true, false],
    "wf-callback-noise": [true, false],
    "plain-test": [false, false],
  });
});

// =============================================================================
// Simple test — TestMeta object
// =============================================================================

test("extracts simple test with TestMeta object (id, name, tags array)", () => {
  const content = `
import { test } from "@glubean/sdk";

export const listProducts = test(
  { id: "list-products", name: "List Products", tags: ["smoke", "api"] },
  async (ctx) => {
    ctx.log("hello");
  }
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("list-products");
  expect(result[0].name).toBe("List Products");
  expect(result[0].tags).toEqual(["smoke", "api"]);
  expect(result[0].exportName).toBe("listProducts");
});

test("extracts simple test with TestMeta object (tags as single string)", () => {
  const content = `
export const myTest = test(
  { id: "my-test", tags: "smoke" },
  async (ctx) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("my-test");
  expect(result[0].tags).toEqual(["smoke"]);
});

test("extracts simple test timeout from TestMeta object", () => {
  const content = `
export const withTimeout = test(
  { id: "timeout-meta", timeout: 1200 },
  async (ctx) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("timeout-meta");
  expect(result[0].timeout).toBe(1200);
});

// =============================================================================
// Builder pattern — string ID + .meta() + .step()
// =============================================================================

test("extracts builder test with string ID and step chain", () => {
  const content = `
import { test } from "@glubean/sdk";

export const authFlow = test("auth-flow")
  .meta({ name: "Authentication Flow", tags: ["auth"] })
  .step("login", async (ctx) => {
    return { token: "abc" };
  })
  .step("get profile", async (ctx, state) => {
    ctx.log(state.token);
  });
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("auth-flow");
  expect(result[0].name).toBe("Authentication Flow");
  expect(result[0].tags).toEqual(["auth"]);
  expect(result[0].steps).toEqual([{ name: "login" }, { name: "get profile" }]);
});

test("extracts builder timeout from .meta()", () => {
  const content = `
export const timedFlow = test("timed-flow")
  .meta({ timeout: 900, tags: ["auth"] })
  .step("login", async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("timed-flow");
  expect(result[0].timeout).toBe(900);
});

test("extracts builder test without .meta() — steps only", () => {
  const content = `
export const flow = test("my-flow")
  .step("step one", async (ctx) => {})
  .step("step two", async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("my-flow");
  expect(result[0].name).toBeUndefined();
  expect(result[0].tags).toBeUndefined();
  expect(result[0].steps).toEqual([{ name: "step one" }, { name: "step two" }]);
});

// =============================================================================
// test.each() — data-driven
// =============================================================================

test("extracts test.each() with string ID template", () => {
  const content = `
import { test } from "@glubean/sdk";
import users from "./data/users.json" with { type: "json" };

export const userTests = test.each(users)(
  "get-user-$id",
  async (ctx, { id, expected }) => {
    ctx.assert(true, "ok");
  }
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("get-user-$id");
  expect(result[0].exportName).toBe("userTests");
});

test("extracts test.each() with TestMeta object", () => {
  const content = `
export const endpoints = test.each(data)(
  {
    id: "endpoint-$method-$path",
    name: "$method $path",
    tags: ["smoke", "endpoints"],
  },
  async (ctx, row) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("endpoint-$method-$path");
  expect(result[0].name).toBe("$method $path");
  expect(result[0].tags).toEqual(["smoke", "endpoints"]);
});

test("extracts test.each() builder mode with steps", () => {
  const content = `
export const scenarioTests = test
  .each(await fromYaml("./data/scenarios.yaml"))({
    id: "scenario-$id",
    name: "$description",
    tags: "scenario",
  })
  .step("send request", async (ctx, _state, row) => {
    return { status: 200 };
  })
  .step("log result", async (ctx, state, row) => {
    ctx.log("done");
  });
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("scenario-$id");
  expect(result[0].name).toBe("$description");
  expect(result[0].tags).toEqual(["scenario"]);
  expect(result[0].steps).toEqual([{ name: "send request" }, { name: "log result" }]);
});

test("extracts test.each() with parallel option", () => {
  const content = `
import { test, fromCsv } from "@glubean/sdk";

export const statusTests = test.each(await fromCsv("./data.csv"), { parallel: true })(
  "status-$id",
  async (ctx, row) => {
    ctx.assert(true, "ok");
  }
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("status-$id");
  expect(result[0].parallel).toBe(true);
});

test("test.each() without parallel option has no parallel field", () => {
  const content = `
export const tests = test.each(data)(
  "case-$id",
  async (ctx, row) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].parallel).toBeUndefined();
});

// =============================================================================
// test.pick() — example selection
// =============================================================================

test("extracts test.pick() with string ID template", () => {
  const content = `
export const searchProducts = test.pick({
  "by-name": { q: "phone" },
  "by-category": { q: "laptops" },
})(
  "search-products-$_pick",
  async (ctx, data) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("search-products-$_pick");
  expect(result[0].exportName).toBe("searchProducts");
});

test("extracts test.pick() with TestMeta object", () => {
  const content = `
export const createUser = test.pick(examples)({
  id: "create-user-$_pick",
  tags: ["smoke"],
}, async (ctx, data) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("create-user-$_pick");
  expect(result[0].tags).toEqual(["smoke"]);
});

// =============================================================================
// Multiple exports in one file
// =============================================================================

test("extracts multiple exports from a single file", () => {
  const content = `
import { test } from "@glubean/sdk";

export const first = test("first-test", async (ctx) => {});

export const second = test(
  { id: "second-test", name: "Second", tags: ["smoke"] },
  async (ctx) => {}
);

export const third = test("third-test")
  .step("only step", async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(3);
  expect(result[0].id).toBe("first-test");
  expect(result[0].exportName).toBe("first");
  expect(result[1].id).toBe("second-test");
  expect(result[1].name).toBe("Second");
  expect(result[2].id).toBe("third-test");
  expect(result[2].steps).toEqual([{ name: "only step" }]);
});

// =============================================================================
// Comment handling
// =============================================================================

test("ignores test() calls inside block comments", () => {
  const content = `
/*
export const commented = test("should-not-appear", async (ctx) => {});
*/

export const real = test("real-test", async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("real-test");
});

test("ignores test() calls inside line comments", () => {
  const content = `
// export const commented = test("should-not-appear", async (ctx) => {});

export const real = test("real-test", async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("real-test");
});

// =============================================================================
// Location tracking
// =============================================================================

test("reports correct line numbers", () => {
  const content = `import { test } from "@glubean/sdk";

export const a = test("alpha", async () => {});

export const b = test("beta", async () => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(2);
  expect(result[0].location?.line).toBe(3);
  expect(result[1].location?.line).toBe(5);
});

// =============================================================================
// Edge cases
// =============================================================================

test("handles single-quoted string IDs", () => {
  const content = `export const t = test('single-quoted', async () => {});`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("single-quoted");
});

test("handles single-quoted TestMeta object (id, tags)", () => {
  const content = `export const t = test({ id: 'x', tags: ['a'] }, async ()=>{});`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("x");
  expect(result[0].tags).toEqual(["a"]);
});

test("handles single-quoted TestMeta with name and multiple tags", () => {
  const content = `
export const t = test(
  { id: 'my-test', name: 'My Test', tags: ['smoke', 'api'] },
  async (ctx) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("my-test");
  expect(result[0].name).toBe("My Test");
  expect(result[0].tags).toEqual(["smoke", "api"]);
});

test("handles single-quoted tags in builder .meta()", () => {
  const content = `
export const flow = test('my-flow')
  .meta({ name: 'My Flow', tags: ['auth'] })
  .step('login', async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("my-flow");
  expect(result[0].name).toBe("My Flow");
  expect(result[0].tags).toEqual(["auth"]);
  expect(result[0].steps).toEqual([{ name: "login" }]);
});

test("non-exported test() calls are not extracted", () => {
  const content = `
const internal = test("internal-only", async (ctx) => {});
`;
  expect(extractFromSource(content)).toEqual([]);
});

test("test.pick with imported JSON examples", () => {
  const content = `
import examples from "../data/examples.json" with { type: "json" };

export const createUser = test.pick(examples)(
  "create-user-$_pick",
  async (ctx, { body }) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("create-user-$_pick");
});

test("test.each with nested function calls in data arg", () => {
  const content = `
export const csvTests = test.each(await fromCsv("./data/endpoints.csv"))(
  {
    id: "csv-$method-$path",
    tags: ["csv"],
  },
  async (ctx, row) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("csv-$method-$path");
  expect(result[0].tags).toEqual(["csv"]);
});

// =============================================================================
// isGlubeanFile
// =============================================================================

test("isGlubeanFile detects JSR import with version", () => {
  const content = `import { test } from "jsr:@glubean/sdk@0.10.0";`;
  expect(isGlubeanFile(content)).toBe(true);
});

test("isGlubeanFile recognizes a workflow import from a non-SDK module (S2.5)", () => {
  const content = `import { workflow } from "./shared/factories";`;
  expect(isGlubeanFile(content)).toBe(true);
});

test("isGlubeanFile detects JSR import without version", () => {
  const content = `import { test } from "jsr:@glubean/sdk";`;
  expect(isGlubeanFile(content)).toBe(true);
});

test("isGlubeanFile detects bare specifier import", () => {
  const content = `import { test } from "@glubean/sdk";`;
  expect(isGlubeanFile(content)).toBe(true);
});

test("isGlubeanFile detects subpath import", () => {
  const content = `import { getRegistry } from "@glubean/sdk/internal";`;
  expect(isGlubeanFile(content)).toBe(true);
});

test("isGlubeanFile returns false for unrelated code", () => {
  expect(isGlubeanFile(`import { something } from "other-lib";`)).toBe(false);
  expect(isGlubeanFile(`const x = 1;`)).toBe(false);
  expect(isGlubeanFile("")).toBe(false);
});

test("isGlubeanFile returns false for non-convention imports from other packages", () => {
  expect(
    isGlubeanFile(`import { something } from "@glubean/runner";`),
  ).toBe(false);
  expect(
    isGlubeanFile(`import { utils } from "jsr:@other/sdk";`),
  ).toBe(false);
});

test("isGlubeanFile detects convention-based *Test/*Task imports from any module", () => {
  expect(
    isGlubeanFile(`import { browserTest } from "./configure.ts";`),
  ).toBe(true);
  expect(
    isGlubeanFile(`import { deployTask } from "../tasks.ts";`),
  ).toBe(true);
  expect(
    isGlubeanFile(`import { test } from "./fixtures.ts";`),
  ).toBe(true);
  expect(
    isGlubeanFile(`import { task } from "@glubean/runner";`),
  ).toBe(true);
});

test("isGlubeanFile rejects identifiers that only contain test/task substring", () => {
  expect(
    isGlubeanFile(`import { latestResult } from "./utils.ts";`),
  ).toBe(false);
  expect(
    isGlubeanFile(`import { multitask } from "./parallel.ts";`),
  ).toBe(false);
});

// =============================================================================
// variant field
// =============================================================================

test("variant is undefined for simple tests", () => {
  const content = `
export const simple = test("simple-test", async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].variant).toBeUndefined();
});

test("variant is undefined for builder tests", () => {
  const content = `
export const flow = test("my-flow")
  .step("login", async (ctx) => {})
  .step("verify", async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].variant).toBeUndefined();
});

test("variant is 'each' for test.each()", () => {
  const content = `
export const userTests = test.each(users)(
  "get-user-$id",
  async (ctx, { id }) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].variant).toBe("each");
});

test("variant is 'pick' for test.pick()", () => {
  const content = `
export const searchTests = test.pick({
  "by-name": { q: "phone" },
})("search-$_pick", async (ctx, data) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].variant).toBe("pick");
});

test("variant is 'each' for test.each() builder mode", () => {
  const content = `
export const scenarios = test.each(data)({
  id: "scenario-$id",
  tags: ["scenario"],
})
  .step("request", async (ctx) => {})
  .step("verify", async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].variant).toBe("each");
  expect(result[0].steps).toEqual([{ name: "request" }, { name: "verify" }]);
});

test("mixed file: variant set correctly per test", () => {
  const content = `
import { test } from "@glubean/sdk";

export const health = test("health", async (ctx) => {});

export const items = test.each(data)("item-$id", async (ctx, row) => {});

export const search = test.pick(examples)("search-$_pick", async (ctx, d) => {});

export const flow = test("crud-flow").step("create", async () => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(4);
  expect(result[0].id).toBe("health");
  expect(result[0].variant).toBeUndefined();
  expect(result[1].id).toBe("item-$id");
  expect(result[1].variant).toBe("each");
  expect(result[2].id).toBe("search-$_pick");
  expect(result[2].variant).toBe("pick");
  expect(result[3].id).toBe("crud-flow");
  expect(result[3].variant).toBeUndefined();
});

// =============================================================================
// Extended function names (*Test, *Task, task)
// =============================================================================

test("extracts test from custom *Test function (test.extend)", () => {
  const content = `
import { browserTest } from "./configure.ts";

export const homepageLoads = browserTest(
  { id: "landing-homepage-loads", tags: ["smoke"] },
  async ({ page }) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("landing-homepage-loads");
  expect(result[0].tags).toEqual(["smoke"]);
  expect(result[0].exportName).toBe("homepageLoads");
});

test("extracts test from 'task' base function", () => {
  const content = `
export const deploy = task("deploy-staging", async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("deploy-staging");
  expect(result[0].exportName).toBe("deploy");
});

test("extracts test from custom *Task function", () => {
  const content = `
export const deployProd = deployTask(
  { id: "deploy-prod", tags: ["deploy"] },
  async (ctx) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("deploy-prod");
  expect(result[0].tags).toEqual(["deploy"]);
  expect(result[0].exportName).toBe("deployProd");
});

test("extracts *Test builder with steps", () => {
  const content = `
export const loginFlow = browserTest("browser-login")
  .meta({ tags: ["e2e"] })
  .step("navigate", async (ctx) => {})
  .step("fill form", async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("browser-login");
  expect(result[0].tags).toEqual(["e2e"]);
  expect(result[0].steps).toEqual([{ name: "navigate" }, { name: "fill form" }]);
});

test("extracts *Test.each() data-driven pattern", () => {
  const content = `
export const pageTests = browserTest.each(pages)(
  "page-$slug",
  async ({ page }, { slug }) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("page-$slug");
  expect(result[0].variant).toBe("each");
});

test("extracts *Test.pick() example selection pattern", () => {
  const content = `
export const searchTests = screenshotTest.pick({
  "desktop": { viewport: "1920x1080" },
  "mobile": { viewport: "390x844" },
})("screenshot-$_pick", async ({ page }, data) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("screenshot-$_pick");
  expect(result[0].variant).toBe("pick");
});

test("does NOT match identifiers that merely contain 'test' or 'task'", () => {
  const content = `
export const latestResult = getLatest("id", async () => {});
export const multitask = parallel("id", async () => {});
export const testResult = something("id", async () => {});
export const attest = verify("id", async () => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(0);
});

test("mixed file with test, task, *Test, and *Task functions", () => {
  const content = `
export const health = test("health", async (ctx) => {});
export const deploy = task("deploy", async (ctx) => {});
export const login = browserTest("browser-login", async ({ page }) => {});
export const cleanup = cleanupTask("cleanup-db", async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(4);
  expect(result[0].id).toBe("health");
  expect(result[0].exportName).toBe("health");
  expect(result[1].id).toBe("deploy");
  expect(result[1].exportName).toBe("deploy");
  expect(result[2].id).toBe("browser-login");
  expect(result[2].exportName).toBe("login");
  expect(result[3].id).toBe("cleanup-db");
  expect(result[3].exportName).toBe("cleanup");
});

// =============================================================================
// extractAliasesFromSource
// =============================================================================

test("extractAliasesFromSource finds test.extend aliases", () => {
  const content = `
import { test } from "@glubean/sdk";
export const browserTest = test.extend({ page: pageFixture });
export const screenshotTest = test.extend({ page: screenshotFixture });
`;
  const aliases = extractAliasesFromSource(content);
  expect(aliases).toEqual(["browserTest", "screenshotTest"]);
});

test("extractAliasesFromSource finds chained extend aliases", () => {
  const content = `
const withAuth = test.extend({ auth: authFixture });
const withBoth = withAuth.extend({ db: dbFixture });
`;
  const aliases = extractAliasesFromSource(content);
  expect(aliases).toEqual(["withAuth", "withBoth"]);
});

test("extractAliasesFromSource finds non-convention names", () => {
  const content = `
export const scenario = test.extend({ browser: browserFixture });
const check = scenario.extend({ validator: validatorFixture });
`;
  const aliases = extractAliasesFromSource(content);
  expect(aliases).toEqual(["scenario", "check"]);
});

test("extractAliasesFromSource returns empty for files without extend", () => {
  const content = `
import { test } from "@glubean/sdk";
export const health = test("health", async (ctx) => {});
`;
  expect(extractAliasesFromSource(content)).toEqual([]);
});

test("extractAliasesFromSource ignores extend in comments", () => {
  const content = `
// const commented = test.extend({ page: fixture });
export const real = test.extend({ page: fixture });
`;
  const aliases = extractAliasesFromSource(content);
  expect(aliases).toEqual(["real"]);
});

// =============================================================================
// extractFromSource with explicit customFns
// =============================================================================

test("extractFromSource with customFns matches non-convention names", () => {
  const content = `
export const login = scenario("login-flow", async (ctx) => {});
export const checkout = journey({ id: "checkout", tags: ["e2e"] }, async (ctx) => {});
`;
  // Without customFns: convention fallback doesn't match "scenario" or "journey"
  // (`workflow` itself is a BASE_FN since S2.5 — covered by its own test above).
  expect(extractFromSource(content).length).toBe(0);

  // With customFns: explicit match
  const result = extractFromSource(content, ["scenario", "journey"]);
  expect(result.length).toBe(2);
  expect(result[0].id).toBe("login-flow");
  expect(result[1].id).toBe("checkout");
});

test("extractFromSource with customFns always includes base test/task", () => {
  const content = `
export const health = test("health", async (ctx) => {});
export const login = scenario("login", async (ctx) => {});
`;
  const result = extractFromSource(content, ["scenario"]);
  expect(result.length).toBe(2);
  expect(result[0].id).toBe("health");
  expect(result[1].id).toBe("login");
});

// =============================================================================
// isGlubeanFile with explicit customFns
// =============================================================================

test("isGlubeanFile with customFns detects non-convention imports", () => {
  // "scenario" doesn't match *Test/*Task convention
  expect(
    isGlubeanFile(`import { scenario } from "./configure.ts";`),
  ).toBe(false);
  // But with customFns, it's recognized
  expect(
    isGlubeanFile(`import { scenario } from "./configure.ts";`, ["scenario"]),
  ).toBe(true);
});

// =============================================================================
// extractPickExamples
// =============================================================================

test("extractPickExamples detects inline object literal", () => {
  const content = `
export const search = test.pick({
  "by-name": { q: "phone" },
  "by-category": { q: "laptop" },
})(
  "search-$_pick",
  async (ctx, data) => {},
);`;
  const picks = extractPickExamples(content);
  expect(picks.length).toBe(1);
  expect(picks[0].testId).toBe("search-$_pick");
  expect(picks[0].keys).toEqual(["by-name", "by-category"]);
  expect(picks[0].dataSource).toEqual({ type: "inline" });
});

test("extractPickExamples detects fromDir.merge with variable", () => {
  const content = `
const examples = await fromDir.merge("./data/add-product/");

export const addProduct = test.pick(examples)(
  "add-product-$_pick",
  async (ctx, body) => {},
);`;
  const picks = extractPickExamples(content);
  expect(picks.length).toBe(1);
  expect(picks[0].testId).toBe("add-product-$_pick");
  expect(picks[0].exportName).toBe("addProduct");
  expect(picks[0].dataSource).toEqual({
    type: "dir-merge",
    path: "./data/add-product/",
  });
  expect(picks[0].keys).toBeNull();
});

test("extractPickExamples detects a typed (as/satisfies) loader assignment", () => {
  // The TS wrapper sits around the whole `await from*(...)` initializer.
  const content = `
const examples = await fromDir.merge("./data/add-product/") as Record<string, unknown>;
export const addProduct = test.pick(examples)("add-product-$_pick", async (ctx, body) => {});`;
  const picks = extractPickExamples(content);
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({ type: "dir-merge", path: "./data/add-product/" });
  expect(picks[0].keys).toBeNull();
});

test("extractPickExamples detects JSON import", () => {
  const content = `
import examples from "../data/create-user.json" with { type: "json" };

export const createUser = test.pick(examples)(
  "create-user-$_pick",
  async (ctx, body) => {},
);`;
  const picks = extractPickExamples(content);
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "json-import",
    path: "../data/create-user.json",
  });
});

test("extractPickExamples returns undefined dataSource for unknown variable", () => {
  const content = `
const dir = vars.require("DATA_DIR");
const examples = await fromDir.merge(dir);

export const dynTest = test.pick(examples)(
  "dyn-$_pick",
  async (ctx, body) => {},
);`;
  const picks = extractPickExamples(content);
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toBeUndefined();
  expect(picks[0].keys).toBeNull();
});

// =============================================================================
// extractPickExamples — filePath resolution
// =============================================================================

test("extractPickExamples resolves ./data/ relative to filePath", () => {
  const content = `
const examples = await fromDir.merge("./data/products/");

export const prodTest = test.pick(examples)(
  "prod-$_pick",
  async (ctx, body) => {},
);`;
  const picks = extractPickExamples(content, {
    filePath: "/project/tests/api/products.test.ts",
  });
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "dir-merge",
    path: "/project/tests/api/data/products/",
  });
});

test("extractPickExamples resolves bare data/ relative to projectRoot", () => {
  const content = `
const examples = await fromDir.merge("data/products/");

export const prodTest = test.pick(examples)(
  "prod-$_pick",
  async (ctx, body) => {},
);`;
  const picks = extractPickExamples(content, {
    projectRoot: "/project",
  });
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "dir-merge",
    path: "/project/data/products/",
  });
});

test("extractPickExamples keeps ./data/ raw when only projectRoot is provided", () => {
  const content = `
const examples = await fromDir.merge("./data/products/");

export const prodTest = test.pick(examples)(
  "prod-$_pick",
  async (ctx, body) => {},
);`;
  const picks = extractPickExamples(content, {
    projectRoot: "/project",
  });
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "dir-merge",
    path: "./data/products/",
  });
});

test("extractPickExamples resolves ../data/ relative to filePath", () => {
  const content = `
const cases = await fromDir.merge("../data/directions/");

export const directions = test.pick(cases)(
  { id: "directions-$_pick", name: "Directions: $_pick", tags: ["geo"] },
  async (ctx, { origin }) => {},
);`;
  const picks = extractPickExamples(content, {
    filePath: "/project/tests/geo/directions.test.ts",
  });
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "dir-merge",
    path: "/project/tests/data/directions/",
  });
});

test("extractPickExamples falls back to raw path when no filePath", () => {
  const content = `
const cases = await fromDir.merge("../data/directions/");

export const directions = test.pick(cases)(
  "directions-$_pick",
  async (ctx, { origin }) => {},
);`;
  // No filePath — should keep raw path
  const picks = extractPickExamples(content);
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "dir-merge",
    path: "../data/directions/",
  });
});

test("extractPickExamples keeps bare data/ raw when only filePath is provided", () => {
  const content = `
const examples = await fromDir.merge("data/products/");

export const prodTest = test.pick(examples)(
  "prod-$_pick",
  async (ctx, body) => {},
);`;
  const picks = extractPickExamples(content, {
    filePath: "/project/tests/api/products.test.ts",
  });
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "dir-merge",
    path: "data/products/",
  });
});

test("extractPickExamples resolves JSON import path relative to filePath", () => {
  const content = `
import examples from "../data/create-user.json" with { type: "json" };

export const createUser = test.pick(examples)(
  "create-user-$_pick",
  async (ctx, body) => {},
);`;
  const picks = extractPickExamples(content, {
    filePath: "/project/tests/users/create.test.ts",
  });
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "json-import",
    path: "/project/tests/data/create-user.json",
  });
});

test("extractPickExamples keeps absolute paths unchanged", () => {
  const content = `
const examples = await fromDir.merge("/absolute/data/products/");

export const prodTest = test.pick(examples)(
  "prod-$_pick",
  async (ctx, body) => {},
);`;
  const picks = extractPickExamples(content, {
    filePath: "/project/tests/api/products.test.ts",
  });
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "dir-merge",
    path: "/absolute/data/products/",
  });
});

test("extractPickExamples detects fromDir (not .merge/.concat)", () => {
  const content = `
const rows = await fromDir("./cases/");

export const caseTest = test.pick(rows)(
  "case-$_pick",
  async (ctx, body) => {},
);`;
  const picks = extractPickExamples(content, {
    filePath: "/project/tests/api/cases.test.ts",
  });
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "dir",
    path: "/project/tests/api/cases/",
  });
});

test("extractPickExamples detects fromDir.concat", () => {
  const content = `
const batches = await fromDir.concat("./batches/");

export const batchTest = test.pick(batches)(
  "batch-$_pick",
  async (ctx, body) => {},
);`;
  const picks = extractPickExamples(content, {
    filePath: "/project/tests/api/batch.test.ts",
  });
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "dir-concat",
    path: "/project/tests/api/batches/",
  });
});

test("extractPickExamples detects fromYaml.map", () => {
  const content = `
const scenarios = await fromYaml.map("./data/scenarios.yaml");

export const searchTest = test.pick(scenarios)(
  "search-$_pick",
  async (ctx, data) => {},
);`;
  const picks = extractPickExamples(content, {
    filePath: "/project/tests/api/search.test.ts",
  });
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "yaml-map",
    path: "/project/tests/api/data/scenarios.yaml",
  });
});

test("extractPickExamples detects fromJson", () => {
  const content = `
const cases = await fromJson("./data/cases.json");

export const caseTest = test.pick(cases)(
  "case-$_pick",
  async (ctx, data) => {},
);`;
  const picks = extractPickExamples(content, {
    filePath: "/project/tests/api/case.test.ts",
  });
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "json-loader",
    path: "/project/tests/api/data/cases.json",
  });
});

test("extractPickExamples detects fromJson.map", () => {
  const content = `
const scenarios = await fromJson.map("./data/scenarios.json");

export const scenarioTest = test.pick(scenarios)(
  "scenario-$_pick",
  async (ctx, data) => {},
);`;
  const picks = extractPickExamples(content, {
    filePath: "/project/tests/api/scenario.test.ts",
  });
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "json-map",
    path: "/project/tests/api/data/scenarios.json",
  });
});

// =============================================================================
// contract.http() extraction
// =============================================================================

test("extractContractCases — basic contract with two cases", () => {
  const source = `
import { contract } from "@glubean/sdk";

export const createUser = contract.http("create-user", {
  endpoint: "POST /users",
  client: api,
  cases: {
    success: {
      expect: { status: 201 },
    },
    invalidBody: {
      expect: { status: 400 },
    },
  },
});
`;
  const result = extractContractCases(source);
  expect(result).toHaveLength(1);
  expect(result[0].contractId).toBe("create-user");
  expect(result[0].exportName).toBe("createUser");
  expect(result[0].endpoint).toBe("POST /users");
  expect(result[0].protocol).toBe("http");
  expect(result[0].cases).toHaveLength(2);
  expect(result[0].cases[0].key).toBe("success");
  expect(result[0].cases[0].expectStatus).toBe(201);
  expect(result[0].cases[1].key).toBe("invalidBody");
  expect(result[0].cases[1].expectStatus).toBe(400);
});

test("extractContractCases — deferred case", () => {
  const source = `
export const cancelRun = contract.http("cancel-run", {
  endpoint: "POST /runs/:runId/cancel",
  cases: {
    success: {
      expect: { status: 200 },
    },
    viewerBlocked: {
      expect: { status: 403 },
      deferred: "needs VIEWER_API_KEY",
    },
  },
});
`;
  const result = extractContractCases(source);
  expect(result[0].cases).toHaveLength(2);
  expect(result[0].cases[0].deferred).toBeUndefined();
  expect(result[0].cases[1].key).toBe("viewerBlocked");
  expect(result[0].cases[1].expectStatus).toBe(403);
  expect(result[0].cases[1].deferred).toBe("needs VIEWER_API_KEY");
});

test("extractContractCases — multiple contracts in one file", () => {
  const source = `
export const getUser = contract.http("get-user", {
  endpoint: "GET /users/:id",
  cases: {
    success: { expect: { status: 200 } },
    notFound: { expect: { status: 404 } },
  },
});

export const deleteUser = contract.http("delete-user", {
  endpoint: "DELETE /users/:id",
  cases: {
    success: { expect: { status: 200 } },
  },
});
`;
  const result = extractContractCases(source);
  expect(result).toHaveLength(2);
  expect(result[0].contractId).toBe("get-user");
  expect(result[0].cases).toHaveLength(2);
  expect(result[1].contractId).toBe("delete-user");
  expect(result[1].cases).toHaveLength(1);
});

test("extractContractCases — non-http protocol", () => {
  const source = `
export const sayHello = contract.grpc("say-hello", {
  endpoint: "greeter.Greeter/SayHello",
  cases: {
    success: { expect: { status: 0 } },
  },
});
`;
  const result = extractContractCases(source);
  expect(result).toHaveLength(1);
  expect(result[0].protocol).toBe("grpc");
  expect(result[0].endpoint).toBe("greeter.Greeter/SayHello");
});

test("extractContractCases — graphql protocol", () => {
  const source = `
export const getUser = contract.graphql("get-user", {
  endpoint: "/graphql",
  cases: {
    ok: { description: "success", expect: { httpStatus: 200 } },
    unauth: { description: "no token", expect: { httpStatus: 401 } },
  },
});
`;
  const result = extractContractCases(source);
  expect(result).toHaveLength(1);
  expect(result[0].protocol).toBe("graphql");
  expect(result[0].endpoint).toBe("/graphql");
  expect(result[0].contractId).toBe("get-user");
  expect(result[0].cases).toHaveLength(2);
  expect(result[0].cases.map((c) => c.key)).toEqual(["ok", "unauth"]);
});

test("extractContractCases — preserves reference/shorthand case keys (value not inline object)", () => {
  const source = `
const ok = defineHttpCase({ expect: { status: 200 } });
export const c = contract.http("c", { endpoint: "GET /c", cases: { ok, notFound: shared } });
`;
  const cases = extractContractCases(source)[0].cases;
  expect(cases.map((x) => x.key)).toEqual(["ok", "notFound"]); // keys kept even as references
});

test("extractContractCases — reads case-level deprecated", () => {
  const source = `
export const c = contract.http("c", {
  endpoint: "GET /c",
  cases: { old: { deprecated: "use v2", expect: { status: 200 } } },
});
`;
  expect(extractContractCases(source)[0].cases[0].deprecated).toBe("use v2");
});

test("extractContractCases — narrow (default) ignores .with()/custom factories (fail-closed)", () => {
  // Default narrow: only literal contract.<protocol>(...). Scoped/custom forms
  // are NOT statically extracted — the CLI fails closed + requires runtime import.
  const source = `
const stableApi = contract.http.with({ baseUrl: "x" });
export const a = stableApi("get-user", { endpoint: "GET /u", cases: { ok: { expect: { status: 200 } } } });
export const b = contract.http.with({ baseUrl: "y" })("create", { endpoint: "POST /c", cases: { ok: { expect: { status: 201 } } } });
`;
  expect(extractContractCases(source)).toEqual([]);
});

test("extractContractCases — broad: contract.http.with() scoped instances + custom factories", () => {
  // { broad: true } (VSCode discovery): duck-type ANY <factory>("id", { cases }).
  const source = `
const stableApi = contract.http.with({ baseUrl: "x" });
export const a = stableApi("get-user", { endpoint: "GET /u", cases: { ok: { expect: { status: 200 } } } });
export const b = contract.http.with({ baseUrl: "y" })("create", { endpoint: "POST /c", cases: { ok: { expect: { status: 201 } } } });
`;
  const result = extractContractCases(source, { broad: true });
  expect(result.map((c) => c.contractId).sort()).toEqual(["create", "get-user"]);
  // protocol derived from contract.http.with → "http"; custom factory → "" (unknown).
  expect(result.find((c) => c.contractId === "create")?.protocol).toBe("http");
  expect(result.find((c) => c.contractId === "get-user")?.protocol).toBe("");
});

test("extractContractCases — computed protocol: narrow ignores, broad detects with unknown protocol", () => {
  const source = `
const protocol = "http";
export const c = contract[protocol]("c", { endpoint: "GET /c", cases: { ok: { expect: { status: 200 } } } });
`;
  expect(extractContractCases(source)).toEqual([]); // narrow: not a literal contract.<protocol>
  const broad = extractContractCases(source, { broad: true });
  expect(broad).toHaveLength(1);
  expect(broad[0].contractId).toBe("c");
  expect(broad[0].protocol).toBe(""); // computed → no literal protocol
});

test("extractContractCases — no contracts returns empty", () => {
  const source = `
import { test } from "@glubean/sdk";
export const myTest = test("my-test", async (ctx) => {});
`;
  expect(extractContractCases(source)).toEqual([]);
});

test("extractContractCases — case line numbers are correct", () => {
  const source = [
    'import { contract } from "@glubean/sdk";',  // line 1
    '',                                            // line 2
    'export const x = contract.http("x", {',      // line 3
    '  endpoint: "GET /x",',                       // line 4
    '  cases: {',                                  // line 5
    '    alpha: {',                                // line 6
    '      expect: { status: 200 },',              // line 7
    '    },',                                      // line 8
    '    beta: {',                                 // line 9
    '      expect: { status: 404 },',              // line 10
    '    },',                                      // line 11
    '  },',                                        // line 12
    '});',                                         // line 13
  ].join('\n');

  const result = extractContractCases(source);
  expect(result[0].line).toBe(3);
  expect(result[0].cases[0].key).toBe("alpha");
  expect(result[0].cases[0].line).toBe(6);
  expect(result[0].cases[1].key).toBe("beta");
  expect(result[0].cases[1].line).toBe(9);
});

// ── requires / defaultRun extraction ────────────────────────────────────────

test("extractContractCases — requires: browser", () => {
  const source = `
export const googleAuth = contract.http("google-auth", {
  endpoint: "POST /auth/google/callback",
  cases: {
    success: {
      description: "Real Google login",
      requires: "browser",
      expect: { status: 200 },
    },
    invalid: {
      description: "Bad token",
      expect: { status: 401 },
    },
  },
});`;
  const result = extractContractCases(source);
  expect(result[0].cases[0].requires).toBe("browser");
  expect(result[0].cases[0].defaultRun).toBeUndefined(); // not statically set
  expect(result[0].cases[1].requires).toBeUndefined();
  expect(result[0].cases[1].defaultRun).toBeUndefined();
});

test("extractContractCases — requires: out-of-band", () => {
  const source = `
export const magicLink = contract.http("magic-link", {
  endpoint: "POST /auth/magic-link",
  cases: {
    send: {
      description: "Send magic link",
      requires: "out-of-band",
      expect: { status: 200 },
    },
  },
});`;
  const result = extractContractCases(source);
  expect(result[0].cases[0].requires).toBe("out-of-band");
});

test("extractContractCases — defaultRun: opt-in", () => {
  const source = `
export const sms = contract.http("sms-send", {
  endpoint: "POST /send-sms",
  cases: {
    realSend: {
      description: "Real Twilio SMS",
      defaultRun: "opt-in",
      expect: { status: 202 },
    },
  },
});`;
  const result = extractContractCases(source);
  expect(result[0].cases[0].defaultRun).toBe("opt-in");
  expect(result[0].cases[0].requires).toBeUndefined();
});

test("extractContractCases — requires + defaultRun together", () => {
  const source = `
export const checkout = contract.http("checkout", {
  endpoint: "POST /checkout",
  cases: {
    pay: {
      description: "Stripe checkout",
      requires: "browser",
      defaultRun: "opt-in",
      expect: { status: 200 },
    },
  },
});`;
  const result = extractContractCases(source);
  expect(result[0].cases[0].requires).toBe("browser");
  expect(result[0].cases[0].defaultRun).toBe("opt-in");
});

test("extractContractCases — given precondition", () => {
  const source = `
export const invite = contract.http("invite-member", {
  endpoint: "POST /teams/:teamId/invites",
  cases: {
    duplicate: {
      description: "Existing member email is rejected.",
      given: "the email already belongs to a team member",
      expect: { status: 409 },
    },
  },
});`;
  const result = extractContractCases(source);
  expect(result[0].cases[0].given).toBe(
    "the email already belongs to a team member",
  );
});

test("extractContractCases — no requires/defaultRun returns undefined", () => {
  const source = `
export const simple = contract.http("simple", {
  endpoint: "GET /health",
  cases: {
    check: {
      description: "Health check",
      expect: { status: 200 },
    },
  },
});`;
  const result = extractContractCases(source);
  expect(result[0].cases[0].requires).toBeUndefined();
  expect(result[0].cases[0].defaultRun).toBeUndefined();
});

test("extractContractCases — feature and description field extraction", () => {
  const source = `import { contract } from "@glubean/sdk";
export const createUser = contract.http("create-user", {
  endpoint: "POST /users",
  description: "新用户注册账号",
  feature: "用户注册",
  cases: {
    success: {
      description: "Valid registration",
      expect: { status: 201 },
    },
  },
});`;
  const result = extractContractCases(source);
  expect(result).toHaveLength(1);
  expect(result[0].feature).toBe("用户注册");
  expect(result[0].description).toBe("新用户注册账号");
  expect(result[0].contractId).toBe("create-user");
  // Case description is separate from contract description
  expect(result[0].cases[0].description).toBe("Valid registration");
});

test("extractContractCases — feature is undefined when not provided", () => {
  const source = `import { contract } from "@glubean/sdk";
export const c = contract.http("no-feature", {
  endpoint: "GET /health",
  cases: {
    ok: {
      description: "Health check",
      expect: { status: 200 },
    },
  },
});`;
  const result = extractContractCases(source);
  expect(result).toHaveLength(1);
  expect(result[0].feature).toBeUndefined();
});

test("extractContractCases — multiple contracts with different features", () => {
  const source = `import { contract } from "@glubean/sdk";
export const a = contract.http("create-user", {
  endpoint: "POST /users",
  feature: "User Registration",
  cases: { ok: { description: "ok", expect: { status: 201 } } },
});
export const b = contract.http("get-user", {
  endpoint: "GET /users/:id",
  feature: "User Registration",
  cases: { found: { description: "found", expect: { status: 200 } } },
});
export const c = contract.http("create-project", {
  endpoint: "POST /projects",
  feature: "Project Management",
  cases: { ok: { description: "ok", expect: { status: 201 } } },
});`;
  const result = extractContractCases(source);
  expect(result).toHaveLength(3);
  expect(result[0].feature).toBe("User Registration");
  expect(result[1].feature).toBe("User Registration");
  expect(result[2].feature).toBe("Project Management");
});

// ---------------------------------------------------------------------------
// extractFlows (structural, marker-free)
// ---------------------------------------------------------------------------

test("extractFlows detects a .flow() export with no marker", () => {
  const source = `
import { contract } from "@glubean/sdk";
export const signupFlow = contract
  .flow("signup-flow")
  .meta({ description: "sign up" })
  .step("register", async () => {});
`;
  const flows = extractFlows(source);
  expect(flows).toHaveLength(1);
  expect(flows[0].flowId).toBe("signup-flow");
  expect(flows[0].exportName).toBe("signupFlow");
  expect(flows[0].skip).toBeUndefined();
});

test("extractFlows supports the object overload flow({ id }) — id honored, object skip ignored", () => {
  // Runtime reads id from the object overload but does NOT honor its skip (skip
  // only applies from a chained .meta({ skip })), so we don't expose object skip.
  const source = `
export const f = contract.flow({ id: "obj-flow", skip: "wip" }).step("s", async () => {});
`;
  const flows = extractFlows(source);
  expect(flows).toHaveLength(1);
  expect(flows[0].flowId).toBe("obj-flow");
  expect(flows[0].skip).toBeUndefined();
});

test("extractFlows ignores a non-contract .flow() (e.g. otherLib.flow)", () => {
  const source = `export const p = otherLib.flow("daily").run();`;
  expect(extractFlows(source)).toEqual([]);
});

test("extractFlows reads .meta({ skip }) and ignores non-flow exports", () => {
  const source = `
export const skipped = contract.flow("later").meta({ skip: "not ready" }).step("s", async () => {});
export const notAFlow = test("plain", async () => {});
const notExported = contract.flow("hidden");
`;
  const flows = extractFlows(source);
  expect(flows).toHaveLength(1);
  expect(flows[0].flowId).toBe("later");
  expect(flows[0].skip).toBe("not ready");
});

test("extractFlows returns [] on unparseable source (never throws)", () => {
  expect(extractFlows("export const x = (;")).toEqual([]);
});
