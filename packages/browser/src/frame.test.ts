import { test, expect, vi } from "vitest";
import { createFrame, GlubeanFrame } from "./frame.js";
import type { LocatorContext } from "./locator.js";

// ── Fakes ─────────────────────────────────────────────────────────────

class FakeHandle {
  disposed = false;
  constructor(private readonly result: unknown) {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async evaluate(fn: (el: any) => any): Promise<any> {
    return fn(this.result);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

class FakeFrame {
  frameUrl = "https://x.example/embed/policy";
  $handles = new Map<string, unknown>();
  $evalResults = new Map<string, unknown[]>();

  url(): string {
    return this.frameUrl;
  }
  async $(selector: string): Promise<FakeHandle | null> {
    return this.$handles.has(selector) ? new FakeHandle(this.$handles.get(selector)) : null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async $eval(selector: string, _fn: any): Promise<any> {
    const queue = this.$evalResults.get(selector);
    if (!queue || queue.length === 0) throw new Error(`no $eval result queued for ${selector}`);
    return queue.length > 1 ? queue.shift() : queue[0];
  }
  locator(): unknown {
    throw new Error("not used in these tests — see spyLocator()");
  }
}

function makeCtx(): LocatorContext & {
  actions: Array<{ category: string; target: string; status: string; detail?: unknown }>;
  failureLabels: string[];
} {
  const actions: Array<{ category: string; target: string; status: string; detail?: unknown }> = [];
  const failureLabels: string[] = [];
  return {
    actions,
    failureLabels,
    action: (e) => actions.push(e),
    captureStep: async () => {},
    captureFailure: async (label) => {
      failureLabels.push(label);
    },
  };
}

function spyLocator() {
  const fake = {} as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const spy = vi.spyOn(GlubeanFrame.prototype, "locator").mockReturnValue(fake);
  return { spy, fake };
}

// ── construction ─────────────────────────────────────────────────────

test("createFrame: wraps the raw Frame and exposes url()", () => {
  const raw = new FakeFrame();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const frame = createFrame(raw as any, makeCtx(), 5_000);
  expect(frame.raw).toBe(raw);
  expect(frame.url()).toBe("https://x.example/embed/policy");
});

// ── byX selector builders (mirrors page.test.ts's spyLocator pattern) ──

test("byTestId returns locator with data-testid selector", () => {
  const raw = new FakeFrame();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const frame = createFrame(raw as any, makeCtx(), 5_000);
  const { spy, fake } = spyLocator();
  const result = frame.byTestId("policy-heading");
  expect(spy).toHaveBeenCalledWith('[data-testid="policy-heading"]');
  expect(result).toBe(fake);
});

test("byText returns locator with ::-p-text selector", () => {
  const raw = new FakeFrame();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const frame = createFrame(raw as any, makeCtx(), 5_000);
  const { spy, fake } = spyLocator();
  const result = frame.byText("Return Policy");
  expect(spy).toHaveBeenCalledWith("::-p-text(Return Policy)");
  expect(result).toBe(fake);
});

test("byRole with name returns locator with ::-p-aria selector", () => {
  const raw = new FakeFrame();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const frame = createFrame(raw as any, makeCtx(), 5_000);
  const { spy, fake } = spyLocator();
  const result = frame.byRole("heading", { name: "Return Policy" });
  expect(spy).toHaveBeenCalledWith('::-p-aria(Return Policy[role="heading"])');
  expect(result).toBe(fake);
});

test("byRole without name returns locator with role attribute selector", () => {
  const raw = new FakeFrame();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const frame = createFrame(raw as any, makeCtx(), 5_000);
  const { spy } = spyLocator();
  frame.byRole("navigation");
  expect(spy).toHaveBeenCalledWith('[role="navigation"]');
});

test("byLabel returns locator with ::-p-aria selector", () => {
  const raw = new FakeFrame();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const frame = createFrame(raw as any, makeCtx(), 5_000);
  const { spy } = spyLocator();
  frame.byLabel("Close");
  expect(spy).toHaveBeenCalledWith("::-p-aria(Close)");
});

// ── click / fill / type / hover — delegate to locator() with the right timeout ──

test("click delegates to locator(selector).setTimeout(actionTimeout).click()", async () => {
  const raw = new FakeFrame();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const frame = createFrame(raw as any, makeCtx(), 7_000);
  const clickFn = vi.fn().mockResolvedValue(undefined);
  const setTimeoutFn = vi.fn().mockReturnValue({ click: clickFn });
  vi.spyOn(GlubeanFrame.prototype, "locator").mockReturnValue({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setTimeout: setTimeoutFn,
  } as any);

  await frame.click('[data-testid="ok"]');
  expect(setTimeoutFn).toHaveBeenCalledWith(7_000);
  expect(clickFn).toHaveBeenCalled();
});

test("fill honors a per-call timeout override", async () => {
  const raw = new FakeFrame();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const frame = createFrame(raw as any, makeCtx(), 7_000);
  const fillFn = vi.fn().mockResolvedValue(undefined);
  const setTimeoutFn = vi.fn().mockReturnValue({ fill: fillFn });
  vi.spyOn(GlubeanFrame.prototype, "locator").mockReturnValue({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setTimeout: setTimeoutFn,
  } as any);

  await frame.fill('[data-testid="email"]', "a@b.com", { timeout: 1_234 });
  expect(setTimeoutFn).toHaveBeenCalledWith(1_234);
  expect(fillFn).toHaveBeenCalledWith("a@b.com");
});

// ── isVisible / expectVisible / expectHidden ────────────────────────────

test("isVisible: false when no element matches", async () => {
  const raw = new FakeFrame();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const frame = createFrame(raw as any, makeCtx(), 5_000);
  expect(await frame.isVisible('[data-testid="missing"]')).toBe(false);
});

test("expectVisible: resolves once isVisible turns true, emits an ok action", async () => {
  const raw = new FakeFrame();
  const ctx = makeCtx();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const frame = createFrame(raw as any, ctx, 5_000);

  let calls = 0;
  vi.spyOn(frame, "isVisible").mockImplementation(async () => {
    calls++;
    return calls >= 2; // false first poll, true second poll
  });

  await frame.expectVisible('[data-testid="badge"]', { timeout: 2_000 });
  expect(calls).toBeGreaterThanOrEqual(2);
  const ok = ctx.actions.find((a) => a.category === "browser:assert" && a.status === "ok");
  expect(ok).toBeDefined();
});

test("expectHidden: times out with a clear error and captures a failure screenshot", async () => {
  const raw = new FakeFrame();
  const ctx = makeCtx();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const frame = createFrame(raw as any, ctx, 5_000);
  vi.spyOn(frame, "isVisible").mockResolvedValue(true); // never becomes hidden

  await expect(frame.expectHidden('[data-testid="modal"]', { timeout: 50 })).rejects.toThrow(
    /was still visible/,
  );
  expect(ctx.failureLabels).toContain('expectHidden("[data-testid="modal"]")');
  const timeoutAction = ctx.actions.find((a) => a.status === "timeout");
  expect(timeoutAction).toBeDefined();
});

// ── expectText ───────────────────────────────────────────────────────

test("expectText: matches via includes (normalized) by default", async () => {
  const raw = new FakeFrame();
  raw.$evalResults.set("body", ["  Return   Policy for widgets  "]);
  const ctx = makeCtx();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const frame = createFrame(raw as any, ctx, 5_000);

  await frame.expectText("body", "Return Policy");
  const ok = ctx.actions.find((a) => a.category === "browser:assert" && a.status === "ok");
  expect(ok).toBeDefined();
});

test("expectText: exact + ignoreCase", async () => {
  const raw = new FakeFrame();
  raw.$evalResults.set("h1", ["return policy"]);
  const ctx = makeCtx();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const frame = createFrame(raw as any, ctx, 5_000);

  await frame.expectText("h1", "Return Policy", { exact: true, ignoreCase: true });
  const ok = ctx.actions.find((a) => a.category === "browser:assert" && a.status === "ok");
  expect(ok).toBeDefined();
});

test("expectText: RegExp match", async () => {
  const raw = new FakeFrame();
  raw.$evalResults.set("p", ["order #12345"]);
  const ctx = makeCtx();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const frame = createFrame(raw as any, ctx, 5_000);

  await frame.expectText("p", /order #\d+/);
  const ok = ctx.actions.find((a) => a.category === "browser:assert" && a.status === "ok");
  expect(ok).toBeDefined();
});

test("expectText: throws a descriptive error on timeout", async () => {
  const raw = new FakeFrame();
  raw.$evalResults.set("body", ["nope"]);
  const ctx = makeCtx();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const frame = createFrame(raw as any, ctx, 5_000);

  await expect(frame.expectText("body", "Return Policy", { timeout: 50 })).rejects.toThrow(
    /expected "Return Policy"/,
  );
});
