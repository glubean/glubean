import { test, expect } from "vitest";
import {
  createWrappedLocator,
  resolveNthHandle,
  type LocatorContext,
} from "./locator.js";

// ── Fakes ─────────────────────────────────────────────────────────────

/**
 * A fake ElementHandle that also stands in for the DOM element passed into
 * `handle.evaluate(fn)` (mirrors the real Puppeteer contract closely enough
 * for `nth().fill()`'s clear-then-type implementation).
 */
class FakeHandle {
  clicked = false;
  hovered = false;
  typed: string[] = [];
  disposed = false;
  value = "";
  dispatched: string[] = [];

  constructor(public readonly tag: string) {}

  async click(): Promise<void> {
    this.clicked = true;
  }
  async hover(): Promise<void> {
    this.hovered = true;
  }
  async type(text: string): Promise<void> {
    this.typed.push(text);
  }
  dispatchEvent(ev: { type: string }): void {
    this.dispatched.push(ev.type);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async evaluate(fn: (el: any, ...args: any[]) => any, ...args: any[]): Promise<any> {
    return fn(this, ...args);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

class FakeJsHandle {
  disposed = false;
  constructor(private readonly el: FakeHandle | null) {}
  asElement(): FakeHandle | null {
    return this.el;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

class FakePage {
  /** Elements "present" for `evaluateHandle`-based nth() resolution. */
  elements: (FakeHandle | undefined)[] = [];
  /** Elements returned by `$$` for `count()`. */
  queryAllResult: unknown[] = [];
  evaluateHandleCalls: Array<{ selector: string; index: number }> = [];

  async $$(_selector: string): Promise<unknown[]> {
    return this.queryAllResult;
  }

  async evaluateHandle(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _fn: (...args: any[]) => unknown,
    selector: string,
    index: number,
  ): Promise<FakeJsHandle> {
    this.evaluateHandleCalls.push({ selector, index });
    return new FakeJsHandle(this.elements[index] ?? null);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asPage = (p: FakePage): any => p;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeInner = {} as any;

function makeCtx(): LocatorContext & {
  actions: Array<{ category: string; target: string; status: string; detail?: unknown }>;
  stepLabels: string[];
  failureLabels: string[];
} {
  const actions: Array<{ category: string; target: string; status: string; detail?: unknown }> = [];
  const stepLabels: string[] = [];
  const failureLabels: string[] = [];
  return {
    actions,
    stepLabels,
    failureLabels,
    action: (e) => actions.push(e),
    captureStep: async (label) => {
      stepLabels.push(label);
    },
    captureFailure: async (label) => {
      failureLabels.push(label);
    },
  };
}

// ── resolveNthHandle ─────────────────────────────────────────────────

test("resolveNthHandle: resolves immediately when the element is present", async () => {
  const page = new FakePage();
  const el = new FakeHandle("button");
  page.elements = [undefined, el];
  const handle = await resolveNthHandle(asPage(page), "[data-x]", 1, 1000);
  expect(handle).toBe(el);
  expect(page.evaluateHandleCalls[0]).toEqual({ selector: "[data-x]", index: 1 });
});

test("resolveNthHandle: polls until the element appears", async () => {
  const page = new FakePage();
  page.elements = [];
  setTimeout(() => {
    page.elements = [new FakeHandle("button")];
  }, 150);
  const handle = await resolveNthHandle(asPage(page), "[data-x]", 0, 2000);
  expect(handle).toBeInstanceOf(FakeHandle);
  expect(page.evaluateHandleCalls.length).toBeGreaterThan(1);
});

test("resolveNthHandle: throws a clear error after timeout", async () => {
  const page = new FakePage();
  page.elements = [];
  await expect(resolveNthHandle(asPage(page), "[data-x]", 2, 150)).rejects.toThrow(
    'nth(2): no element matched "[data-x]" at index 2 after 150ms',
  );
});

// ── WrappedLocator.count() ──────────────────────────────────────────

test("count(): returns the immediate $$ match length, no polling", async () => {
  const page = new FakePage();
  page.queryAllResult = [1, 2, 3];
  const ctx = makeCtx();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped = createWrappedLocator(fakeInner, ctx, "[data-testid=x]", asPage(page)) as any;
  await expect(wrapped.count()).resolves.toBe(3);
  // count() is a pure read — no action/screenshot side effects.
  expect(ctx.actions).toHaveLength(0);
});

test("count(): reflects zero matches", async () => {
  const page = new FakePage();
  page.queryAllResult = [];
  const ctx = makeCtx();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped = createWrappedLocator(fakeInner, ctx, "[data-testid=x]", asPage(page)) as any;
  await expect(wrapped.count()).resolves.toBe(0);
});

// ── WrappedLocator.nth() ─────────────────────────────────────────────

test("nth().click(): resolves the Nth element, clicks, disposes, and traces ok", async () => {
  const page = new FakePage();
  const el = new FakeHandle("button");
  page.elements = [new FakeHandle("first"), el];
  const ctx = makeCtx();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped = createWrappedLocator(fakeInner, ctx, "[data-testid=add]", asPage(page)) as any;

  await wrapped.nth(1).click();

  expect(el.clicked).toBe(true);
  expect(el.disposed).toBe(true);
  expect(ctx.actions).toHaveLength(1);
  expect(ctx.actions[0]).toMatchObject({
    category: "browser:click",
    target: "[data-testid=add] >> nth=1",
    status: "ok",
    detail: undefined,
  });
  expect(ctx.stepLabels).toEqual(["click-[data-testid=add] >> nth=1"]);
});

test("nth().click(): out-of-range index times out and captures a failure screenshot", async () => {
  const page = new FakePage();
  page.elements = [];
  const ctx = makeCtx();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped = createWrappedLocator(fakeInner, ctx, "[data-testid=add]", asPage(page)) as any;

  await expect(wrapped.nth(5, { timeout: 150 }).click()).rejects.toThrow("nth(5)");
  expect(ctx.actions[0]).toMatchObject({
    category: "browser:click",
    target: "[data-testid=add] >> nth=5",
    status: "timeout",
  });
  expect(ctx.failureLabels).toEqual(["click-[data-testid=add] >> nth=5"]);
});

test("nth().fill(): clears the value, dispatches input, then types", async () => {
  const page = new FakePage();
  const el = new FakeHandle("input");
  el.value = "old";
  page.elements = [el];
  const ctx = makeCtx();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped = createWrappedLocator(fakeInner, ctx, "input", asPage(page)) as any;

  await wrapped.nth(0).fill("new value");

  expect(el.value).toBe("");
  expect(el.dispatched).toContain("input");
  expect(el.typed).toEqual(["new value"]);
  expect(ctx.actions[0]).toMatchObject({
    category: "browser:fill",
    status: "ok",
    detail: { textLength: 9 },
  });
});

test("nth().type(): types without clearing the existing value", async () => {
  const page = new FakePage();
  const el = new FakeHandle("input");
  el.value = "existing";
  page.elements = [el];
  const ctx = makeCtx();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped = createWrappedLocator(fakeInner, ctx, "input", asPage(page)) as any;

  await wrapped.nth(0).type("more");

  expect(el.value).toBe("existing");
  expect(el.typed).toEqual(["more"]);
});

test("nth().hover(): hovers the Nth element", async () => {
  const page = new FakePage();
  const el = new FakeHandle("card");
  page.elements = [el];
  const ctx = makeCtx();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped = createWrappedLocator(fakeInner, ctx, ".card", asPage(page)) as any;

  await wrapped.nth(0).hover();
  expect(el.hovered).toBe(true);
});

test("nth().waitHandle(): returns the raw handle without disposing it", async () => {
  const page = new FakePage();
  const el = new FakeHandle("button");
  page.elements = [el];
  const ctx = makeCtx();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped = createWrappedLocator(fakeInner, ctx, "button", asPage(page)) as any;

  const handle = await wrapped.nth(0).waitHandle();
  expect(handle).toBe(el);
  expect(el.disposed).toBe(false);
});

test("nth(): default timeout is used when options are omitted", async () => {
  const page = new FakePage();
  page.elements = [];
  const ctx = makeCtx();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped = createWrappedLocator(fakeInner, ctx, "x", asPage(page)) as any;
  // Poke at the returned IndexedLocator's behavior indirectly: a present
  // element still resolves instantly regardless of the (large) default timeout.
  page.elements = [new FakeHandle("x")];
  const handle = await wrapped.nth(0).waitHandle();
  expect(handle).toBeInstanceOf(FakeHandle);
});
