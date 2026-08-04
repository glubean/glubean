/**
 * Tests for the built-in browser contract adapter (Mode A minimal — GLU-212).
 *
 * Scope: project / normalize, executeCase judging (url / dom / calls /
 * console → soft ctx.assert), unimplemented-case skip, the raw execute path,
 * executeCaseInFlow, verify hook, and the factory + plugin wiring.
 *
 * Uses a fake GlubeanBrowser whose page emits canned network traces + console
 * errors and answers dom checks from config — no real Chrome. The fake ctx
 * mirrors the runner's SOFT assert (records `passed`, never throws) so a run
 * judges ALL expects and we can inspect every verdict.
 */

import { beforeAll, describe, expect, expectTypeOf, test } from "vitest";
import { contract, installPlugin } from "@glubean/sdk";
import type { ContractCaseRef, TestContext } from "@glubean/sdk";
import browserPlugin, { browserAdapter, defineBrowserCase } from "../index.js";
import type {
  BrowserContractCase,
  BrowserContractRoot,
  BrowserContractSpec,
  BrowserEvidence,
  BrowserTraceRecord,
} from "./types.js";
import type { BrowserTestContext, GlubeanBrowser, InstrumentedPage } from "../page.js";
import type { ExtensionPage } from "../chrome-extension/page.js";

beforeAll(async () => {
  await installPlugin(browserPlugin);
});

// ---------------------------------------------------------------------------
// Fake ctx — SOFT assert (records, does not throw); fail/skip throw.
// ---------------------------------------------------------------------------

class SkipSignal extends Error {}
class FailSignal extends Error {}

interface CtxLog {
  assertions: Array<{ passed: boolean; message?: string }>;
  warns: Array<{ condition: boolean; message: string }>;
  traces: unknown[];
  events: Array<{ type: string; data: Record<string, unknown> }>;
}

function makeCtx(secrets: Record<string, string> = {}): { ctx: TestContext; log: CtxLog } {
  const log: CtxLog = { assertions: [], warns: [], traces: [], events: [] };
  const ctx = {
    vars: { get: () => undefined, require: () => "", all: () => ({}) },
    secrets: {
      get: (k: string) => secrets[k],
      require: (k: string) => {
        if (!(k in secrets)) throw new Error(`missing secret ${k}`);
        return secrets[k];
      },
    },
    session: { get: () => undefined, require: () => undefined, set: () => {}, entries: () => ({}) },
    http: {},
    log: () => {},
    assert: (arg1: unknown, message?: string) => {
      // Mirror the runner's two overloads: boolean or a { passed } result.
      const passed =
        typeof arg1 === "boolean" ? arg1 : Boolean((arg1 as { passed?: unknown } | null)?.passed);
      log.assertions.push({ passed, message });
    },
    warn: (condition: boolean, message: string) => {
      log.warns.push({ condition, message });
    },
    validate: (data: unknown) => data,
    trace: (t: unknown) => log.traces.push(t),
    action: () => {},
    event: (ev: { type: string; data: Record<string, unknown> }) => log.events.push(ev),
    metric: () => {},
    skip: (reason?: string): never => {
      throw new SkipSignal(reason);
    },
    fail: (message: string): never => {
      log.assertions.push({ passed: false, message });
      throw new FailSignal(message);
    },
    expect: (v: unknown) => ({ toBe: () => {}, toEqual: () => {}, toMatchObject: () => {}, __v: v }),
  } as unknown as TestContext;
  return { ctx, log };
}

// ---------------------------------------------------------------------------
// Fake browser / page
// ---------------------------------------------------------------------------

interface FakePageConfig {
  finalUrl: string;
  /** Selectors that resolve to a visible element. */
  visible?: string[];
  /**
   * Selectors present in the DOM (matches ≥ 1), whether visible or not. Defaults
   * to `visible`. Used to model "hidden but present" for dom.absent tests.
   */
  present?: string[];
  /** selector → element text (for expectText / containsText). */
  texts?: Record<string, string>;
  /** Network traces emitted on goto (simulating page-load requests). */
  traces?: BrowserTraceRecord[];
  /** Console errors emitted on goto. */
  consoleErrors?: Array<{ message: string; source?: string }>;
  /** Uncaught page exceptions (browser:uncaught-error) emitted on goto. */
  uncaughtErrors?: Array<{ message: string }>;
  /**
   * When set, `raw.waitForNetworkIdle` exists (real-page behaviour) and these
   * traces are emitted asynchronously AFTER goto — simulating the CDP
   * getResponseBody lag that lands a trace after network idle.
   */
  lateTraces?: BrowserTraceRecord[];
}

interface FakePage {
  page: InstrumentedPage;
  expectVisibleCalls: string[];
  captureScreenshotLabels: string[];
  closed: boolean;
}

function makeFakeBrowser(config: FakePageConfig): {
  browser: GlubeanBrowser;
  last: () => FakePage | undefined;
  lastCtx: () => BrowserTestContext | undefined;
} {
  let last: FakePage | undefined;
  let lastCtx: BrowserTestContext | undefined;
  const browser = {
    newPage: async (ctx: BrowserTestContext): Promise<InstrumentedPage> => {
      lastCtx = ctx;
      const visible = new Set(config.visible ?? []);
      const present = new Set(config.present ?? config.visible ?? []);
      const rec: FakePage = {
        page: undefined as unknown as InstrumentedPage,
        expectVisibleCalls: [],
        captureScreenshotLabels: [],
        closed: false,
      };
      const emitTrace = (t: BrowserTraceRecord) =>
        ctx.trace({
          name: `${t.method} ${t.url}`,
          method: t.method,
          url: t.url,
          status: t.status,
          duration: t.durationMs,
          durationMs: t.durationMs,
          requestBody: t.requestBody,
          responseBody: t.responseBody,
        } as unknown as Parameters<BrowserTestContext["trace"]>[0]);
      const page = {
        // With lateTraces, expose waitForNetworkIdle (real-page behaviour) so
        // settleNetwork's trace-flush wait engages; otherwise settle is a no-op.
        raw: config.lateTraces
          ? { waitForNetworkIdle: async () => {} }
          : {},
        goto: async (_url: string) => {
          for (const t of config.traces ?? []) emitTrace(t);
          for (const c of config.consoleErrors ?? []) {
            ctx.event({ type: "browser:console-error", data: { message: c.message, source: c.source } });
          }
          for (const u of config.uncaughtErrors ?? []) {
            ctx.event({ type: "browser:uncaught-error", data: { message: u.message } });
          }
          // Late traces land AFTER idle (async getResponseBody lag).
          for (const [i, t] of (config.lateTraces ?? []).entries()) {
            setTimeout(() => emitTrace(t), 30 * (i + 1));
          }
        },
        url: () => config.finalUrl,
        expectVisible: async (sel: string) => {
          rec.expectVisibleCalls.push(sel);
          if (!visible.has(sel)) throw new Error(`not visible: ${sel}`);
        },
        expectHidden: async (sel: string) => {
          if (visible.has(sel)) throw new Error(`still present: ${sel}`);
        },
        expectCount: async (sel: string, expected: number) => {
          const actual = present.has(sel) ? 1 : 0;
          if (actual !== expected) throw new Error(`count ${actual} !== ${expected} for ${sel}`);
        },
        expectText: async (sel: string, text: string) => {
          const t = config.texts?.[sel] ?? "";
          if (!t.includes(text)) throw new Error(`text mismatch for ${sel}`);
        },
        captureScreenshot: async (label: string) => {
          rec.captureScreenshotLabels.push(label);
        },
        screenshotOnFailure: async () => {},
        close: async () => {
          rec.closed = true;
        },
      };
      rec.page = page as unknown as InstrumentedPage;
      last = rec;
      return rec.page;
    },
    close: async () => {},
    disconnect: async () => {},
  } as unknown as GlubeanBrowser;
  return { browser, last: () => last, lastCtx: () => lastCtx };
}

function httpRef(endpoint: string, status: number, schema?: { safeParse: (v: unknown) => { success: boolean } }): ContractCaseRef<unknown, unknown> {
  return {
    __glubean_type: "contract-case-ref",
    contractId: "auth.sign-in.email",
    caseKey: "validStagingCredentials",
    protocol: "http",
    target: endpoint,
    contract: {
      _spec: { endpoint, cases: { validStagingCredentials: { expect: { status, schema } } } },
    },
  } as unknown as ContractCaseRef<unknown, unknown>;
}

function trace(p: Partial<BrowserTraceRecord> & { method: string; url: string; status: number }): BrowserTraceRecord {
  return { durationMs: 8, ...p };
}

// A fully-implemented login journey spec (all steps have actions).
function loginSpec(
  client: GlubeanBrowser,
  overrides: Partial<BrowserContractSpec> = {},
): BrowserContractSpec {
  return {
    client,
    entry: "/login",
    baseUrl: "https://app.staging.glubean.com",
    agentNotes: ["watch layout"],
    cases: {
      happyPath: {
        description: "login lands on dashboard",
        needs: undefined,
        steps: [
          { id: "open", intent: "open login", action: async () => {} },
          { id: "submit", intent: "submit", action: async () => {} },
        ],
        expect: [
          { id: "url-dashboard", url: { path: ["/", "/dashboard"], notPath: "/login" } },
          { id: "dom-welcome", dom: { visible: { selector: "h1.welcome" }, containsText: "Welcome back" } },
          { id: "calls-signin", calls: httpRef("POST /api/auth/sign-in/email", 200) },
          { id: "console-clean", console: { errors: 0, allow: ["favicon"] } },
        ],
      } as BrowserContractCase,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// project / normalize
// ---------------------------------------------------------------------------

describe("projectBrowser", () => {
  test("threads journey skeleton, runnability, requires=browser", () => {
    const { browser } = makeFakeBrowser({ finalUrl: "https://h/" });
    const spec = loginSpec(browser);
    (spec as unknown as { _factory: { instanceName: string } })._factory = { instanceName: "dashboardUI" };
    const proj = browserAdapter.project(spec);

    expect(proj.protocol).toBe("browser");
    expect(proj.instanceName).toBe("dashboardUI");
    expect(proj.meta?.baseUrl).toBe("https://app.staging.glubean.com");
    expect(proj.cases).toHaveLength(1);
    const c = proj.cases[0];
    expect(c.key).toBe("happyPath");
    expect(c.requires).toBe("browser");
    expect(c.schemas?.hasActions).toBe(true);
    expect(c.schemas?.intents).toEqual([
      { id: "open", intent: "open login" },
      { id: "submit", intent: "submit" },
    ]);
    // Projected expects carry SEMANTICS, not just ids (codex R11 #1).
    expect(c.schemas?.expects?.map((e) => `${e.id}:${e.kind}`)).toEqual([
      "url-dashboard:url",
      "dom-welcome:dom",
      "calls-signin:calls",
      "console-clean:console",
    ]);
    const urlExpect = c.schemas?.expects?.find((e) => e.id === "url-dashboard");
    expect(urlExpect?.url).toEqual({ path: ["/", "/dashboard"], notPath: "/login" });
    const callsExpect = c.schemas?.expects?.find((e) => e.id === "calls-signin");
    expect(callsExpect?.calls).toBe("auth.sign-in.email#validStagingCredentials");
    expect(c.schemas?.agentNotes).toContain("watch layout");
  });

  test("changing url.path under the same id changes the projection (codex R11 #1)", () => {
    const { browser } = makeFakeBrowser({ finalUrl: "https://h/" });
    const mk = (path: string): BrowserContractSpec => ({
      client: browser,
      cases: {
        c: {
          description: "x",
          steps: [{ id: "s", intent: "s", action: async () => {} }],
          expect: [{ id: "u", url: { path } }],
        } as BrowserContractCase,
      },
    });
    const a = browserAdapter.project(mk("/dashboard")).cases[0].schemas?.expects;
    const b = browserAdapter.project(mk("/login")).cases[0].schemas?.expects;
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b)); // same id, different semantics → different projection
  });

  test("hasActions false when a step lacks an action (Mode A unimplemented)", () => {
    const { browser } = makeFakeBrowser({ finalUrl: "https://h/" });
    const spec: BrowserContractSpec = {
      client: browser,
      cases: {
        partial: {
          description: "intent-only",
          steps: [{ id: "s1", intent: "do x" }], // no action
          expect: [{ id: "u", url: { path: "/" } }],
        } as BrowserContractCase,
      },
    };
    const proj = browserAdapter.project(spec);
    expect(proj.cases[0].schemas?.hasActions).toBe(false);
  });

  test("normalize produces a JSON-safe projection", () => {
    const { browser } = makeFakeBrowser({ finalUrl: "https://h/" });
    const proj = browserAdapter.project(loginSpec(browser)) as never;
    const extracted = browserAdapter.normalize({ ...(proj as object), id: "auth.login.journey" } as never);
    expect(extracted.id).toBe("auth.login.journey");
    expect(extracted.protocol).toBe("browser");
    expect(() => JSON.stringify(extracted)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// executeCase — judging
// ---------------------------------------------------------------------------

async function runCase(
  spec: BrowserContractSpec,
  caseKey = "happyPath",
  ctxLog = makeCtx(),
): Promise<{ log: CtxLog }> {
  await browserAdapter.executeCase!({
    ctx: ctxLog.ctx,
    contract: { _spec: spec } as never,
    caseKey,
    resolvedInput: undefined,
  });
  return { log: ctxLog.log };
}

describe("executeCase judging", () => {
  test("all expects pass on a clean journey", async () => {
    const { browser } = makeFakeBrowser({
      finalUrl: "https://app.staging.glubean.com/",
      visible: ["h1.welcome"],
      texts: { "h1.welcome": "Welcome back, Peisong" },
      traces: [trace({ method: "POST", url: "https://api.staging.glubean.com/api/auth/sign-in/email", status: 200 })],
      consoleErrors: [{ message: "favicon.ico 404", source: "https://app/favicon.ico" }],
    });
    const { log } = await runCase(loginSpec(browser));
    expect(log.assertions.every((a) => a.passed)).toBe(true);
    expect(log.assertions.map((a) => a.message?.slice(1, a.message.indexOf("]")))).toEqual([
      "url-dashboard",
      "dom-welcome",
      "calls-signin",
      "console-clean",
    ]);
  });

  test("url fail is recorded (still on /login) and other expects still judged", async () => {
    const { browser } = makeFakeBrowser({
      finalUrl: "https://app.staging.glubean.com/login",
      visible: ["h1.welcome"],
      texts: { "h1.welcome": "Welcome back, Peisong" },
      traces: [trace({ method: "POST", url: "https://api/api/auth/sign-in/email", status: 200 })],
    });
    const { log } = await runCase(loginSpec(browser));
    const byId = (id: string) => log.assertions.find((a) => a.message?.startsWith(`[${id}]`));
    expect(byId("url-dashboard")?.passed).toBe(false);
    // console-clean (last) still judged → all four expects produced an assertion.
    expect(log.assertions).toHaveLength(4);
  });

  test("product-domain console error fails console-clean", async () => {
    const { browser } = makeFakeBrowser({
      finalUrl: "https://app.staging.glubean.com/",
      visible: ["h1.welcome"],
      texts: { "h1.welcome": "Welcome back, Peisong" },
      traces: [trace({ method: "POST", url: "https://api/api/auth/sign-in/email", status: 200 })],
      consoleErrors: [{ message: "404", source: "https://api.staging.glubean.com/projects/x/targets" }],
    });
    const { log } = await runCase(loginSpec(browser));
    const console = log.assertions.find((a) => a.message?.startsWith("[console-clean]"));
    expect(console?.passed).toBe(false);
  });

  test("calls schema unverified (body absent) passes but warns", async () => {
    const { browser } = makeFakeBrowser({
      finalUrl: "https://app.staging.glubean.com/",
      visible: ["h1.welcome"],
      texts: { "h1.welcome": "Welcome back" },
      traces: [trace({ method: "POST", url: "https://api/api/auth/sign-in/email", status: 200 })],
    });
    const spec: BrowserContractSpec = {
      client: browser,
      entry: "/login",
      cases: {
        happyPath: {
          description: "x",
          steps: [{ id: "s", intent: "s", action: async () => {} }],
          expect: [
            { id: "calls-signin", calls: httpRef("POST /api/auth/sign-in/email", 200, { safeParse: () => ({ success: true }) }) },
          ],
        } as BrowserContractCase,
      },
    };
    const { log } = await runCase(spec);
    expect(log.assertions.find((a) => a.message?.startsWith("[calls-signin]"))?.passed).toBe(true);
    expect(log.warns.some((w) => w.message.includes("schema unverified"))).toBe(true);
  });

  test("dom role locator produces a :-p-aria selector", async () => {
    const { browser, last } = makeFakeBrowser({
      finalUrl: "https://h/",
      visible: ['::-p-aria(Welcome back, Peisong[role="heading"])'],
    });
    const spec: BrowserContractSpec = {
      client: browser,
      cases: {
        happyPath: {
          description: "x",
          steps: [{ id: "s", intent: "s", action: async () => {} }],
          expect: [{ id: "dom-welcome", dom: { visible: { role: "heading", name: "Welcome back, Peisong" } } }],
        } as BrowserContractCase,
      },
    };
    const { log } = await runCase(spec);
    expect(log.assertions[0].passed).toBe(true);
    expect(last()?.expectVisibleCalls).toContain('::-p-aria(Welcome back, Peisong[role="heading"])');
  });

  test("on-failure screenshot captured on a SOFT expect failure (codex R4 #2)", async () => {
    // screenshot:"on-failure" + a failing url expect. Soft asserts don't throw,
    // so the capture must happen in the judging path, not just the catch block.
    const { browser, last } = makeFakeBrowser({
      finalUrl: "https://app.staging.glubean.com/login", // fails url-dashboard
      visible: ["h1.welcome"],
      texts: { "h1.welcome": "Welcome back, Peisong" },
      traces: [trace({ method: "POST", url: "https://api/api/auth/sign-in/email", status: 200 })],
    });
    const spec: BrowserContractSpec = {
      client: browser,
      entry: "/login",
      cases: {
        happyPath: {
          description: "x",
          screenshot: "on-failure",
          steps: [{ id: "s", intent: "s", action: async () => {} }],
          expect: [{ id: "url-dashboard", url: { path: "/" } }],
        } as BrowserContractCase,
      },
    };
    await runCase(spec);
    expect(last()?.captureScreenshotLabels).toContain("expect-failure");
  });

  test("on-failure screenshot NOT captured when all expects pass (codex R4 #2)", async () => {
    const { browser, last } = makeFakeBrowser({ finalUrl: "https://h/dashboard" });
    const spec: BrowserContractSpec = {
      client: browser,
      entry: "/login",
      cases: {
        happyPath: {
          description: "x",
          screenshot: "on-failure",
          steps: [{ id: "s", intent: "s", action: async () => {} }],
          expect: [{ id: "url-dashboard", url: { path: "/dashboard" } }],
        } as BrowserContractCase,
      },
    };
    await runCase(spec);
    expect(last()?.captureScreenshotLabels).not.toContain("expect-failure");
  });

  test("evidence arrays are snapshotted — post-freeze events don't mutate the bundle (codex R6 #1)", async () => {
    const { browser, lastCtx } = makeFakeBrowser({
      finalUrl: "https://h/",
      traces: [trace({ method: "POST", url: "https://api/api/auth/sign-in/email", status: 200 })],
    });
    let captured: BrowserEvidence | undefined;
    const spec: BrowserContractSpec = {
      client: browser,
      entry: "/login",
      cases: {
        happyPath: {
          description: "x",
          steps: [{ id: "s", intent: "s", action: async () => {} }],
          expect: [],
          verify: (_ctx, evidence) => {
            captured = evidence;
          },
        } as BrowserContractCase,
      },
    };
    await runCase(spec);
    expect(captured?.network).toHaveLength(1);
    // A trace arriving AFTER the freeze (emitted to the live recording ctx) must
    // NOT retroactively appear in the frozen bundle.
    lastCtx()?.trace({
      name: "GET late",
      method: "GET",
      url: "https://h/late",
      status: 200,
      duration: 1,
      durationMs: 1,
    } as unknown as Parameters<BrowserTestContext["trace"]>[0]);
    expect(captured?.network).toHaveLength(1);
  });

  test("thrown failure uses captureScreenshot (always records), not mode-gated screenshotOnFailure (codex R6 #2)", async () => {
    const { browser, last } = makeFakeBrowser({ finalUrl: "https://h/" });
    const spec: BrowserContractSpec = {
      client: browser,
      entry: "/login",
      cases: {
        happyPath: {
          description: "x",
          screenshot: "on-failure",
          steps: [
            {
              id: "s",
              intent: "s",
              action: async () => {
                throw new Error("navigation blew up");
              },
            },
          ],
          expect: [],
        } as BrowserContractCase,
      },
    };
    await expect(runCase(spec)).rejects.toThrow(/blew up/);
    expect(last()?.captureScreenshotLabels).toContain("failure");
  });

  test("settle waits for a late-arriving trace before judging calls (codex R5 #1)", async () => {
    // The matching sign-in trace lands AFTER network idle (getResponseBody lag).
    const { browser } = makeFakeBrowser({
      finalUrl: "https://h/",
      lateTraces: [trace({ method: "POST", url: "https://api/api/auth/sign-in/email", status: 200 })],
    });
    const spec: BrowserContractSpec = {
      client: browser,
      entry: "/login",
      cases: {
        happyPath: {
          description: "x",
          steps: [{ id: "s", intent: "s", action: async () => {} }],
          expect: [{ id: "calls-signin", calls: httpRef("POST /api/auth/sign-in/email", 200) }],
        } as BrowserContractCase,
      },
    };
    const { log } = await runCase(spec);
    // Without the trace-flush wait this would be a false failure.
    expect(log.assertions.find((a) => a.message?.startsWith("[calls-signin]"))?.passed).toBe(true);
  });

  test("verify receives the logical input (codex R5 #2)", async () => {
    const { browser } = makeFakeBrowser({
      finalUrl: "https://h/",
      traces: [trace({ method: "POST", url: "https://api/api/auth/sign-in/email", status: 200 })],
    });
    let seenInput: { email?: string } | undefined;
    const spec: BrowserContractSpec = {
      client: browser,
      entry: "/login",
      cases: {
        happyPath: {
          description: "x",
          steps: [{ id: "s", intent: "s", action: async () => {} }],
          expect: [],
          verify: (_ctx, _evidence, input) => {
            seenInput = input as unknown as { email?: string };
          },
        } as BrowserContractCase,
      },
    };
    await browserAdapter.executeCase!({
      ctx: makeCtx().ctx,
      contract: { _spec: spec } as never,
      caseKey: "happyPath",
      resolvedInput: { email: "dogfood@example.com" },
    });
    expect(seenInput?.email).toBe("dogfood@example.com");
  });

  test("entry-only journey (steps: []) is runnable, not skipped (codex R5 #3)", async () => {
    const { browser } = makeFakeBrowser({ finalUrl: "https://h/dashboard" });
    const spec: BrowserContractSpec = {
      client: browser,
      entry: "/dashboard",
      cases: {
        pageLoad: {
          description: "just open the page and check the URL",
          steps: [],
          expect: [{ id: "url", url: { path: "/dashboard" } }],
        } as BrowserContractCase,
      },
    };
    const { log } = await runCase(spec, "pageLoad");
    // Judged (not skipped): exactly one url assertion, and it passed.
    expect(log.assertions).toHaveLength(1);
    expect(log.assertions[0].passed).toBe(true);
  });

  test("dom expect with BOTH visible+absent evaluates both (codex R9 #1)", async () => {
    // welcome heading visible AND error banner still present → the absent
    // sub-check must fail even though the visible sub-check passes.
    const { browser } = makeFakeBrowser({
      finalUrl: "https://h/",
      present: ["h1.welcome", ".error-banner"],
      visible: ["h1.welcome"],
    });
    const spec: BrowserContractSpec = {
      client: browser,
      entry: "/x",
      cases: {
        c: {
          description: "x",
          steps: [{ id: "s", intent: "s", action: async () => {} }],
          expect: [
            {
              id: "dom",
              dom: { visible: { selector: "h1.welcome" }, absent: { selector: ".error-banner" } },
            },
          ],
        } as BrowserContractCase,
      },
    };
    const { log } = await runCase(spec, "c");
    // Two assertions for the one dom expect: visible passes, absent fails.
    expect(log.assertions.some((a) => a.message?.includes("visible") && a.passed)).toBe(true);
    expect(log.assertions.some((a) => a.message?.includes("still present") && !a.passed)).toBe(true);
  });

  test("on-failure screenshot fires for a soft failure inside a STEP ACTION (codex R9 #2)", async () => {
    const { browser, last } = makeFakeBrowser({ finalUrl: "https://h/" });
    const spec: BrowserContractSpec = {
      client: browser,
      entry: "/x",
      cases: {
        c: {
          description: "x",
          screenshot: "on-failure",
          steps: [
            {
              id: "s",
              intent: "s",
              action: async (_page, _input, actionCtx) => {
                actionCtx.assert(false, "action-level check failed");
              },
            },
          ],
          expect: [],
        } as BrowserContractCase,
      },
    };
    await runCase(spec, "c");
    expect(last()?.captureScreenshotLabels).toContain("expect-failure");
  });

  test("on-failure screenshot fires for a verify VALIDATE failure (codex R9 #3)", async () => {
    const { browser, last } = makeFakeBrowser({ finalUrl: "https://h/" });
    const spec: BrowserContractSpec = {
      client: browser,
      entry: "/x",
      cases: {
        c: {
          description: "x",
          screenshot: "on-failure",
          steps: [{ id: "s", intent: "s", action: async () => {} }],
          expect: [],
          verify: (vctx) => {
            vctx.validate({ bad: 1 }, { safeParse: () => ({ success: false }) } as never, "payload");
          },
        } as BrowserContractCase,
      },
    };
    await runCase(spec, "c");
    expect(last()?.captureScreenshotLabels).toContain("expect-failure");
  });

  test("on-failure fires for a PARSE-ONLY validate failure (codex R10)", async () => {
    // SchemaLike may be parse-only (no safeParse); a throwing parse is a failure.
    const { browser, last } = makeFakeBrowser({ finalUrl: "https://h/" });
    const spec: BrowserContractSpec = {
      client: browser,
      entry: "/x",
      cases: {
        c: {
          description: "x",
          screenshot: "on-failure",
          steps: [{ id: "s", intent: "s", action: async () => {} }],
          expect: [],
          verify: (vctx) => {
            vctx.validate(
              { bad: 1 },
              {
                parse: () => {
                  throw new Error("schema rejected");
                },
              } as never,
              "payload",
            );
          },
        } as BrowserContractCase,
      },
    };
    await runCase(spec, "c");
    expect(last()?.captureScreenshotLabels).toContain("expect-failure");
  });

  test("uncaught page error fails console-clean (codex R8 #1)", async () => {
    // A JS crash emits browser:uncaught-error (not console-error) — console-clean
    // must still fail, otherwise a passing test on a crashing page.
    const { browser } = makeFakeBrowser({
      finalUrl: "https://h/",
      uncaughtErrors: [{ message: "TypeError: cannot read 'x' of undefined" }],
    });
    const spec: BrowserContractSpec = {
      client: browser,
      entry: "/x",
      cases: {
        c: {
          description: "x",
          steps: [{ id: "s", intent: "s", action: async () => {} }],
          expect: [{ id: "console-clean", console: { errors: 0 } }],
        } as BrowserContractCase,
      },
    };
    const { log } = await runCase(spec, "c");
    expect(log.assertions.find((a) => a.message?.startsWith("[console-clean]"))?.passed).toBe(false);
  });

  test("on-failure screenshot fires for a FLUENT verify failure (vctx.expect) (codex R8 #2)", async () => {
    const { browser, last } = makeFakeBrowser({ finalUrl: "https://h/" });
    const spec: BrowserContractSpec = {
      client: browser,
      entry: "/x",
      cases: {
        c: {
          description: "x",
          screenshot: "on-failure",
          steps: [{ id: "s", intent: "s", action: async () => {} }],
          expect: [],
          verify: (vctx) => {
            vctx.expect(1).toBe(2); // fluent soft failure
          },
        } as BrowserContractCase,
      },
    };
    await runCase(spec, "c");
    expect(last()?.captureScreenshotLabels).toContain("expect-failure");
  });

  test("dom.absent fails a hidden-but-present element (zero-matches, not hidden) (codex R7 #1)", async () => {
    // Error banner display:none'd but NOT removed → still in the DOM → absent fails.
    const { browser } = makeFakeBrowser({
      finalUrl: "https://h/",
      present: [".error-banner"], // in DOM
      visible: [], // but not visible
    });
    const spec: BrowserContractSpec = {
      client: browser,
      entry: "/x",
      cases: {
        c: {
          description: "x",
          steps: [{ id: "s", intent: "s", action: async () => {} }],
          expect: [{ id: "no-error", dom: { absent: { selector: ".error-banner" } } }],
        } as BrowserContractCase,
      },
    };
    const { log } = await runCase(spec, "c");
    expect(log.assertions[0].passed).toBe(false); // present-but-hidden ≠ absent
  });

  test("dom.absent passes a truly-removed element", async () => {
    const { browser } = makeFakeBrowser({ finalUrl: "https://h/", present: [], visible: [] });
    const spec: BrowserContractSpec = {
      client: browser,
      entry: "/x",
      cases: {
        c: {
          description: "x",
          steps: [{ id: "s", intent: "s", action: async () => {} }],
          expect: [{ id: "no-error", dom: { absent: { selector: ".error-banner" } } }],
        } as BrowserContractCase,
      },
    };
    const { log } = await runCase(spec, "c");
    expect(log.assertions[0].passed).toBe(true);
  });

  test("on-failure screenshot fires when the ONLY failure is a soft verify assertion (codex R7 #2)", async () => {
    const { browser, last } = makeFakeBrowser({ finalUrl: "https://h/" });
    const spec: BrowserContractSpec = {
      client: browser,
      entry: "/x",
      cases: {
        c: {
          description: "x",
          screenshot: "on-failure",
          steps: [{ id: "s", intent: "s", action: async () => {} }],
          expect: [], // all expects pass (none)
          verify: (vctx) => {
            vctx.assert(false, "custom verify failed");
          },
        } as BrowserContractCase,
      },
    };
    await runCase(spec, "c");
    expect(last()?.captureScreenshotLabels).toContain("expect-failure");
  });

  test("verify hook runs with the frozen evidence bundle", async () => {
    const { browser } = makeFakeBrowser({
      finalUrl: "https://h/",
      traces: [trace({ method: "POST", url: "https://api/api/auth/sign-in/email", status: 200 })],
    });
    let seen: BrowserEvidence | undefined;
    const spec: BrowserContractSpec = {
      client: browser,
      entry: "/login",
      cases: {
        happyPath: {
          description: "x",
          steps: [{ id: "s", intent: "s", action: async () => {} }],
          expect: [],
          verify: (_ctx, evidence) => {
            seen = evidence;
          },
        } as BrowserContractCase,
      },
    };
    await runCase(spec);
    expect(seen?.network).toHaveLength(1);
    expect(seen?.network[0].url).toContain("/api/auth/sign-in/email");
    expect(seen?.finalUrl).toBe("https://h/");
  });
});

// ---------------------------------------------------------------------------
// unimplemented skip / raw execute / flow
// ---------------------------------------------------------------------------

describe("runnability", () => {
  test("executeCase skips an unimplemented case (a step has no action)", async () => {
    const { browser } = makeFakeBrowser({ finalUrl: "https://h/" });
    const spec: BrowserContractSpec = {
      client: browser,
      cases: {
        partial: {
          description: "intent-only",
          steps: [
            { id: "s1", intent: "do x", action: async () => {} },
            { id: "s2", intent: "do y" }, // no action
          ],
          expect: [{ id: "u", url: { path: "/" } }],
        } as BrowserContractCase,
      },
    };
    const { ctx, log } = makeCtx();
    await expect(
      browserAdapter.executeCase!({ ctx, contract: { _spec: spec } as never, caseKey: "partial", resolvedInput: undefined }),
    ).rejects.toThrow(/unimplemented/);
    // No expects judged when skipped.
    expect(log.assertions).toHaveLength(0);
  });

  test("executeCaseInFlow throws for an unimplemented case", async () => {
    const { browser } = makeFakeBrowser({ finalUrl: "https://h/" });
    const spec: BrowserContractSpec = {
      client: browser,
      cases: {
        partial: { description: "x", steps: [{ id: "s", intent: "s" }], expect: [] } as BrowserContractCase,
      },
    };
    const { ctx } = makeCtx();
    await expect(
      browserAdapter.executeCaseInFlow!({ ctx, contract: { _spec: spec } as never, caseKey: "partial", resolvedInputs: undefined }),
    ).rejects.toThrow(/unimplemented/);
  });

  test("raw execute path runs a runnable case", async () => {
    const { browser } = makeFakeBrowser({
      finalUrl: "https://app.staging.glubean.com/",
      visible: ["h1.welcome"],
      texts: { "h1.welcome": "Welcome back, Peisong" },
      traces: [trace({ method: "POST", url: "https://api/api/auth/sign-in/email", status: 200 })],
    });
    const spec = loginSpec(browser);
    const { ctx, log } = makeCtx();
    await browserAdapter.execute(ctx, spec.cases.happyPath, spec);
    expect(log.assertions.every((a) => a.passed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// factory + plugin wiring
// ---------------------------------------------------------------------------

describe("contract.browser factory", () => {
  test("root is .with-only; direct call throws", () => {
    const root = (contract as unknown as { browser: BrowserContractRoot }).browser;
    expect(typeof root.with).toBe("function");
    expect(() => (root as unknown as (...a: unknown[]) => unknown)("id", {})).toThrow(/not supported/);
  });

  test(".with injects client + baseUrl and builds a ProtocolContract", () => {
    const { browser } = makeFakeBrowser({ finalUrl: "https://h/" });
    const ui = (contract as unknown as { browser: BrowserContractRoot }).browser.with("dashboardUI", {
      client: browser,
      baseUrl: "https://app.staging.glubean.com",
      entry: "/login",
    });
    const journey = ui("auth.login.journey", {
      cases: {
        happyPath: {
          description: "login",
          steps: [{ id: "s", intent: "s", action: async () => {} }],
          expect: [{ id: "u", url: { path: "/" } }],
        },
      },
    });
    expect(journey._spec.client).toBe(browser);
    expect(journey._spec.baseUrl).toBe("https://app.staging.glubean.com");
    expect(journey._projection.instanceName).toBe("dashboardUI");
    expect(journey._projection.protocol).toBe("browser");
    expect(typeof journey.case).toBe("function");
  });

  test("input-bearing case (defineBrowserCase) types the action input + case ref (codex R4 #1)", async () => {
    const { browser } = makeFakeBrowser({ finalUrl: "https://h/" });
    let seenEmail: string | undefined;
    const ui = (contract as unknown as { browser: BrowserContractRoot }).browser.with("dashboardUI", {
      client: browser,
      entry: "/login",
    });
    // If the shared-Input regression were present, `input.email` below would not
    // type-check (Input would collapse to void/unknown for the whole cases map).
    const journey = ui("auth.login.journey", {
      cases: {
        happyPath: defineBrowserCase<{ email: string }>({
          description: "login with a typed email",
          needs: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never,
          steps: [
            {
              id: "s",
              intent: "type the email",
              action: async (_page, input) => {
                seenEmail = input.email; // must be typed as string, not unknown
              },
            },
          ],
          expect: [],
        }),
      },
    });
    // `journey.case("happyPath")` carries the {email} input type at compile time.
    const ref = journey.case("happyPath");
    expect(ref.caseKey).toBe("happyPath");

    await browserAdapter.executeCase!({
      ctx: makeCtx().ctx,
      contract: { _spec: journey._spec } as never,
      caseKey: "happyPath",
      resolvedInput: { email: "dogfood@example.com" },
    });
    expect(seenEmail).toBe("dogfood@example.com");
  });

  test("scoped clients propagate extension page capabilities into step actions", () => {
    // This assertion is compile-time evidence enforced by the package's
    // `test:types` gate; Vitest alone erases `expectTypeOf` at runtime.
    const extensionBrowser = {
      newPage: async (_ctx: BrowserTestContext) => ({} as ExtensionPage),
    };
    const extensionUI = (
      contract as unknown as { browser: BrowserContractRoot }
    ).browser.with("extensionUI", {
      client: extensionBrowser,
    });

    extensionUI("native-side-panel", {
      cases: {
        openCloseReopen: defineBrowserCase({
          description: "The native side panel opens, closes, and reopens from the toolbar action.",
          steps: [
            {
              id: "open-close-reopen",
              intent: "open the side panel, close it, and open it again",
              action: async (page) => {
                expectTypeOf(page).toEqualTypeOf<ExtensionPage>();
                const panel = await page.extension.sidePanel.open();
                await panel.close();
              },
            },
          ],
          expect: [],
        }),
      },
    });
  });
});
