import { test as vtest, expect } from "vitest";
import { test as glubeanTest, configure } from "@glubean/sdk";
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

vtest("projects configure({ http: { prefixUrl } }) with the resolved URL", async () => {
  const api = configure({ http: { prefixUrl: "https://api.test" } });
  const t = glubeanTest("configured", async (ctx) => {
    const res = await api.http.get("users");
    ctx.assert((res as { ok: boolean }).ok, "ok");
  });
  const shape = await dryRunTest(t, { exportName: "t" });
  // No "can only be accessed during test execution" throw, and the configured
  // prefixUrl is resolved into the projected endpoint.
  expect(shape.projectionComplete).toBe(true);
  expect(shape.endpoints).toEqual([
    { method: "GET", url: "https://api.test/users", branch: undefined },
  ]);
  expect(shape.assertionCount).toBe(1);
});

vtest("ctx.http.extend({ prefixUrl }) is reflected in projected endpoints", async () => {
  const t = glubeanTest("extended", async (ctx) => {
    const api = ctx.http.extend({ prefixUrl: "https://svc.test" });
    await api.get("/health");
    // concise matcher body — return value ignored, must still type-check
    await ctx.when(true, () => ctx.expect(api).toBeDefined());
  });
  const shape = await dryRunTest(t, { exportName: "t" });
  expect(shape.endpoints).toEqual([
    { method: "GET", url: "https://svc.test/health", branch: undefined },
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

vtest("array helper callbacks (forEach/map) run once and capture assertions", async () => {
  const t = glubeanTest("array-helpers", async (ctx) => {
    const res = await ctx.http.get("https://api.test/list");
    const body = (await res.json()) as { items: unknown[]; tags: unknown[] };
    body.items.forEach((item: any) => {
      ctx.assert(item.id, "item id");
    });
    body.tags.map((tag: unknown) => ctx.expect(tag).toBeDefined());
  });
  const shape = await dryRunTest(t, { exportName: "t" });
  expect(shape.projectionComplete).toBe(true);
  // forEach cb ran once (1 assert) + map cb ran once (1 expect)
  expect(shape.assertionCount).toBe(2);
});

vtest("concurrent dryRunTest raw-fetch recording stays isolated (ALS)", async () => {
  const mk = (id: string, url: string) =>
    glubeanTest(id, async () => {
      await fetch(url);
    });
  const [a, b] = await Promise.all([
    dryRunTest(mk("a", "https://a.test/x"), { exportName: "a" }),
    dryRunTest(mk("b", "https://b.test/y"), { exportName: "b" }),
  ]);
  expect(a.endpoints).toEqual([{ method: "GET", url: "https://a.test/x", branch: undefined }]);
  expect(b.endpoints).toEqual([{ method: "GET", url: "https://b.test/y", branch: undefined }]);
  expect(globalThis.fetch).toBeDefined(); // restored after both released
});

vtest("ctx.http accepts a URL object (projected by href)", async () => {
  const t = glubeanTest("url-obj", async (ctx) => {
    await ctx.http.get(new URL("https://api.test/x"));
  });
  const shape = await dryRunTest(t, { exportName: "t" });
  expect(shape.endpoints).toEqual([
    { method: "GET", url: "https://api.test/x", branch: undefined },
  ]);
});

vtest("chainable .blob() projects without throwing", async () => {
  const t = glubeanTest("blob-chain", async (ctx) => {
    await ctx.http.get("https://api.test/file").blob();
    ctx.assert(true, "downloaded");
  });
  const shape = await dryRunTest(t, { exportName: "t" });
  expect(shape.projectionComplete).toBe(true);
  expect(shape.endpoints).toEqual([
    { method: "GET", url: "https://api.test/file", branch: undefined },
  ]);
});

vtest("unknown ctx properties (test.extend fixtures) resolve to synthetic, not throw", async () => {
  const t = glubeanTest("fixture-ish", async (ctx) => {
    // `ctx.auth` is not a base ctx member — a fixture would inject it. The proxy
    // returns a synthetic value so the body projects instead of throwing.
    const token = (ctx as unknown as { auth: { token: string } }).auth.token;
    await ctx.http.get(`https://api.test/me?t=${token}`);
    ctx.assert(true, "ok");
  });
  const shape = await dryRunTest(t, { exportName: "t" });
  expect(shape.projectionComplete).toBe(true);
  expect(shape.assertionCount).toBe(1);
  expect(shape.endpoints).toHaveLength(1);
});

vtest("dryRunTest captures raw global fetch and restores fetch afterwards", async () => {
  const before = globalThis.fetch;
  const t = glubeanTest("raw-direct", async (ctx) => {
    await fetch("https://api.test/raw");
    ctx.assert(true, "fetched");
  });
  const shape = await dryRunTest(t, { exportName: "t" });
  // raw fetch captured (no real network — api.test is not a real host)
  expect(shape.endpoints).toContainEqual({
    method: "GET",
    url: "https://api.test/raw",
    branch: undefined,
  });
  // global fetch restored — the direct API doesn't leave the process patched
  expect(globalThis.fetch).toBe(before);
});

vtest("ctx.http callable form honors the method option (not always GET)", async () => {
  const t = glubeanTest("callable-post", async (ctx) => {
    await ctx.http("https://api.test/users", { method: "POST" });
    await ctx.http.get("https://api.test/users");
  });
  const shape = await dryRunTest(t, { exportName: "t" });
  expect(shape.endpoints).toEqual([
    { method: "POST", url: "https://api.test/users", branch: undefined },
    { method: "GET", url: "https://api.test/users", branch: undefined },
  ]);
});

vtest("ctx.vars.all() destructuring resolves named placeholders", async () => {
  const t = glubeanTest("vars-all", async (ctx) => {
    const { BASE_URL } = ctx.vars.all() as { BASE_URL: string };
    await ctx.http.get(`${BASE_URL}/health`);
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

vtest("ctx.skip inside a when arm is branch-local — sibling arm still projects", async () => {
  const t = glubeanTest("branch-skip", async (ctx) => {
    const res = await ctx.http.get("https://api.test/x");
    await ctx.when(
      res.status === 200,
      () => ctx.skip("n/a in success"),
      () => ctx.assert(true, "failure asserted"),
    );
  });
  const shape = await dryRunTest(t, { exportName: "t" });
  expect(shape.skipped).toBeUndefined(); // not a whole-test skip
  expect(shape.assertions.map((a) => ({ kind: a.kind, branch: a.branch }))).toEqual([
    { kind: "skip", branch: "when#0:then" },
    { kind: "assert", branch: "when#0:else" },
  ]);
});
