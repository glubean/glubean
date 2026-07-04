/**
 * BT1-M3 "screenshots into the timeline" — CONTRACT tests.
 *
 * These lock the wire contract the Cloud (`app-next`) depends on to stitch a
 * screenshot next to the action that triggered it. They are deliberately
 * end-to-end through the REAL `GlubeanPage._create` shoot delegate (not the
 * `EvidenceSession.captureShot` policy fakes in `evidence.test.ts`) because the
 * delegate — which builds the `browser:screenshot` event's `data` and the
 * on-disk screenshot path — IS the browser half of the join contract.
 *
 * The Cloud join (verified 2026-07-04 against `cloud`):
 *   - `apps/app-next/.../screenshot-artifacts.ts#matchScreenshotArtifact` joins
 *     the event's `data.path` to the uploaded artifact by its trailing
 *     `<testId>/<file>` segments — the artifact carries NO stepIndex on the
 *     inline upload path and its `testId` is back-filled from the file name
 *     (`platform-api/.../run.routes.ts#testIdFromScreenshotName`,
 *     regex `^screenshots/(.+)/[^/]+$`).
 *   - `apps/app-next/.../event-timeline.tsx#ScreenshotEventItem` reads
 *     `data.path` / `data.label` / `data.trigger` and renders the shot inline
 *     in event-stream order (so timeline placement is stream order, not an
 *     index field).
 *
 * Therefore the contract that MUST NOT silently break is:
 *   1. the event type is exactly `browser:screenshot`;
 *   2. `data` carries `{ path, label, trigger, fullPage }`;
 *   3. `path` ends in `screenshots/<sanitizedTestId>/<file>` so the Cloud's
 *      trailing-segment join and the `screenshots/<testId>/<file>` upload
 *      naming convention both resolve;
 *   4. a failure capture prefixes the file with `FAIL-` and sets
 *      `trigger: "failure"`;
 *   5. the screenshot event is emitted in stream order relative to the action
 *      that triggered it (a real action emits its `action` event, then its
 *      post-step `browser:screenshot`).
 */
import { test, expect, vi, beforeEach } from "vitest";
import { mkdir } from "node:fs/promises";

// The shoot delegate's legacy fallback (taken whenever `ctx.saveArtifact` is
// absent — which is every current SDK, incl. 0.9.x) calls
// `mkdir(..., { recursive: true })` before writing the file. Stub it so the
// contract tests touch no real filesystem.
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import { GlubeanPage, type BrowserTestContext, type InstrumentedPage } from "./page.js";

// ── Fakes ─────────────────────────────────────────────────────────────

type AnyFn = (...args: unknown[]) => unknown;

/** Minimal CDP session — accepts every send and records nothing we assert on. */
class FakeCDPSession {
  async send(): Promise<unknown> {
    return {};
  }
  on(): this {
    return this;
  }
  off(): this {
    return this;
  }
  async detach(): Promise<void> {}
}

/** Minimal puppeteer Page surface `GlubeanPage._create` + `EvidenceSession.attach` touch. */
class FakePage {
  private readonly _cdp = new FakeCDPSession();
  /** Args of every `screenshot()` call — the legacy fallback passes `{ path, fullPage }`. */
  screenshotCalls: Array<Record<string, unknown>> = [];

  async createCDPSession(): Promise<FakeCDPSession> {
    return this._cdp;
  }
  on(_event: string, _fn: AnyFn): this {
    return this;
  }
  url(): string {
    return "https://shop.example/checkout";
  }
  async goto(): Promise<{ status: () => number }> {
    return { status: () => 200 };
  }
  async screenshot(opts: Record<string, unknown>): Promise<Uint8Array> {
    this.screenshotCalls.push(opts);
    return new Uint8Array();
  }
  async evaluateOnNewDocument(): Promise<void> {}
}

/** A recording BrowserTestContext. By default it omits `saveArtifact` —
 *  forcing the legacy file-path shoot branch, the one every shipped SDK
 *  (incl. 0.9.x) actually takes and the one the Cloud's `data.path` join
 *  depends on. Pass `saveArtifact: true` to exercise the OTHER branch
 *  (a hypothetical SDK ≥ 0.13 with `ctx.saveArtifact`) so both are pinned. */
function makeCtx(opts: { saveArtifact?: boolean } = {}): {
  ctx: BrowserTestContext;
  events: Array<{ type: string; data: Record<string, unknown> }>;
  actions: unknown[];
  /** Unified action+event call order — proves stream-order timeline placement. */
  order: string[];
  savedArtifacts: Array<{ name: string; type?: string; mimeType?: string }>;
} {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const actions: unknown[] = [];
  const order: string[] = [];
  const savedArtifacts: Array<{ name: string; type?: string; mimeType?: string }> = [];
  const ctx: BrowserTestContext = {
    action: (a) => {
      actions.push(a);
      order.push(`action:${a.category}`);
    },
    event: (ev) => {
      events.push(ev);
      order.push(`event:${ev.type}`);
    },
    trace: () => {},
    metric: () => {},
    log: () => {},
    warn: () => {},
  };
  if (opts.saveArtifact) {
    let n = 0;
    ctx.saveArtifact = async (name, _content, o) => {
      savedArtifacts.push({ name, type: o?.type, mimeType: o?.mimeType });
      return `art-${++n}`;
    };
  }
  return { ctx, events, actions, order, savedArtifacts };
}

async function makeInstrumentedPage(
  testId: string,
  options: Record<string, unknown> = {},
  ctxOpts: { saveArtifact?: boolean } = {},
): Promise<{
  page: InstrumentedPage;
  events: Array<{ type: string; data: Record<string, unknown> }>;
  actions: unknown[];
  order: string[];
  savedArtifacts: Array<{ name: string; type?: string; mimeType?: string }>;
  fake: FakePage;
}> {
  const fake = new FakePage();
  const { ctx, events, actions, order, savedArtifacts } = makeCtx(ctxOpts);
  const page = await GlubeanPage._create(
    fake as unknown as import("puppeteer-core").Page,
    "https://shop.example",
    ctx,
    options as never,
    testId,
  );
  return { page, events, actions, order, savedArtifacts, fake };
}

/** Pull the single `browser:screenshot` event's inner `data` payload. */
function screenshotEvents(
  events: Array<{ type: string; data: Record<string, unknown> }>,
): Array<Record<string, unknown>> {
  return events.filter((e) => e.type === "browser:screenshot").map((e) => e.data);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Contract 1+2+3: manual capture → browser:screenshot event shape + path ──

test("captureScreenshot emits a browser:screenshot event with the Cloud-join data shape", async () => {
  const { page, events } = await makeInstrumentedPage("checkout-flow");
  await page.captureScreenshot("cart-loaded");

  const shots = screenshotEvents(events);
  expect(shots).toHaveLength(1);
  const data = shots[0]!;

  // (2) the exact fields event-timeline.tsx#ScreenshotEventItem reads.
  expect(Object.keys(data).sort()).toEqual(["fullPage", "label", "path", "trigger"]);
  expect(data.label).toBe("cart-loaded");
  expect(data.trigger).toBe("manual");
  expect(data.fullPage).toBe(true);
  expect(typeof data.path).toBe("string");
});

test("the event path ends in screenshots/<testId>/<file> so the Cloud trailing-segment join resolves", async () => {
  const { page, events } = await makeInstrumentedPage("checkout-flow");
  await page.captureScreenshot("cart-loaded");

  const path = screenshotEvents(events)[0]!.path as string;
  // matchScreenshotArtifact splits on `/`|`\` and matches the last two segments
  // (`<testId>/<file>`) against the uploaded artifact name `screenshots/<testId>/<file>`.
  const segs = path.split(/[\\/]/).filter(Boolean);
  const [dir, file] = segs.slice(-2);
  expect(dir).toBe("checkout-flow");
  expect(file).toMatch(/^\d{3}-cart-loaded-.*\.png$/);
  // The `screenshots` segment must sit immediately above <testId> — that's the
  // prefix testIdFromScreenshotName() and the ART1 upload naming both key off.
  expect(segs[segs.length - 3]).toBe("screenshots");
});

test("a testId with path-unsafe characters is sanitized into the dir segment (matches the back-filled artifact testId)", async () => {
  // The runner sanitizes `api/login` → dir `api_login`; the Cloud back-fills the
  // artifact testId from that SAME dir, so the browser side must produce it.
  const { page, events } = await makeInstrumentedPage("api/login");
  await page.captureScreenshot("after");

  const path = screenshotEvents(events)[0]!.path as string;
  const segs = path.split(/[\\/]/).filter(Boolean);
  expect(segs.slice(-2)[0]).toBe("api_login");
  expect(segs.slice(-2)[0]).not.toContain("/");
});

// ── Contract 4: failure capture → FAIL- prefix + trigger:"failure" ──

test("screenshotOnFailure emits trigger:'failure' and a FAIL- prefixed file (Cloud renders it red)", async () => {
  const { page, events } = await makeInstrumentedPage("checkout-flow");
  await page.screenshotOnFailure();

  const shots = screenshotEvents(events);
  expect(shots).toHaveLength(1);
  expect(shots[0]!.trigger).toBe("failure");
  const path = shots[0]!.path as string;
  const file = path.split(/[\\/]/).filter(Boolean).pop()!;
  expect(file).toMatch(/^FAIL-\d{3}-final-.*\.png$/);
});

// ── Contract 5: stream-order emission (screenshot follows its action) ──

test("a real action emits its action BEFORE the post-step screenshot (stream order = timeline placement)", async () => {
  // every-step so the post-action capture fires without a failure; metrics off
  // to keep the goto step's emissions to just the action + the screenshot.
  const { page, events, order } = await makeInstrumentedPage("checkout-flow", {
    screenshot: "every-step",
    metrics: false,
  });
  await page.goto("/checkout");

  // The Cloud places the shot by event-stream order, so the browser:screenshot
  // for a step MUST come AFTER that step's own action, never before.
  const actionIdx = order.indexOf("action:browser:goto");
  const shotIdx = order.indexOf("event:browser:screenshot");
  expect(actionIdx).toBeGreaterThanOrEqual(0);
  // Strict adjacency (metrics off ⇒ no intervening emission): the step's
  // screenshot is the very next timeline entry after its action, so the Cloud
  // stitches it directly beside that action — not merely somewhere after it.
  expect(shotIdx).toBe(actionIdx + 1);
  expect(screenshotEvents(events)[0]!.trigger).toBe("step");
});

// ── Guard: the legacy file-path branch is the one under contract ──

test("the shoot delegate writes via page.screenshot({ path, fullPage }) — the file that gets uploaded as the artifact", async () => {
  const { page, fake, events } = await makeInstrumentedPage("checkout-flow");
  await page.captureScreenshot("cart-loaded");

  // Exactly one screenshot() call, full-page, to the SAME path the event carries
  // (so the event↔artifact join key and the uploaded bytes are the same file).
  expect(fake.screenshotCalls).toHaveLength(1);
  const call = fake.screenshotCalls[0]!;
  expect(call.fullPage).toBe(true);
  const eventPath = screenshotEvents(events)[0]!.path as string;
  expect(call.path).toBe(eventPath);

  // The screenshot's parent dir MUST be created first — the CLI can't upload a
  // file that was never written. Guards against a refactor dropping _ensureDir.
  const dir = eventPath.slice(0, eventPath.lastIndexOf("/"));
  expect(vi.mocked(mkdir)).toHaveBeenCalledWith(dir, { recursive: true });
});

// ── saveArtifact branch (SDK ≥ 0.13): pin its shape so a refactor can't
//    silently diverge from what a future Cloud artifactId-join would read.
//    NB: no shipped SDK provides ctx.saveArtifact yet and the Cloud today joins
//    only by data.path (screenshot-artifacts.ts), so this branch is dormant —
//    pinned here purely to prevent an unnoticed drift, not because it's live. ──

test("when ctx.saveArtifact exists, the event carries artifactId (not path) and the artifact is saved as a screenshot", async () => {
  const { page, events, savedArtifacts } = await makeInstrumentedPage(
    "checkout-flow",
    {},
    { saveArtifact: true },
  );
  await page.captureScreenshot("cart-loaded");

  const data = screenshotEvents(events)[0]!;
  expect(Object.keys(data).sort()).toEqual(["artifactId", "fullPage", "label", "trigger"]);
  expect(data.artifactId).toBe("art-1");
  expect(data.path).toBeUndefined();
  expect(data.label).toBe("cart-loaded");
  expect(data.trigger).toBe("manual");

  // The bytes are saved under the FAIL-/NNN-label naming with a screenshot type.
  expect(savedArtifacts).toHaveLength(1);
  expect(savedArtifacts[0]!.name).toMatch(/^\d{3}-cart-loaded-.*\.png$/);
  expect(savedArtifacts[0]!.type).toBe("screenshot");
  expect(savedArtifacts[0]!.mimeType).toBe("image/png");
});
