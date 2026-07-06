/**
 * Built-in browser contract adapter for @glubean/browser (Mode A minimal —
 * GLU-212 / proposal contract-browser-two-tier.md §3).
 *
 * Registered via the plugin manifest (`installPlugin(browserPlugin)`); a bare
 * `import { browser } from "@glubean/browser"` (the client factory) does NOT
 * register the adapter — the two install paths are separate (client via
 * `configure({ plugins })`, contract adapter via `installPlugin`).
 *
 * Attachment-model v10 adapter. No per-case lifecycle: the case is pure
 * journey semantics; setup-style work (e.g. a signed-in session) belongs to a
 * `contract.bootstrap()` overlay. Function-valued `steps[].action` / `verify`
 * receive the case's logical input (matching `needs`).
 *
 * Responsibilities (same interface as HTTP / GraphQL / gRPC adapters):
 *   - execute / executeCase — replay the journey with @glubean/browser, freeze
 *     the evidence window, and judge `expect` authoritatively via `ctx.assert`.
 *   - project / normalize — thread the journey skeleton (intents + expect ids +
 *     agentNotes + Mode-A runnability) into the projection.
 *   - classifyFailure / renderTarget / artifacts.markdown / describePayload.
 *
 * A step without an `action` cannot be replayed → Mode A marks the whole case
 * *unimplemented* and skips it (a visible debt); Mode B (agent QA) is
 * unaffected. `action` is a function field, projected-out of the canonical
 * hash exactly like HTTP `verify` / `body: () => ...`.
 */

import type {
  CaseMeta,
  ContractProjection,
  ContractProtocolAdapter,
  ExtractedCaseMeta,
  ExtractedContractProjection,
  FailureClassification,
  PayloadDescriptor,
  TestContext,
} from "@glubean/sdk";
import { genericMarkdownPart } from "@glubean/sdk";

import type {
  BrowserTestContext,
  GlubeanBrowser,
  InstrumentedPage,
} from "../page.js";
import {
  describeLocator,
  matchCalls,
  matchConsole,
  matchUrl,
  resolveLocator,
} from "./matchers.js";
import type {
  BrowserConsoleError,
  BrowserContractCase,
  BrowserContractMeta,
  BrowserContractSafeMeta,
  BrowserContractSpec,
  BrowserEvidence,
  BrowserExpect,
  BrowserLocatorSpec,
  BrowserPayloadSchemas,
  BrowserSafeSchemas,
  BrowserTraceRecord,
} from "./types.js";

// =============================================================================
// Helpers — schema → JSON, note merge, resolution
// =============================================================================

/** Best-effort convert a SchemaLike to a JSON Schema fragment (or undefined). */
function toJsonSchemaOrUndefined(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const maybe = (schema as { toJSONSchema?: () => unknown }).toJSONSchema;
  if (typeof maybe === "function") {
    try {
      const out = maybe.call(schema);
      if (out && typeof out === "object") return out as Record<string, unknown>;
    } catch {
      /* fall through to declared companion */
    }
  }
  const declared = (schema as { jsonSchema?: unknown }).jsonSchema;
  if (declared && typeof declared === "object" && !Array.isArray(declared)) {
    return declared as Record<string, unknown>;
  }
  return undefined;
}

/** Merge contract-level + case-level agentNotes (contract first, dedup). */
function mergeNotes(base: string[] | undefined, more: string[] | undefined): string[] | undefined {
  if (!base && !more) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of [...(base ?? []), ...(more ?? [])]) {
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Resolve the effective browser client (case > spec). Throws only at run time. */
function resolveClient(
  caseSpec: BrowserContractCase,
  spec: BrowserContractSpec,
): GlubeanBrowser {
  const client = caseSpec.client ?? spec.client;
  if (!client) {
    throw new Error(
      `No browser client provided for case. Set "client" on the case or contract spec ` +
        `(e.g. via contract.browser.with("name", { client: chrome })), where chrome comes ` +
        `from configure({ plugins: { chrome: browser({...}) } }).`,
    );
  }
  return client;
}

/** Resolve the effective entry path (case > spec). */
function resolveEntry(
  caseSpec: BrowserContractCase,
  spec: BrowserContractSpec,
): string | undefined {
  return caseSpec.entry ?? spec.entry;
}

/** True iff every step has an `action` (Mode A can replay the whole journey). */
function isRunnable(caseSpec: BrowserContractCase): boolean {
  return caseSpec.steps.length > 0 && caseSpec.steps.every((s) => typeof s.action === "function");
}

/** List the step ids that lack an `action`. */
function unimplementedSteps(caseSpec: BrowserContractCase): string[] {
  return caseSpec.steps.filter((s) => typeof s.action !== "function").map((s) => s.id);
}

// =============================================================================
// Recording context — captures network traces + console errors during a run
// =============================================================================

interface RecordingCtx {
  recCtx: BrowserTestContext;
  network: BrowserTraceRecord[];
  consoleErrors: BrowserConsoleError[];
}

/**
 * Wrap the real TestContext into a BrowserTestContext that records network
 * traces + console-error events (for post-hoc `expect` judging) while still
 * forwarding everything to the real ctx (so evidence lands in the run).
 */
function makeRecordingCtx(ctx: TestContext): RecordingCtx {
  const network: BrowserTraceRecord[] = [];
  const consoleErrors: BrowserConsoleError[] = [];
  const host = ctx as unknown as {
    testId?: string;
    artifactDir?: string;
    saveArtifact?: BrowserTestContext["saveArtifact"];
  };

  const recCtx: BrowserTestContext = {
    testId: host.testId,
    artifactDir: host.artifactDir,
    action: (a) => ctx.action(a as unknown as Parameters<TestContext["action"]>[0]),
    event: (ev) => {
      if (ev.type === "browser:console-error") {
        consoleErrors.push({
          message: String((ev.data as { message?: unknown })?.message ?? ""),
          source:
            typeof (ev.data as { source?: unknown })?.source === "string"
              ? ((ev.data as { source: string }).source)
              : undefined,
        });
      }
      ctx.event(ev as unknown as Parameters<TestContext["event"]>[0]);
    },
    trace: (t) => {
      const raw = t as unknown as {
        method?: unknown;
        url?: unknown;
        status?: unknown;
        duration?: unknown;
        durationMs?: unknown;
        requestBody?: unknown;
        responseBody?: unknown;
      };
      network.push({
        method: String(raw.method ?? ""),
        url: String(raw.url ?? ""),
        status: Number(raw.status ?? 0),
        durationMs: Number(raw.durationMs ?? raw.duration ?? 0),
        requestBody: raw.requestBody,
        responseBody: raw.responseBody,
      });
      ctx.trace(t as unknown as Parameters<TestContext["trace"]>[0]);
    },
    metric: (n, v, o) => ctx.metric(n, v, o),
    log: (m, d) => ctx.log(m, d),
    warn: (c, m) => ctx.warn(c, m),
    saveArtifact: host.saveArtifact ? host.saveArtifact.bind(ctx) : undefined,
  };

  return { recCtx, network, consoleErrors };
}

// =============================================================================
// Journey execution + evidence freeze
// =============================================================================

const DOM_TIMEOUT_MS = 8_000;
const NETWORK_IDLE_MS = 500;
const NETWORK_IDLE_TIMEOUT_MS = 5_000;

/** Convert a BrowserLocatorSpec into a page selector string. */
function locatorToSelector(spec: BrowserLocatorSpec): string {
  const r = resolveLocator(spec);
  switch (r.kind) {
    case "selector":
      return r.selector;
    case "testId":
      return `[data-testid="${r.testId}"]`;
    case "text":
      return `::-p-text(${r.text})`;
    case "role":
      return r.name ? `::-p-aria(${r.name}[role="${r.role}"])` : `[role="${r.role}"]`;
    case "label":
      return `::-p-aria(${r.label})`;
  }
}

/** Best-effort settle: wait for the network to go idle after the last step. */
async function settleNetwork(page: InstrumentedPage): Promise<void> {
  const raw = (page as { raw?: { waitForNetworkIdle?: (o: unknown) => Promise<void> } }).raw;
  if (raw && typeof raw.waitForNetworkIdle === "function") {
    try {
      await raw.waitForNetworkIdle({
        idleTime: NETWORK_IDLE_MS,
        timeout: NETWORK_IDLE_TIMEOUT_MS,
      });
    } catch {
      /* idle timeout is fine — proceed with whatever was captured */
    }
  }
}

// =============================================================================
// expect judging (authoritative Mode A — ctx.assert)
// =============================================================================

/** Judge a `dom` expectation against the live page. */
async function judgeDom(
  ctx: TestContext,
  page: InstrumentedPage,
  id: string,
  dom: NonNullable<Extract<BrowserExpect, { dom: unknown }>["dom"]>,
): Promise<void> {
  if (dom.visible) {
    const selector = locatorToSelector(dom.visible);
    const label = describeLocator(dom.visible);
    try {
      await page.expectVisible(selector, { timeout: DOM_TIMEOUT_MS });
      if (dom.containsText !== undefined) {
        await page.expectText(selector, dom.containsText, { timeout: DOM_TIMEOUT_MS });
      }
      ctx.assert(
        true,
        `[${id}] ${label} visible${dom.containsText ? ` containing "${dom.containsText}"` : ""}`,
      );
    } catch (err) {
      ctx.assert(false, `[${id}] ${label} not visible: ${errMessage(err)}`);
    }
    return;
  }
  if (dom.absent) {
    const selector = locatorToSelector(dom.absent);
    const label = describeLocator(dom.absent);
    try {
      await page.expectHidden(selector, { timeout: DOM_TIMEOUT_MS });
      ctx.assert(true, `[${id}] ${label} absent`);
    } catch (err) {
      ctx.assert(false, `[${id}] ${label} still present: ${errMessage(err)}`);
    }
    return;
  }
  ctx.fail(`[${id}] dom expectation declared neither "visible" nor "absent"`);
}

/** Judge all declared expects against the frozen evidence + live page. */
async function judgeExpects(
  ctx: TestContext,
  page: InstrumentedPage,
  caseSpec: BrowserContractCase,
  evidence: BrowserEvidence,
): Promise<void> {
  for (const raw of caseSpec.expect ?? []) {
    const e = raw as {
      id: string;
      url?: Extract<BrowserExpect, { url: unknown }>["url"];
      dom?: Extract<BrowserExpect, { dom: unknown }>["dom"];
      calls?: Extract<BrowserExpect, { calls: unknown }>["calls"];
      console?: Extract<BrowserExpect, { console: unknown }>["console"];
    };
    if (e.url) {
      const r = matchUrl(e.url, evidence.finalUrl);
      ctx.assert(r.ok, `[${e.id}] ${r.detail}`);
    } else if (e.dom) {
      await judgeDom(ctx, page, e.id, e.dom);
    } else if (e.calls) {
      const r = matchCalls(e.calls, evidence.network);
      ctx.assert(r.matched, `[${e.id}] ${r.detail}`);
      // schema "unverified" is a visible debt, NOT a failure (§3.1).
      if (r.matched && r.schema === "unverified") {
        ctx.warn(false, `[${e.id}] calls matched, schema unverified: ${r.detail}`);
      }
    } else if (e.console) {
      const r = matchConsole(e.console, evidence.consoleErrors);
      ctx.assert(r.ok, `[${e.id}] ${r.detail}`);
    } else {
      ctx.fail(`[${e.id}] expect entry declares none of url/dom/calls/console`);
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// =============================================================================
// runAndJudge — replay the journey and judge expects with the page still open
// =============================================================================

/**
 * Run the journey and judge expects while the page is still open (dom checks
 * need the live page). Kept as one flow so the page lifetime spans judging.
 */
async function runAndJudge(
  ctx: TestContext,
  caseSpec: BrowserContractCase,
  spec: BrowserContractSpec,
  resolvedInput: unknown,
): Promise<BrowserEvidence> {
  const client = resolveClient(caseSpec, spec);
  const entry = resolveEntry(caseSpec, spec);
  const strategy = caseSpec.screenshot ?? "final";
  const { recCtx, network, consoleErrors } = makeRecordingCtx(ctx);

  const page = await client.newPage(recCtx);
  try {
    if (entry) {
      await page.goto(entry, { waitUntil: "domcontentloaded" });
    }
    for (const step of caseSpec.steps) {
      await step.action!(page, resolvedInput as never, ctx);
      if (strategy === "each-step") {
        await page.captureScreenshot(`step-${step.id}`);
      }
    }
    await settleNetwork(page);
    if (strategy === "final") {
      await page.captureScreenshot("final");
    }

    const evidence: BrowserEvidence = { network, consoleErrors, finalUrl: page.url() };
    await judgeExpects(ctx, page, caseSpec, evidence);
    if (caseSpec.verify) {
      await caseSpec.verify(ctx, evidence);
    }
    return evidence;
  } catch (err) {
    if (strategy === "on-failure" || strategy === "final") {
      await page.screenshotOnFailure().catch(() => undefined);
    }
    throw err;
  } finally {
    await page.close().catch(() => undefined);
  }
}

// =============================================================================
// project — runtime ContractProjection
// =============================================================================

function projectBrowser(
  spec: BrowserContractSpec,
): ContractProjection<BrowserPayloadSchemas, BrowserContractMeta> {
  const meta: BrowserContractMeta = {
    baseUrl: spec.baseUrl,
    entry: spec.entry,
    agentNotes: spec.agentNotes,
  };

  const cases: CaseMeta<BrowserPayloadSchemas, BrowserContractMeta>[] = Object.entries(
    spec.cases,
  ).map(([key, c]) => {
    const casted = c as BrowserContractCase;
    const lifecycle = casted.deprecated
      ? "deprecated"
      : casted.deferred
        ? "deferred"
        : "active";
    const schemas: BrowserPayloadSchemas = {
      entry: casted.entry ?? spec.entry,
      intents: casted.steps.map((s) => ({ id: s.id, intent: s.intent })),
      expectIds: (casted.expect ?? []).map((e) => e.id),
      agentNotes: mergeNotes(spec.agentNotes, casted.agentNotes),
      hasActions: isRunnable(casted),
    };
    return {
      key,
      description: casted.description,
      lifecycle,
      severity: casted.severity ?? "warning",
      deferredReason: casted.deferred,
      deprecatedReason: casted.deprecated,
      schemas,
      tags: casted.tags,
      extensions: casted.extensions,
      requires: casted.requires ?? "browser",
      defaultRun: casted.defaultRun,
      given: casted.given,
      hasVerify: typeof casted.verify === "function",
      verifyRules: casted.verifyRules,
      runnability: casted.runnability,
      hasNeeds: casted.needs !== undefined,
      needsSchema: casted.needs as unknown,
    };
  });

  const factory = (spec as unknown as { _factory?: { instanceName: string } })._factory;

  return {
    protocol: "browser",
    target: spec.baseUrl ?? spec.entry ?? "",
    description: spec.description,
    feature: spec.feature,
    instanceName: factory?.instanceName,
    tags: spec.tags,
    extensions: spec.extensions,
    deprecated: spec.deprecated,
    cases,
    schemas: {},
    meta,
  };
}

// =============================================================================
// normalize — runtime → JSON-safe Extracted
// =============================================================================

function normalizeBrowser(
  projection: ContractProjection<BrowserPayloadSchemas, BrowserContractMeta> & { id: string },
): ExtractedContractProjection<BrowserSafeSchemas, BrowserContractSafeMeta> {
  const failures: string[] = [];
  const safeCases: ExtractedCaseMeta<BrowserSafeSchemas, BrowserContractSafeMeta>[] =
    projection.cases.map((c) => {
      let safeNeeds: Record<string, unknown> | undefined;
      if (c.needsSchema != null) {
        safeNeeds = toJsonSchemaOrUndefined(c.needsSchema);
        if (safeNeeds === undefined) failures.push(`cases.${c.key}.needsSchema`);
      }
      return {
        ...c,
        schemas: c.schemas, // already JSON-safe by construction
        needsSchema: safeNeeds,
      };
    });

  return {
    id: projection.id,
    protocol: projection.protocol,
    target: projection.target,
    description: projection.description,
    feature: projection.feature,
    instanceName: projection.instanceName,
    tags: projection.tags,
    extensions: projection.extensions,
    deprecated: projection.deprecated,
    cases: safeCases,
    schemas: {},
    meta: projection.meta,
    unprojectableSchemas: failures.length > 0 ? failures : undefined,
  };
}

// =============================================================================
// executeCaseInFlow — flow-mode execution
// =============================================================================

async function executeCaseInFlowBrowser(input: {
  ctx: TestContext;
  contract: { _spec: unknown };
  caseKey: string;
  resolvedInputs: unknown;
}): Promise<BrowserEvidence> {
  const { ctx, contract: c, caseKey, resolvedInputs } = input;
  const spec = c._spec as BrowserContractSpec;
  const caseSpec = spec.cases[caseKey] as BrowserContractCase | undefined;
  if (!caseSpec) {
    throw new Error(`browser contract: unknown case key "${caseKey}".`);
  }
  if (!isRunnable(caseSpec)) {
    throw new Error(
      `browser contract case "${caseKey}" is Mode-A unimplemented ` +
        `(step(s) [${unimplementedSteps(caseSpec).join(", ")}] have no action) — ` +
        `not runnable in a flow.`,
    );
  }
  return runAndJudge(ctx, caseSpec, spec, resolvedInputs);
}

// =============================================================================
// classifyFailure
// =============================================================================

function classifyBrowserFailure(input: {
  error?: unknown;
  events: Array<{ type: string; data: Record<string, unknown> }>;
}): FailureClassification | undefined {
  // An uncaught page error is a product defect surfaced through the browser.
  const pageError = input.events.find((e) => e.type === "browser:uncaught-error");
  if (pageError) {
    return {
      kind: "server",
      source: "trace",
      message: String(pageError.data?.message ?? "uncaught page error"),
    };
  }
  if (input.error instanceof Error) {
    const name = input.error.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return { kind: "transient", source: "trace", retryable: true, message: input.error.message };
    }
    return { kind: "server", source: "trace", message: input.error.message };
  }
  return undefined;
}

// =============================================================================
// renderTarget / describePayload
// =============================================================================

function renderBrowserTarget(target: string): string {
  return target || "(browser)";
}

function describeBrowserPayload(schemas: BrowserSafeSchemas): PayloadDescriptor | undefined {
  return {
    hasRequest: (schemas.intents?.length ?? 0) > 0,
    hasResponse: (schemas.expectIds?.length ?? 0) > 0,
    protocol: "browser",
  };
}

// =============================================================================
// Exported adapter
// =============================================================================

export const browserAdapter: ContractProtocolAdapter<
  BrowserContractSpec,
  BrowserPayloadSchemas,
  BrowserContractMeta,
  BrowserSafeSchemas,
  BrowserContractSafeMeta
> = {
  // v0 raw path: no overlay + no needs (no resolvedInput). Run case raw.
  async execute(ctx, caseSpec, contractSpec) {
    const cs = caseSpec as BrowserContractCase;
    const spec = contractSpec as BrowserContractSpec;
    if (!isRunnable(cs)) {
      ctx.skip(
        `Mode A unimplemented: step(s) [${unimplementedSteps(cs).join(", ")}] have no action.`,
      );
    }
    await runAndJudge(ctx, cs, spec, undefined);
  },
  // v10 attachment-model entry point.
  async executeCase({ ctx, contract, caseKey, resolvedInput }) {
    const spec = (contract as { _spec: unknown })._spec as BrowserContractSpec;
    const caseSpec = spec.cases[caseKey] as BrowserContractCase | undefined;
    if (!caseSpec) {
      throw new Error(`browser contract: unknown case key "${caseKey}".`);
    }
    if (!isRunnable(caseSpec)) {
      ctx.skip(
        `Mode A unimplemented: step(s) [${unimplementedSteps(caseSpec).join(", ")}] have no action ` +
          `(intent-only). Mode B (agent QA) can still run this case.`,
      );
    }
    await runAndJudge(ctx, caseSpec, spec, resolvedInput);
  },
  project: projectBrowser,
  normalize: normalizeBrowser,
  executeCaseInFlow: executeCaseInFlowBrowser as ContractProtocolAdapter<
    BrowserContractSpec
  >["executeCaseInFlow"],
  classifyFailure: classifyBrowserFailure,
  renderTarget: renderBrowserTarget,
  artifacts: {
    markdown: (projection) => genericMarkdownPart(projection),
  },
  describePayload: describeBrowserPayload,
};
