import { test as vtest, expect } from "vitest";
import { test as glubeanTest } from "@glubean/sdk";
import { dryRunTest, type TestShape } from "./dry-run.js";

// Drive dryRunTest with REAL SDK test() objects (the same shape the CLI imports
// from a user's test module), mirroring the spike scenarios end-to-end.

vtest("projects a simple assert test (no I/O)", async () => {
  const t = glubeanTest("simple-assert", async (ctx) => {
    ctx.assert(true, "basic works");
    ctx.expect(1 + 1).toBe(2);
    ctx.expect("hello").toContain("ell");
  });
  const shape = await dryRunTest(t, { exportName: "t" });
  expect(shape.projectionComplete).toBe(true);
  expect(shape.assertionCount).toBe(3);
  expect(shape.endpoints).toEqual([]);
  expect(shape.assertions.map((a) => a.kind)).toEqual(["assert", "expect.toBe", "expect.toContain"]);
});

vtest("captures endpoint + assertions from an http test", async () => {
  const t = glubeanTest("http-get", async (ctx) => {
    const res = await ctx.http.get("https://api.test/users");
    const data = await res.json();
    ctx.assert(Array.isArray(data), "is array");
    ctx.expect(res).toHaveStatus(200);
  });
  const shape = await dryRunTest(t, { exportName: "t" });
  expect(shape.projectionComplete).toBe(true);
  expect(shape.endpoints).toEqual([{ method: "GET", url: "https://api.test/users", branch: undefined }]);
  expect(shape.assertionCount).toBe(2);
});

vtest("ctx.when captures BOTH arms, branch-tagged", async () => {
  const t = glubeanTest("ctx-when", async (ctx) => {
    const res = await ctx.http.post("https://api.test/login");
    await ctx.when(
      (res as { status: number }).status === 200,
      () => {
        ctx.assert(true, "has token");
        ctx.expect(res).toBeDefined();
      },
      () => ctx.assert(true, "unauthorized"),
    );
  });
  const shape = await dryRunTest(t, { exportName: "t" });
  expect(shape.assertionCount).toBe(3);
  const then = shape.assertions.filter((a) => a.branch === "when#0:then");
  const els = shape.assertions.filter((a) => a.branch === "when#0:else");
  expect(then).toHaveLength(2);
  expect(els).toHaveLength(1);
  expect(shape.assertions.every((a) => !!a.branch)).toBe(true);
});

vtest("nested ctx.when captures all four arms with nested tags", async () => {
  const t = glubeanTest("nested-when", async (ctx) => {
    const res = await ctx.http.get("https://api.test/me");
    await ctx.when(
      (res as { ok: boolean }).ok,
      async () => {
        ctx.assert(true, "has body");
        await ctx.when(
          true,
          () => ctx.assert(true, "admin perms"),
          () => ctx.assert(true, "no perms"),
        );
      },
      () => ctx.assert(true, "unauth"),
    );
  });
  const shape = await dryRunTest(t, { exportName: "t" });
  expect(shape.assertionCount).toBe(4);
  expect(shape.assertions.some((a) => a.branch?.includes(">when#1"))).toBe(true);
});

vtest("ctx.switch runs every case + default, tagged", async () => {
  const t = glubeanTest("ctx-switch", async (ctx) => {
    const res = await ctx.http.get("https://api.test/orders/1");
    const status = (res as { status: number }).status;
    await ctx.switch(
      [
        { when: () => status === 200, then: () => ctx.assert(true, "ok") },
        { when: () => status === 404, then: () => ctx.assert(true, "missing") },
        { when: () => status === 403, then: () => ctx.assert(true, "forbidden") },
      ],
      () => ctx.fail("unexpected"),
    );
  });
  const shape = await dryRunTest(t, { exportName: "t" });
  expect(shape.assertionCount).toBe(4); // 3 cases + default
  expect(shape.assertions.map((a) => a.branch)).toEqual([
    "switch#0:case[0]",
    "switch#0:case[1]",
    "switch#0:case[2]",
    "switch#0:default",
  ]);
  expect(shape.assertions[3].kind).toBe("fail");
});

vtest("contains a data-dependent loop via the request budget", async () => {
  const t = glubeanTest("pagination", async (ctx) => {
    let next = true;
    while (next) {
      const res = await ctx.http.get("https://api.test/page");
      const body = (await res.json()) as { hasMore: boolean };
      next = body.hasMore; // synthetic → perpetually truthy
    }
    ctx.assert(true, "done");
  });
  const shape = await dryRunTest(t, { exportName: "t" });
  expect(shape.projectionComplete).toBe(false);
  expect(shape.incompleteReason).toContain("budget");
});

vtest("survives deep property access + for-of over a response", async () => {
  const t = glubeanTest("deep-access", async (ctx) => {
    const res = await ctx.http.get("https://api.test/tree");
    const body = (await res.json()) as any;
    ctx.assert(body.user.profile.settings.theme === "dark", "deep ok");
    for (const item of body.items) {
      ctx.assert(item.id, "item id");
    }
  });
  const shape = await dryRunTest(t, { exportName: "t" });
  expect(shape.projectionComplete).toBe(true);
  // for-of yields one representative item → body runs once: "deep ok" + "item id".
  expect(shape.assertionCount).toBe(2);
});

vtest("handles expect chaining: .not, .orFail(), and awaited async matcher", async () => {
  const t = glubeanTest("expect-chain", async (ctx) => {
    const res = await ctx.http.get("https://api.test/x");
    ctx.expect(res).toHaveStatus(200).orFail();
    ctx.expect(res.status).not.toBe(500);
    await ctx.expect(res).toHaveJsonBody({ ok: true });
  });
  const shape = await dryRunTest(t, { exportName: "t" });
  expect(shape.projectionComplete).toBe(true); // no hang (await), no throw (.orFail())
  expect(shape.assertions.map((a) => a.kind)).toEqual([
    "expect.toHaveStatus",
    "expect.toBe",
    "expect.toHaveJsonBody",
  ]);
});

vtest("folds scanner bareBranchCount into projectionComplete", async () => {
  const t = glubeanTest("bare-branch", async (ctx) => {
    ctx.assert(true, "x");
  });
  const shape = await dryRunTest(t, { exportName: "t", bareBranchCount: 2 });
  expect(shape.projectionComplete).toBe(false);
  expect(shape.incompleteReason).toContain("bare branch/loop");
});

vtest("marks builder tests as unsupported (simple tests only)", async () => {
  const builder = glubeanTest("builder").step("s1", async () => {});
  const shape = await dryRunTest(builder as unknown as Parameters<typeof dryRunTest>[0], {
    exportName: "t",
  });
  expect(shape.projectionComplete).toBe(false);
  expect(shape.incompleteReason).toContain("simple test");
});

vtest("ctx.while projects the body once (representative iteration)", async () => {
  const t = glubeanTest("paginate", async (ctx) => {
    let more = true;
    await ctx.while(
      () => more,
      async () => {
        const res = await ctx.http.get("https://api.test/page");
        const body = (await res.json()) as { hasMore: boolean };
        ctx.assert(true, "page fetched");
        more = body.hasMore;
      },
      "paginate",
    );
  });
  const shape = await dryRunTest(t, { exportName: "t" });
  expect(shape.projectionComplete).toBe(true); // body once, no budget spin
  // exactly one GET + one assertion, both tagged with the described loop
  expect(shape.endpoints).toEqual([
    { method: "GET", url: "https://api.test/page", branch: "while#0 (paginate)" },
  ]);
  expect(shape.assertions).toEqual([
    { kind: "assert", message: "page fetched", branch: "while#0 (paginate)" },
  ]);
});

vtest("describe annotates when/switch branch tags", async () => {
  const t = glubeanTest("described", async (ctx) => {
    const res = await ctx.http.get("https://api.test/x");
    const status = res.status;
    await ctx.when(
      status === 200,
      () => ctx.assert(true, "ok"),
      () => ctx.assert(true, "bad"),
      "request succeeds",
    );
    await ctx.switch([
      { when: () => status === 404, then: () => ctx.assert(true, "nf"), describe: "not found" },
      { when: () => status === 403, then: () => ctx.assert(true, "fb"), describe: "forbidden" },
    ]);
  });
  const shape = await dryRunTest(t, { exportName: "t" });
  expect(shape.assertions.map((a) => a.branch)).toEqual([
    "when#0 (request succeeds):then",
    "when#0 (request succeeds):else",
    "switch#0:case[0] (not found)",
    "switch#0:case[1] (forbidden)",
  ]);
});

vtest("projects env-based URLs with a named placeholder, not a numeric coercion", async () => {
  const t = glubeanTest("env-url", async (ctx) => {
    const base = ctx.vars.require("BASE_URL");
    await ctx.http.get(`${base}/health`);
  });
  const shape = await dryRunTest(t, { exportName: "t" });
  expect(shape.endpoints).toEqual([
    { method: "GET", url: "<BASE_URL>/health", branch: undefined },
  ]);
});

vtest("records ctx.validate as a schema assertion", async () => {
  const t = glubeanTest("validates", async (ctx) => {
    const res = await ctx.http.get("https://api.test/user");
    const body = await res.json();
    ctx.validate(body, {} as never, "user schema");
  });
  const shape = await dryRunTest(t, { exportName: "t" });
  expect(shape.assertionCount).toBe(1);
  expect(shape.assertions[0]).toMatchObject({ kind: "validate", message: "user schema" });
});

vtest("ctx.skip marks the shape skipped, not failed", async () => {
  const t = glubeanTest("skipper", async (ctx) => {
    ctx.skip("not ready");
    ctx.assert(true, "never");
  });
  const shape: TestShape = await dryRunTest(t, { exportName: "t" });
  expect(shape.skipped).toBe(true);
  expect(shape.projectionComplete).toBe(true);
});
