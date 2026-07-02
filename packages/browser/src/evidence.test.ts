import { test, expect } from "vitest";
import {
  buildEmulationCalls,
  buildFulfillParams,
  buildSetCookiesParams,
  EvidenceSession,
  findMock,
  guardPageMethod,
  matchMock,
  type EvidenceScreenshotOptions,
  type MockRule,
  type ScreenshotEntry,
  type ScreenshotTrigger,
  type StorageCookie,
} from "./evidence.js";

// ── Fakes ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

class FakeCDPSession {
  sent: Array<{ method: string; params?: unknown }> = [];
  listeners = new Map<string, Set<AnyFn>>();
  detached = false;
  sendImpl?: (method: string, params?: unknown) => unknown;

  async send(method: string, params?: unknown): Promise<unknown> {
    this.sent.push({ method, params });
    if (this.sendImpl) return this.sendImpl(method, params);
    if (method === "Network.getResponseBody") {
      return { body: "", base64Encoded: false };
    }
    return {};
  }
  on(event: string, fn: AnyFn): this {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return this;
  }
  off(event: string, fn: AnyFn): this {
    this.listeners.get(event)?.delete(fn);
    return this;
  }
  emit(event: string, payload: unknown): void {
    for (const fn of [...(this.listeners.get(event) ?? [])]) fn(payload);
  }
  async detach(): Promise<void> {
    this.detached = true;
  }
  methods(): string[] {
    return this.sent.map((s) => s.method);
  }
  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

class FakePage {
  cdp = new FakeCDPSession();
  interception: boolean | undefined;
  viewportCalls: unknown[] = [];
  pageUrl = "https://x.example/app";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  newDocumentScripts: Array<{ fn: (...args: any[]) => unknown; args: unknown[] }> = [];
  async createCDPSession(): Promise<FakeCDPSession> {
    return this.cdp;
  }
  async setRequestInterception(v: boolean): Promise<void> {
    this.interception = v;
  }
  async setViewport(v: unknown): Promise<void> {
    this.viewportCalls.push(v);
  }
  url(): string {
    return this.pageUrl;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async evaluate(fn: (...args: any[]) => any): Promise<any> {
    // The real page.evaluate() runs `fn` in the browser, where `globalThis`
    // (patched per-test via `withFakeLocalStorage`) IS `window`. Node has no
    // such global by default, so tests that exercise localStorage patch it.
    return await fn();
  }
  /**
   * `page.evaluateOnNewDocument()` — records the call rather than actually
   * re-running it on a simulated navigation (matching this suite's style of
   * asserting "the right thing was invoked", as for CDP `send()` calls).
   * Real end-to-end proof that this specific API (not a raw CDP call on an
   * auxiliary session) is required lives in the module doc's guardrail ③.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async evaluateOnNewDocument(fn: (...args: any[]) => unknown, ...args: unknown[]): Promise<void> {
    this.newDocumentScripts.push({ fn, args });
  }
}

/**
 * Temporarily install a fake `globalThis.localStorage` (Web Storage shape)
 * backed by `data`, run `fn`, then restore. Used to test
 * `EvidenceSession.captureStorageState()`'s `page.evaluate(() => ...
 * globalThis.localStorage ...)` callback without a real browser.
 */
async function withFakeLocalStorage<T>(
  data: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const fakeLocalStorage = {
    get length() {
      return Object.keys(data).length;
    },
    key: (i: number) => Object.keys(data)[i] ?? null,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    value: fakeLocalStorage,
    configurable: true,
    writable: true,
  });
  try {
    return await fn();
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    else delete (globalThis as any).localStorage;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asPage = (p: FakePage): any => p;

// ── matchMock / findMock ──────────────────────────────────────────────

test("matchMock: string matches by substring", () => {
  const rule: MockRule = { url: "/api/user" };
  expect(matchMock(rule, { url: "https://x.com/api/user?id=1", method: "GET" }))
    .toBe(true);
  expect(matchMock(rule, { url: "https://x.com/api/order", method: "GET" }))
    .toBe(false);
});

test("matchMock: regex matches by test()", () => {
  const rule: MockRule = { url: /\/api\/user\/\d+$/ };
  expect(matchMock(rule, { url: "https://x.com/api/user/42", method: "GET" }))
    .toBe(true);
  expect(matchMock(rule, { url: "https://x.com/api/user/x", method: "GET" }))
    .toBe(false);
});

test("matchMock: method filter is case-insensitive", () => {
  const rule: MockRule = { url: "/api", method: "post" };
  expect(matchMock(rule, { url: "/api", method: "POST" })).toBe(true);
  expect(matchMock(rule, { url: "/api", method: "GET" })).toBe(false);
});

test("matchMock: global/sticky regex matches same URL on repeated calls", () => {
  // A `/g` (or `/y`) regex carries lastIndex state, so `.test()` on the raw
  // regex would flip-flop for the same URL and leak repeat requests to the real
  // network. Matching must be stateless and must not mutate the caller's regex.
  const re = /\/api\/user/g;
  const rule: MockRule = { url: re };
  const req = { url: "https://x.com/api/user", method: "GET" };
  expect(matchMock(rule, req)).toBe(true);
  expect(matchMock(rule, req)).toBe(true);
  expect(matchMock(rule, req)).toBe(true);
  expect(re.lastIndex).toBe(0); // original regex untouched
});

test("matchMock: sticky (/y) regex also matches statelessly across repeated calls", () => {
  // Same statelessness contract as the /g case above, but for /y specifically:
  // a sticky regex advances (or resets) `lastIndex` on `.test()` just like a
  // global one does. Repeated matchMock() calls against the SAME sticky rule
  // must all agree, and the caller's regex object must come out untouched.
  const re = /^\/api\/user\/\d+$/y;
  const rule: MockRule = { url: re };
  const req = { url: "/api/user/42", method: "GET" };
  expect(matchMock(rule, req)).toBe(true);
  expect(matchMock(rule, req)).toBe(true);
  expect(matchMock(rule, req)).toBe(true);
  expect(re.lastIndex).toBe(0); // original regex untouched
});

test("matchMock: sticky (/y) regex anchors at the start of the string — GLU-73 regression", () => {
  // `/y` requires the match to start exactly at `lastIndex` (0 on a fresh
  // clone) — that's the whole point of sticky matching, distinct from a
  // plain regex's "match anywhere in the string" `.test()` semantics.
  //
  // A prior fix (b63b117) stripped `g`/`y` from the matching clone to solve
  // a *different* problem (lastIndex state leaking across calls). That also
  // erased the sticky anchor: `/\/api\/user/y` would then match
  // "https://x.com/api/user" as a mid-string substring hit, even though the
  // sticky flag says it must only match starting at index 0. That's the
  // over-matching this test guards against.
  const stickyNoCaret = /\/api\/user/y;
  // Matches: the pattern occurs starting at index 0 of the string.
  expect(matchMock({ url: stickyNoCaret }, { url: "/api/user", method: "GET" }))
    .toBe(true);
  // Does NOT match: "/api/user" only occurs mid-string (after "https://x.com"),
  // not at index 0 — a sticky regex must reject this, unlike a plain one.
  expect(
    matchMock(
      { url: stickyNoCaret },
      { url: "https://x.com/api/user", method: "GET" },
    ),
  ).toBe(false);

  // An explicitly-anchored sticky pattern still works as expected either way.
  const stickyAnchored = /^\/api\/user\/\d+$/y;
  expect(
    matchMock({ url: stickyAnchored }, { url: "/api/user/42", method: "GET" }),
  ).toBe(true);
  expect(
    matchMock(
      { url: stickyAnchored },
      { url: "/api/user/42/extra", method: "GET" },
    ),
  ).toBe(false);
  expect(
    matchMock(
      { url: stickyAnchored },
      { url: "/other/api/user/42", method: "GET" },
    ),
  ).toBe(false);
});

test("findMock: returns the first matching rule", () => {
  const mocks: MockRule[] = [
    { url: "/api/order" },
    { url: "/api/user", body: "first" },
    { url: "/api/user", body: "second" },
  ];
  const hit = findMock(mocks, { url: "/api/user", method: "GET" });
  expect(hit?.body).toBe("first");
  expect(findMock(mocks, { url: "/nope", method: "GET" })).toBeUndefined();
});

// ── buildFulfillParams ────────────────────────────────────────────────

function decodeBody(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf8");
}
function headerValue(
  headers: Array<{ name: string; value: string }>,
  name: string,
): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name)?.value;
}

test("buildFulfillParams: defaults status 200 and empty body", () => {
  const p = buildFulfillParams({ url: "/x" }, "req-1");
  expect(p.requestId).toBe("req-1");
  expect(p.responseCode).toBe(200);
  expect(decodeBody(p.body)).toBe("");
  expect(p.responseHeaders).toEqual([]);
});

test("buildFulfillParams: string body → text/plain, base64-encoded", () => {
  const p = buildFulfillParams({ url: "/x", body: "hello", status: 201 }, "r");
  expect(p.responseCode).toBe(201);
  expect(decodeBody(p.body)).toBe("hello");
  expect(headerValue(p.responseHeaders, "content-type"))
    .toBe("text/plain; charset=utf-8");
});

test("buildFulfillParams: object body → JSON + application/json", () => {
  const p = buildFulfillParams({ url: "/x", body: { id: 1, name: "Ada" } }, "r");
  expect(decodeBody(p.body)).toBe('{"id":1,"name":"Ada"}');
  expect(headerValue(p.responseHeaders, "content-type"))
    .toBe("application/json; charset=utf-8");
});

test("buildFulfillParams: explicit contentType overrides inference", () => {
  const p = buildFulfillParams(
    { url: "/x", body: { a: 1 }, contentType: "application/ld+json" },
    "r",
  );
  expect(headerValue(p.responseHeaders, "content-type"))
    .toBe("application/ld+json");
});

test("buildFulfillParams: user headers win over inferred content-type", () => {
  const p = buildFulfillParams(
    { url: "/x", body: { a: 1 }, headers: { "Content-Type": "text/csv" } },
    "r",
  );
  const cts = p.responseHeaders.filter(
    (h) => h.name.toLowerCase() === "content-type",
  );
  expect(cts).toHaveLength(1);
  expect(cts[0].value).toBe("text/csv");
});

// ── buildEmulationCalls ───────────────────────────────────────────────

test("buildEmulationCalls: empty options → no calls", () => {
  expect(buildEmulationCalls({})).toEqual([]);
});

test("buildEmulationCalls: timezone only", () => {
  expect(buildEmulationCalls({ timezone: "America/New_York" })).toEqual([
    {
      method: "Emulation.setTimezoneOverride",
      params: { timezoneId: "America/New_York" },
    },
  ]);
});

test("buildEmulationCalls: geolocation defaults accuracy to 0", () => {
  const calls = buildEmulationCalls({
    geolocation: { latitude: 1.5, longitude: -2.5 },
  });
  expect(calls).toEqual([
    {
      method: "Emulation.setGeolocationOverride",
      params: { latitude: 1.5, longitude: -2.5, accuracy: 0 },
    },
  ]);
});

test("buildEmulationCalls: viewport fills device-metric defaults", () => {
  const calls = buildEmulationCalls({ viewport: { width: 390, height: 844 } });
  expect(calls[0]).toEqual({
    method: "Emulation.setDeviceMetricsOverride",
    params: { width: 390, height: 844, deviceScaleFactor: 1, mobile: false },
  });
});

test("buildEmulationCalls: viewport is applied LAST (guardrail ①)", () => {
  const calls = buildEmulationCalls({
    timezone: "UTC",
    geolocation: { latitude: 0, longitude: 0 },
    viewport: { width: 800, height: 600 },
  });
  expect(calls.map((c) => c.method)).toEqual([
    "Emulation.setTimezoneOverride",
    "Emulation.setGeolocationOverride",
    "Emulation.setDeviceMetricsOverride",
  ]);
});

// ── guardPageMethod ───────────────────────────────────────────────────

test("guardPageMethod: blocks / allows per predicate, then restores", () => {
  const obj = {
    calls: [] as unknown[][],
    async foo(...args: unknown[]) {
      this.calls.push(args);
      return "orig";
    },
  };
  const restore = guardPageMethod(
    obj,
    "foo",
    "blocked!",
    (args) => args[0] === true,
  );
  expect(() => obj.foo(true)).toThrow("blocked!");
  // allowed call delegates to the original (bound to obj)
  return obj.foo(false).then((r) => {
    expect(r).toBe("orig");
    expect(obj.calls).toEqual([[false]]);
    restore();
    // restored own method still works
    return obj.foo(true).then((r2) => {
      expect(r2).toBe("orig");
    });
  });
});

test("guardPageMethod: restore deletes the guard when method was on prototype", () => {
  const page = new FakePage();
  const restore = guardPageMethod(page, "setViewport", "no", () => true);
  expect(Object.prototype.hasOwnProperty.call(page, "setViewport")).toBe(true);
  restore();
  expect(Object.prototype.hasOwnProperty.call(page, "setViewport")).toBe(false);
  // prototype method is reachable again
  return page.setViewport({ width: 1 }).then(() => {
    expect(page.viewportCalls).toEqual([{ width: 1 }]);
  });
});

// ── EvidenceSession.attach: capability gating ─────────────────────────

test("attach: trace only enables Network, not Fetch/Emulation", async () => {
  const page = new FakePage();
  const session = await EvidenceSession.attach(asPage(page), {
    trace: () => {},
  });
  expect(page.cdp.methods()).toContain("Network.enable");
  expect(page.cdp.methods()).not.toContain("Fetch.enable");
  expect(page.cdp.methods().some((m) => m.startsWith("Emulation."))).toBe(false);
  // No mocks → user request interception is NOT guarded.
  await page.setRequestInterception(true);
  expect(page.interception).toBe(true);
  await session.detach();
});

test("attach: no trace → Network not enabled", async () => {
  const page = new FakePage();
  await EvidenceSession.attach(asPage(page), {});
  expect(page.cdp.methods()).not.toContain("Network.enable");
});

// ── EvidenceSession.attach: Fetch mock + guardrail ② ──────────────────

test("attach: mocks enable Fetch and route paused requests", async () => {
  const page = new FakePage();
  const session = await EvidenceSession.attach(asPage(page), {
    mocks: [{ url: "/api/user", body: { ok: true } }],
  });

  const fetchEnable = page.cdp.sent.find((s) => s.method === "Fetch.enable");
  expect(fetchEnable).toBeDefined();
  expect(fetchEnable?.params).toEqual({
    patterns: [{ urlPattern: "*", requestStage: "Request" }],
  });
  expect(page.cdp.listenerCount("Fetch.requestPaused")).toBe(1);

  // Matching request → fulfill
  page.cdp.emit("Fetch.requestPaused", {
    requestId: "a",
    request: { url: "https://x/api/user", method: "GET" },
  });
  // Non-matching request → continue
  page.cdp.emit("Fetch.requestPaused", {
    requestId: "b",
    request: { url: "https://x/assets/app.js", method: "GET" },
  });

  const fulfill = page.cdp.sent.find((s) => s.method === "Fetch.fulfillRequest");
  const cont = page.cdp.sent.find((s) => s.method === "Fetch.continueRequest");
  expect((fulfill?.params as { requestId: string }).requestId).toBe("a");
  expect(cont?.params).toEqual({ requestId: "b" });

  await session.detach();
});

test("attach: guardrail ② blocks page.setRequestInterception(true)", async () => {
  const page = new FakePage();
  const session = await EvidenceSession.attach(asPage(page), {
    mocks: [{ url: "/x" }],
  });
  expect(() => page.setRequestInterception(true)).toThrow(
    /Glubean request mocking is active/,
  );
  // disabling is allowed through to the original
  await page.setRequestInterception(false);
  expect(page.interception).toBe(false);

  // detach restores the original method
  await session.detach();
  await page.setRequestInterception(true);
  expect(page.interception).toBe(true);
});

// ── EvidenceSession.attach: Emulation + guardrail ① ───────────────────

test("attach: emulation sends CDP calls with viewport last", async () => {
  const page = new FakePage();
  const session = await EvidenceSession.attach(asPage(page), {
    trace: () => {},
    mocks: [{ url: "/x" }],
    emulate: {
      timezone: "UTC",
      geolocation: { latitude: 1, longitude: 2, accuracy: 5 },
      viewport: { width: 375, height: 667 },
    },
  });

  const methods = page.cdp.methods();
  // Network + Fetch enabled before emulation; viewport (device metrics) last.
  expect(methods.indexOf("Emulation.setDeviceMetricsOverride"))
    .toBeGreaterThan(methods.indexOf("Network.enable"));
  expect(methods.indexOf("Emulation.setDeviceMetricsOverride"))
    .toBeGreaterThan(methods.indexOf("Fetch.enable"));
  expect(methods.indexOf("Emulation.setDeviceMetricsOverride"))
    .toBeGreaterThan(methods.indexOf("Emulation.setGeolocationOverride"));

  const geo = page.cdp.sent.find(
    (s) => s.method === "Emulation.setGeolocationOverride",
  );
  expect(geo?.params).toEqual({ latitude: 1, longitude: 2, accuracy: 5 });

  await session.detach();
});

test("attach: guardrail ① blocks page.setViewport when viewport is owned", async () => {
  const page = new FakePage();
  const session = await EvidenceSession.attach(asPage(page), {
    emulate: { viewport: { width: 800, height: 600 } },
  });
  expect(() => page.setViewport({ width: 1024, height: 768 })).toThrow(
    /Glubean owns the viewport/,
  );
  await session.detach();
  // restored after detach
  await page.setViewport({ width: 1024, height: 768 });
  expect(page.viewportCalls).toEqual([{ width: 1024, height: 768 }]);
});

test("attach: viewport NOT guarded when emulate has no viewport", async () => {
  const page = new FakePage();
  const session = await EvidenceSession.attach(asPage(page), {
    emulate: { timezone: "UTC" },
  });
  await page.setViewport({ width: 320, height: 480 });
  expect(page.viewportCalls).toEqual([{ width: 320, height: 480 }]);
  await session.detach();
});

// ── detach: teardown + idempotency + rollback ─────────────────────────

test("detach: removes listeners, detaches session, is idempotent", async () => {
  const page = new FakePage();
  const session = await EvidenceSession.attach(asPage(page), {
    trace: () => {},
    mocks: [{ url: "/x" }],
  });
  expect(page.cdp.listenerCount("Fetch.requestPaused")).toBe(1);
  expect(page.cdp.listenerCount("Network.requestWillBeSent")).toBe(1);

  await session.detach();
  expect(page.cdp.detached).toBe(true);
  expect(page.cdp.listenerCount("Fetch.requestPaused")).toBe(0);
  expect(page.cdp.listenerCount("Network.requestWillBeSent")).toBe(0);

  // idempotent — second detach is a no-op
  page.cdp.detached = false;
  await session.detach();
  expect(page.cdp.detached).toBe(false);
});

test("attach: rolls back guards + session when wiring throws", async () => {
  const page = new FakePage();
  page.cdp.sendImpl = (method) => {
    if (method === "Fetch.enable") throw new Error("boom");
    return {};
  };
  await expect(
    EvidenceSession.attach(asPage(page), { mocks: [{ url: "/x" }] }),
  ).rejects.toThrow("boom");

  // Guard was rolled back — interception is settable again.
  await page.setRequestInterception(true);
  expect(page.interception).toBe(true);
  // Session was detached during rollback.
  expect(page.cdp.detached).toBe(true);
});

// ── EvidenceSession.captureShot: mode × trigger matrix ────────────────

/** Build a screenshots option whose shoot records calls and returns a fixed ref. */
function makeShootOpts(
  mode: EvidenceScreenshotOptions["mode"],
  calls: Array<{ filename: string; label: string; trigger: ScreenshotTrigger }>,
): EvidenceScreenshotOptions {
  return {
    mode,
    shoot: async (filename, label, trigger) => {
      calls.push({ filename, label, trigger });
      return { artifactId: `art-${calls.length}` };
    },
  };
}

test("captureShot: mode=off — blocks step/failure but manual still fires", async () => {
  const page = new FakePage();
  const shotCalls: Array<{ filename: string; label: string; trigger: ScreenshotTrigger }> = [];
  const session = await EvidenceSession.attach(asPage(page), {
    screenshots: makeShootOpts("off", shotCalls),
  });

  await session.captureShot("action", "step");
  await session.captureShot("action", "failure");
  // Automatic triggers are blocked in off mode.
  expect(shotCalls).toHaveLength(0);
  expect(session.screenshots).toHaveLength(0);

  // Explicit manual checkpoint must always fire regardless of mode.
  await session.captureShot("checkpoint", "manual");
  expect(shotCalls).toHaveLength(1);
  expect(shotCalls[0]!.trigger).toBe("manual");
  expect(session.screenshots).toHaveLength(1);
  await session.detach();
});

test("captureShot: mode=on-failure — step skipped, failure+manual captured", async () => {
  const page = new FakePage();
  const shotCalls: Array<{ filename: string; label: string; trigger: ScreenshotTrigger }> = [];
  const session = await EvidenceSession.attach(asPage(page), {
    screenshots: makeShootOpts("on-failure", shotCalls),
  });

  await session.captureShot("click", "step");       // skipped
  await session.captureShot("click", "failure");     // captured
  await session.captureShot("check", "manual");      // captured

  expect(shotCalls).toHaveLength(2);
  expect(shotCalls[0].trigger).toBe("failure");
  expect(shotCalls[1].trigger).toBe("manual");
  expect(session.screenshots).toHaveLength(2);
  await session.detach();
});

test("captureShot: mode=every-step — all triggers captured", async () => {
  const page = new FakePage();
  const shotCalls: Array<{ filename: string; label: string; trigger: ScreenshotTrigger }> = [];
  const session = await EvidenceSession.attach(asPage(page), {
    screenshots: makeShootOpts("every-step", shotCalls),
  });

  await session.captureShot("goto", "step");
  await session.captureShot("click", "failure");
  await session.captureShot("check", "manual");

  expect(shotCalls).toHaveLength(3);
  expect(shotCalls.map((c) => c.trigger)).toEqual(["step", "failure", "manual"]);
  await session.detach();
});

test("captureShot: screenshots option absent → captureShot is a no-op", async () => {
  const page = new FakePage();
  const session = await EvidenceSession.attach(asPage(page), {});
  // Should not throw and should not add any entries.
  await session.captureShot("whatever", "step");
  expect(session.screenshots).toHaveLength(0);
  await session.detach();
});

test("captureShot: ScreenshotEntry has correct shape (seq, ts, label, trigger, artifactId)", async () => {
  const page = new FakePage();
  const shotCalls: Array<{ filename: string; label: string; trigger: ScreenshotTrigger }> = [];
  const session = await EvidenceSession.attach(asPage(page), {
    screenshots: makeShootOpts("every-step", shotCalls),
  });

  await session.captureShot("goto-/dashboard", "step");
  await session.captureShot("click-#submit", "failure");

  const [first, second] = session.screenshots as ScreenshotEntry[];
  expect(first.seq).toBe(1);
  expect(first.label).toBe("goto-/dashboard");
  expect(first.trigger).toBe("step");
  expect(first.artifactId).toBe("art-1");
  expect(typeof first.ts).toBe("string");
  expect(new Date(first.ts).getTime()).toBeGreaterThan(0);

  expect(second.seq).toBe(2);
  expect(second.trigger).toBe("failure");
  expect(second.artifactId).toBe("art-2");
  await session.detach();
});

test("captureShot: failure trigger produces FAIL- prefixed filename", async () => {
  const page = new FakePage();
  const shotCalls: Array<{ filename: string; label: string; trigger: ScreenshotTrigger }> = [];
  const session = await EvidenceSession.attach(asPage(page), {
    screenshots: makeShootOpts("every-step", shotCalls),
  });

  await session.captureShot("click-btn", "failure");
  await session.captureShot("goto-home", "step");

  expect(shotCalls[0].filename).toMatch(/^FAIL-001-click-btn-/);
  expect(shotCalls[1].filename).toMatch(/^002-goto-home-/);
  expect(shotCalls[0].filename).toMatch(/\.png$/);
  await session.detach();
});

test("captureShot: shoot errors are swallowed (best-effort)", async () => {
  const page = new FakePage();
  const session = await EvidenceSession.attach(asPage(page), {
    screenshots: {
      mode: "every-step",
      shoot: async () => { throw new Error("screenshot I/O failure"); },
    },
  });

  // Should not throw; entry is not pushed on failure.
  await expect(session.captureShot("action", "step")).resolves.toBeUndefined();
  expect(session.screenshots).toHaveLength(0);
  await session.detach();
});

test("captureShot: seq is monotonically increasing across multiple captures", async () => {
  const page = new FakePage();
  const shotCalls: Array<{ filename: string; label: string; trigger: ScreenshotTrigger }> = [];
  const session = await EvidenceSession.attach(asPage(page), {
    screenshots: makeShootOpts("every-step", shotCalls),
  });

  for (let i = 0; i < 5; i++) {
    await session.captureShot(`step-${i}`, "step");
  }

  expect(session.screenshots.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(shotCalls[4].filename).toMatch(/^005-/);
  await session.detach();
});

// ── M4: buildEmulationCalls — userAgent ────────────────────────────────

test("buildEmulationCalls: userAgent only", () => {
  expect(buildEmulationCalls({ userAgent: "GlubeanBot/1.0" })).toEqual([
    {
      method: "Emulation.setUserAgentOverride",
      params: { userAgent: "GlubeanBot/1.0" },
    },
  ]);
});

test("buildEmulationCalls: userAgent + viewport — viewport still applied last", () => {
  const calls = buildEmulationCalls({
    userAgent: "GlubeanBot/1.0",
    viewport: { width: 390, height: 844 },
  });
  expect(calls.map((c) => c.method)).toEqual([
    "Emulation.setUserAgentOverride",
    "Emulation.setDeviceMetricsOverride",
  ]);
});

// ── M4: buildSetCookiesParams ────────────────────────────────────────────

test("buildSetCookiesParams: undefined cookies → undefined (no CDP call)", () => {
  expect(buildSetCookiesParams(undefined)).toBeUndefined();
});

test("buildSetCookiesParams: empty array → undefined (no CDP call)", () => {
  expect(buildSetCookiesParams([])).toBeUndefined();
});

test("buildSetCookiesParams: non-empty array → wrapped params", () => {
  const cookies: StorageCookie[] = [{ name: "sid", value: "1", domain: "x.com" }];
  expect(buildSetCookiesParams(cookies)).toEqual({ cookies });
});

// ── M4: EvidenceSession.attach — storage state ────────────────────────

test("attach: no storageState → neither Network.setCookies nor evaluateOnNewDocument called", async () => {
  const page = new FakePage();
  await EvidenceSession.attach(asPage(page), {});
  expect(page.cdp.methods()).not.toContain("Network.setCookies");
  expect(page.newDocumentScripts).toHaveLength(0);
});

test("attach: storageState.cookies sends Network.setCookies", async () => {
  const page = new FakePage();
  const cookies: StorageCookie[] = [
    { name: "sid", value: "abc123", domain: "x.example", path: "/" },
  ];
  const session = await EvidenceSession.attach(asPage(page), {
    storageState: { cookies },
  });
  const call = page.cdp.sent.find((s) => s.method === "Network.setCookies");
  expect(call?.params).toEqual({ cookies });
  await session.detach();
});

test("attach: storageState.localStorage seeds via page.evaluateOnNewDocument() — NOT a raw CDP call on this session", async () => {
  // Guardrail ③: a raw `Page.addScriptToEvaluateOnNewDocument` CDP call on
  // this auxiliary session silently never fires (verified empirically) —
  // this must go through Puppeteer's own evaluateOnNewDocument() instead.
  const page = new FakePage();
  const session = await EvidenceSession.attach(asPage(page), {
    storageState: { localStorage: { token: "xyz" } },
  });
  expect(page.cdp.methods()).not.toContain("Page.addScriptToEvaluateOnNewDocument");
  expect(page.newDocumentScripts).toHaveLength(1);
  const [{ fn, args }] = page.newDocumentScripts;
  expect(args).toEqual([{ token: "xyz" }]);
  // The registered function actually seeds localStorage when run — exercise
  // it the way the real browser would run it on a new document.
  await withFakeLocalStorage({}, async () => {
    fn(...args);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((globalThis as any).localStorage.getItem("token")).toBe("xyz");
  });
  await session.detach();
});

test("attach: storageState with empty cookies/localStorage sends neither call", async () => {
  const page = new FakePage();
  const session = await EvidenceSession.attach(asPage(page), {
    storageState: { cookies: [], localStorage: {} },
  });
  expect(page.cdp.methods()).not.toContain("Network.setCookies");
  expect(page.newDocumentScripts).toHaveLength(0);
  await session.detach();
});

// ── M4: EvidenceSession.captureStorageState ────────────────────────────

test("captureStorageState: reads cookies scoped to the page's current URL", async () => {
  const page = new FakePage();
  page.pageUrl = "https://x.example/checkout";
  const cookies: StorageCookie[] = [
    { name: "sid", value: "abc", domain: "x.example" },
  ];
  page.cdp.sendImpl = (method) => {
    if (method === "Network.getCookies") return { cookies };
    return {};
  };
  const session = await EvidenceSession.attach(asPage(page), {});
  const state = await withFakeLocalStorage({}, () =>
    session.captureStorageState(asPage(page)),
  );

  const getCookiesCall = page.cdp.sent.find((s) => s.method === "Network.getCookies");
  expect(getCookiesCall?.params).toEqual({ urls: ["https://x.example/checkout"] });
  expect(state.cookies).toEqual(cookies);
  await session.detach();
});

test("captureStorageState: reads localStorage from the page", async () => {
  const page = new FakePage();
  page.cdp.sendImpl = (method) => {
    if (method === "Network.getCookies") return { cookies: [] };
    return {};
  };
  const session = await EvidenceSession.attach(asPage(page), {});
  const state = await withFakeLocalStorage(
    { theme: "dark", token: "xyz" },
    () => session.captureStorageState(asPage(page)),
  );

  expect(state.localStorage).toEqual({ theme: "dark", token: "xyz" });
  await session.detach();
});

test("captureStorageState: round-trips into a subsequent attach()'s storageState", async () => {
  // Capture on one page, apply on another — the shape returned by capture
  // must be directly acceptable as `storageState.cookies` input.
  const page1 = new FakePage();
  const capturedCookies: StorageCookie[] = [
    { name: "sid", value: "abc", domain: "x.example", path: "/", httpOnly: true },
  ];
  page1.cdp.sendImpl = (method) => {
    if (method === "Network.getCookies") return { cookies: capturedCookies };
    return {};
  };
  const session1 = await EvidenceSession.attach(asPage(page1), {});
  const state = await withFakeLocalStorage({ token: "xyz" }, () =>
    session1.captureStorageState(asPage(page1)),
  );
  await session1.detach();

  const page2 = new FakePage();
  const session2 = await EvidenceSession.attach(asPage(page2), {
    storageState: state,
  });
  const setCookiesCall = page2.cdp.sent.find((s) => s.method === "Network.setCookies");
  expect(setCookiesCall?.params).toEqual({ cookies: capturedCookies });
  expect(page2.newDocumentScripts).toHaveLength(1);
  expect(page2.newDocumentScripts[0].args).toEqual([{ token: "xyz" }]);
  await session2.detach();
});

// ── EvidenceSession: downloads (BT1-M5) ────────────────────────────────

/** Simulate a full download lifecycle on `page.cdp`: willBegin, N inProgress ticks, then a terminal state. */
function emitDownload(
  page: FakePage,
  guid: string,
  url: string,
  suggestedFilename: string,
  terminal: "completed" | "canceled" = "completed",
): void {
  page.cdp.emit("Browser.downloadWillBegin", { guid, url, suggestedFilename });
  page.cdp.emit("Browser.downloadProgress", { guid, state: "inProgress" });
  page.cdp.emit("Browser.downloadProgress", { guid, state: terminal });
}

test("attach: downloads wires Browser.setDownloadBehavior with eventsEnabled", async () => {
  const page = new FakePage();
  const session = await EvidenceSession.attach(asPage(page), {
    downloads: { dir: "/tmp/dl" },
  });
  const call = page.cdp.sent.find((s) => s.method === "Browser.setDownloadBehavior");
  expect(call?.params).toEqual({
    behavior: "allow",
    downloadPath: "/tmp/dl",
    eventsEnabled: true,
  });
  await session.detach();
});

test("attach: no downloads option → Browser.setDownloadBehavior not sent", async () => {
  const page = new FakePage();
  const session = await EvidenceSession.attach(asPage(page), {});
  expect(page.cdp.methods()).not.toContain("Browser.setDownloadBehavior");
  await session.detach();
});

test("downloads: onDownload fires inProgress then completed with correct entry shape", async () => {
  const page = new FakePage();
  const seen: Array<[string, string]> = [];
  const session = await EvidenceSession.attach(asPage(page), {
    downloads: {
      dir: "/tmp/dl",
      onDownload: (entry, state) => seen.push([state, entry.path]),
    },
  });

  emitDownload(page, "g1", "https://x/receipt.txt", "receipt.txt");

  expect(seen).toEqual([
    ["inProgress", "/tmp/dl/receipt.txt"],
    ["completed", "/tmp/dl/receipt.txt"],
  ]);
  await session.detach();
});

test("downloads: waitForDownload resolves a download that completes AFTER the call (race-safe)", async () => {
  const page = new FakePage();
  const session = await EvidenceSession.attach(asPage(page), {
    downloads: { dir: "/tmp/dl" },
  });

  const pending = session.waitForDownload(5_000);
  emitDownload(page, "g1", "https://x/a.pdf", "a.pdf");

  const entry = await pending;
  expect(entry).toEqual({
    guid: "g1",
    url: "https://x/a.pdf",
    suggestedFilename: "a.pdf",
    path: "/tmp/dl/a.pdf",
  });
  await session.detach();
});

test("downloads: waitForDownload is action-scoped — a download that completed BEFORE the call does NOT satisfy it (no stale buffer)", async () => {
  const page = new FakePage();
  const seen: string[] = [];
  const session = await EvidenceSession.attach(asPage(page), {
    downloads: { dir: "/tmp/dl", onDownload: (e, s) => { if (s === "completed") seen.push(e.guid); } },
  });

  // A download completes with NO waiter registered — its evidence is emitted,
  // but it must NOT be buffered to satisfy a later, unrelated waitForDownload
  // (that would silently mis-scope the wait — codex R1 P1).
  emitDownload(page, "g0", "https://x/old.pdf", "old.pdf");
  expect(seen).toEqual(["g0"]); // evidence still emitted

  // A fresh wait must time out (nothing NEW downloaded), not resolve "old.pdf".
  await expect(session.waitForDownload(30)).rejects.toThrow(/no download completed/);
  await session.detach();
});

test("downloads: waitForDownload aborts (rejects, removes waiter) when its AbortSignal fires", async () => {
  const page = new FakePage();
  const session = await EvidenceSession.attach(asPage(page), {
    downloads: { dir: "/tmp/dl" },
  });

  const ac = new AbortController();
  const pending = session.waitForDownload(60_000, ac.signal);
  ac.abort();
  await expect(pending).rejects.toThrow(/aborted/);

  // The aborted waiter must be gone: a later download resolves a NEW wait, not the aborted one.
  const next = session.waitForDownload(5_000);
  emitDownload(page, "g1", "https://x/a.pdf", "a.pdf");
  await expect(next).resolves.toMatchObject({ guid: "g1" });
  await session.detach();
});

test("downloads: a pre-aborted signal rejects immediately", async () => {
  const page = new FakePage();
  const session = await EvidenceSession.attach(asPage(page), {
    downloads: { dir: "/tmp/dl" },
  });
  const ac = new AbortController();
  ac.abort();
  await expect(session.waitForDownload(5_000, ac.signal)).rejects.toThrow(/aborted before it started/);
  await session.detach();
});

test("downloads: waitForDownload rejects with a clear error when the download is canceled", async () => {
  const page = new FakePage();
  const session = await EvidenceSession.attach(asPage(page), {
    downloads: { dir: "/tmp/dl" },
  });

  const pending = session.waitForDownload(5_000);
  emitDownload(page, "g1", "https://x/a.pdf", "a.pdf", "canceled");

  await expect(pending).rejects.toThrow(/canceled/);
  await session.detach();
});

test("downloads: waitForDownload times out with a clear error when nothing downloads", async () => {
  const page = new FakePage();
  const session = await EvidenceSession.attach(asPage(page), {
    downloads: { dir: "/tmp/dl" },
  });

  await expect(session.waitForDownload(10)).rejects.toThrow(/no download completed after 10ms/);
  await session.detach();
});

test("downloads: waitForDownload rejects immediately when downloads are not enabled", async () => {
  const page = new FakePage();
  const session = await EvidenceSession.attach(asPage(page), {});
  await expect(session.waitForDownload(1_000)).rejects.toThrow(/not enabled/);
  await session.detach();
});

test("downloads: detach() rejects a still-pending waiter instead of leaving it hanging", async () => {
  const page = new FakePage();
  const session = await EvidenceSession.attach(asPage(page), {
    downloads: { dir: "/tmp/dl" },
  });

  const pending = session.waitForDownload(60_000);
  await session.detach();

  await expect(pending).rejects.toThrow(/detached/);
});

test("downloads: after detach(), a new waitForDownload fails fast (not enabled) rather than hanging", async () => {
  const page = new FakePage();
  const session = await EvidenceSession.attach(asPage(page), {
    downloads: { dir: "/tmp/dl" },
  });
  await session.detach();
  await expect(session.waitForDownload(5_000)).rejects.toThrow(/not enabled/);
});

test("downloads: onDownload throwing on a terminal event does NOT wedge the waiter (still resolves)", async () => {
  const page = new FakePage();
  const session = await EvidenceSession.attach(asPage(page), {
    downloads: {
      dir: "/tmp/dl",
      onDownload: () => { throw new Error("callback boom"); },
    },
  });
  const pending = session.waitForDownload(5_000);
  emitDownload(page, "g1", "https://x/a.pdf", "a.pdf");
  // Despite the callback throwing on both inProgress and completed, the waiter resolves.
  await expect(pending).resolves.toMatchObject({ guid: "g1" });
  await session.detach();
});

test("downloads: cross-page events are filtered by owned frameId (no cross-observe)", async () => {
  const page = new FakePage();
  // Make this session's target own only frame "F_MINE".
  page.cdp.sendImpl = (method) => {
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "F_MINE" }, childFrames: [] } };
    }
    return {};
  };
  const session = await EvidenceSession.attach(asPage(page), {
    downloads: { dir: "/tmp/dl" },
  });

  const pending = session.waitForDownload(60);
  // A download from ANOTHER page's frame — must be ignored entirely.
  page.cdp.emit("Browser.downloadWillBegin", {
    guid: "g_other", url: "https://x/other.pdf", suggestedFilename: "other.pdf", frameId: "F_OTHER",
  });
  page.cdp.emit("Browser.downloadProgress", { guid: "g_other", state: "completed" });
  // The wait sees nothing and times out (proves the foreign download didn't satisfy it).
  await expect(pending).rejects.toThrow(/no download completed/);

  // A download from OUR frame resolves a fresh wait.
  const mine = session.waitForDownload(5_000);
  page.cdp.emit("Browser.downloadWillBegin", {
    guid: "g_mine", url: "https://x/mine.pdf", suggestedFilename: "mine.pdf", frameId: "F_MINE",
  });
  page.cdp.emit("Browser.downloadProgress", { guid: "g_mine", state: "completed" });
  await expect(mine).resolves.toMatchObject({ guid: "g_mine" });
  await session.detach();
});

test("downloads: fallback mode (unreadable frame tree) stays OFF even after frameAttached — accepts a foreign-frameId download", async () => {
  const page = new FakePage();
  // Default FakeCDPSession returns {} for Page.getFrameTree → seeding throws →
  // _frameTreeSeeded stays false → filter never engages (fallback: accept all).
  const session = await EvidenceSession.attach(asPage(page), {
    downloads: { dir: "/tmp/dl" },
  });
  // A later iframe attaches (grows _ownedFrames from empty to non-empty). This
  // must NOT flip fallback into a partial filter (codex R2 P2).
  page.cdp.emit("Page.frameAttached", { frameId: "F_LATE" });
  const pending = session.waitForDownload(5_000);
  // A download from a DIFFERENT frame than the attached one — still accepted.
  page.cdp.emit("Browser.downloadWillBegin", {
    guid: "g1", url: "https://x/a.pdf", suggestedFilename: "a.pdf", frameId: "F_SOMETHING_ELSE",
  });
  page.cdp.emit("Browser.downloadProgress", { guid: "g1", state: "completed" });
  await expect(pending).resolves.toMatchObject({ guid: "g1" });
  await session.detach();
});

test("downloads: dynamically-attached frame (iframe) is added to the owned set", async () => {
  const page = new FakePage();
  page.cdp.sendImpl = (method) => {
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "F_MAIN" }, childFrames: [] } };
    }
    return {};
  };
  const session = await EvidenceSession.attach(asPage(page), {
    downloads: { dir: "/tmp/dl" },
  });
  // An iframe attaches after load; a download from it must be accepted.
  page.cdp.emit("Page.frameAttached", { frameId: "F_IFRAME" });
  const pending = session.waitForDownload(5_000);
  page.cdp.emit("Browser.downloadWillBegin", {
    guid: "g1", url: "https://x/embed.pdf", suggestedFilename: "embed.pdf", frameId: "F_IFRAME",
  });
  page.cdp.emit("Browser.downloadProgress", { guid: "g1", state: "completed" });
  await expect(pending).resolves.toMatchObject({ guid: "g1" });
  await session.detach();
});

test("downloads: two concurrent downloads resolve to two separate waitForDownload calls, FIFO", async () => {
  const page = new FakePage();
  const session = await EvidenceSession.attach(asPage(page), {
    downloads: { dir: "/tmp/dl" },
  });

  const first = session.waitForDownload(5_000);
  const second = session.waitForDownload(5_000);

  emitDownload(page, "g1", "https://x/1.pdf", "1.pdf");
  emitDownload(page, "g2", "https://x/2.pdf", "2.pdf");

  await expect(first).resolves.toMatchObject({ guid: "g1" });
  await expect(second).resolves.toMatchObject({ guid: "g2" });
  await session.detach();
});
