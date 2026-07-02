import { test, expect, vi } from "vitest";
import { GlubeanPage } from "./page.js";

/**
 * Semantic locator methods are thin wrappers over `locator(selector)`.
 * We spy on the prototype's `locator` to verify the selector strings
 * without needing to construct a full GlubeanPage instance.
 */

function spyLocator() {
  const fake = {} as any; // returned WrappedLocator (unused)
  const spy = vi
    .spyOn(GlubeanPage.prototype, "locator")
    .mockReturnValue(fake);
  // Create a minimal object that inherits GlubeanPage methods
  const page = Object.create(GlubeanPage.prototype);
  return { page, spy, fake };
}

test("byTestId returns locator with data-testid selector", () => {
  const { page, spy, fake } = spyLocator();
  const result = page.byTestId("submit-btn");
  expect(spy).toHaveBeenCalledWith('[data-testid="submit-btn"]');
  expect(result).toBe(fake);
});

test("byText returns locator with ::-p-text selector", () => {
  const { page, spy, fake } = spyLocator();
  const result = page.byText("Sign in");
  expect(spy).toHaveBeenCalledWith("::-p-text(Sign in)");
  expect(result).toBe(fake);
});

test("byRole with name returns locator with ::-p-aria selector", () => {
  const { page, spy, fake } = spyLocator();
  const result = page.byRole("button", { name: "Submit" });
  expect(spy).toHaveBeenCalledWith('::-p-aria(Submit[role="button"])');
  expect(result).toBe(fake);
});

test("byRole without name returns locator with role attribute selector", () => {
  const { page, spy, fake } = spyLocator();
  const result = page.byRole("navigation");
  expect(spy).toHaveBeenCalledWith('[role="navigation"]');
  expect(result).toBe(fake);
});

test("byLabel returns locator with ::-p-aria selector", () => {
  const { page, spy, fake } = spyLocator();
  const result = page.byLabel("Email address");
  expect(spy).toHaveBeenCalledWith("::-p-aria(Email address)");
  expect(result).toBe(fake);
});

// ── waitForDownload (BT1-M5) ────────────────────────────────────────────

function makePageWithEvidence(evidence: any) {
  const page: any = Object.create(GlubeanPage.prototype);
  const actions: any[] = [];
  page._ctx = { action: (e: any) => actions.push(e) };
  page._evidence = evidence;
  page._actionTimeout = 5_000;
  return { page, actions };
}

test("waitForDownload: throws immediately when no evidence session is attached", async () => {
  const { page } = makePageWithEvidence(null);
  await expect(page.waitForDownload(async () => {})).rejects.toThrow(
    /evidence session not attached/,
  );
});

test("waitForDownload: races the evidence session's waitForDownload against the action, returns the entry", async () => {
  const entry = { guid: "g1", url: "https://x/a.pdf", suggestedFilename: "a.pdf", path: "/tmp/a.pdf" };
  const { page, actions } = makePageWithEvidence({
    waitForDownload: vi.fn().mockResolvedValue(entry),
  });
  let actionRan = false;
  const result = await page.waitForDownload(async () => {
    actionRan = true;
  });
  expect(result).toBe(entry);
  expect(actionRan).toBe(true);
  const ok = actions.find((a) => a.category === "browser:waitForDownload" && a.status === "ok");
  expect(ok).toBeDefined();
  expect(ok.target).toBe("a.pdf");
});

test("waitForDownload: propagates a timeout/cancel error and emits a timeout action", async () => {
  const { page, actions } = makePageWithEvidence({
    waitForDownload: vi.fn().mockRejectedValue(new Error("waitForDownload: no download completed after 10ms")),
  });
  await expect(page.waitForDownload(async () => {})).rejects.toThrow(/no download completed/);
  const timeoutAction = actions.find((a) => a.category === "browser:waitForDownload" && a.status === "timeout");
  expect(timeoutAction).toBeDefined();
});

// ── frame() (BT1-M5) ─────────────────────────────────────────────────

class FakeElementHandle {
  constructor(private readonly frame: unknown | null) {}
  disposed = false;
  async contentFrame(): Promise<unknown | null> {
    return this.frame;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

function makePageForFrame(rawFrame: unknown) {
  const page: any = Object.create(GlubeanPage.prototype);
  const actions: any[] = [];
  const failureShots: string[] = [];
  page._ctx = { action: (e: any) => actions.push(e) };
  page._evidence = { captureShot: async (label: string) => { failureShots.push(label); } };
  page._actionTimeout = 5_000;
  page.raw = {
    waitForSelector: vi.fn().mockResolvedValue(
      rawFrame === undefined ? null : new FakeElementHandle(rawFrame),
    ),
  };
  return { page, actions, failureShots };
}

test("frame: resolves the iframe's content frame and returns a GlubeanFrame", async () => {
  const rawFrame = { url: () => "https://x.example/embed/policy" };
  const { page, actions } = makePageForFrame(rawFrame);

  const result = await page.frame('[data-testid="policy-frame"]');
  expect(result.raw).toBe(rawFrame);
  expect(result.url()).toBe("https://x.example/embed/policy");
  const ok = actions.find((a: any) => a.category === "browser:frame" && a.status === "ok");
  expect(ok).toBeDefined();
});

test("frame: throws a clear error when the selector matches no element", async () => {
  const { page, actions, failureShots } = makePageForFrame(undefined);
  page.raw.waitForSelector = vi.fn().mockResolvedValue(null);

  await expect(page.frame('[data-testid="missing"]')).rejects.toThrow(/element not found/);
  const timeoutAction = actions.find((a: any) => a.category === "browser:frame" && a.status === "timeout");
  expect(timeoutAction).toBeDefined();
  expect(failureShots).toContain('frame-[data-testid="missing"]');
});

test("frame: throws a clear error when the element is not an <iframe>", async () => {
  const { page } = makePageForFrame(null);
  await expect(page.frame('[data-testid="not-an-iframe"]')).rejects.toThrow(
    /not an <iframe>/,
  );
});
