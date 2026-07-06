/**
 * contract.browser types (Mode A minimal — GLU-212 / proposal
 * contract-browser-two-tier.md §2/§3).
 *
 * User-facing authoring types + adapter-level payload/meta types for the
 * browser contract adapter. Structure mirrors `packages/graphql/src/contract/
 * types.ts` where applicable, with browser-journey specifics:
 *
 *   - **One case = one decidable user journey.** A case owns an ordered list
 *     of `steps` (each an `intent` + optional `action`) and a fixed-question
 *     `expect[]` (stable ids). Contract identity = `contractId + caseKey`.
 *
 *   - **Two consumption modes, one spec.** Mode A (`glubean run`) replays the
 *     `action` functions with @glubean/browser and judges `expect`
 *     authoritatively (proposal §3). Mode B (agent self-QA) reads `intent` +
 *     `expect` + `agentNotes` and self-checks (proposal §2.3). This file
 *     carries BOTH surfaces; the adapter here only implements Mode A.
 *
 *   - **`action` is optional (P0-narrow → P1 progressive).** A step with no
 *     `action` cannot be replayed: Mode A marks the whole case *unimplemented*
 *     and skips it (a visible debt in the projection), Mode B is unaffected.
 *     `action` is a function field — projected-out of the canonical hash the
 *     same way HTTP `verify` / `body: () => ...` are (proposal §2.2 field
 *     ruling); `intent` IS part of the hash (journey semantic identity).
 *
 *   - **Minimal expect vocabulary (P1 scope, proposal §8 P1):**
 *     `url` / `dom` (visible/absent) / `calls` (references a contract.http
 *     case — the killer feature) / `console`. Richer matchers are deferred.
 *
 * The Mode A executor is the resolved `GlubeanBrowser` client
 * (`configure({ plugins: { chrome: browser({...}) } })`), supplied via
 * `contract.browser.with({ client })` — same "client injection through a
 * scoped instance" pattern as HTTP / GraphQL / gRPC.
 */

import type {
  BaseCaseSpec,
  ContractCaseRef,
  Extensions,
  ProtocolContract,
  SchemaLike,
  TestContext,
} from "@glubean/sdk";
import type { GlubeanBrowser, InstrumentedPage } from "../page.js";

// =============================================================================
// Instance defaults (contract.browser.with)
// =============================================================================

/**
 * Defaults for a browser contract instance
 * (`contract.browser.with("name", {...})`).
 *
 * The `client` binding is the primary reason to use `.with`: supplying a
 * pre-configured `GlubeanBrowser` lets the adapter drive it without rebuilding
 * per contract. The client owns the real navigation base URL (it was fixed at
 * `browser({ baseUrl })` construction time); the contract-level `baseUrl` here
 * is **projection / display only** (mirrors GraphQL `endpoint`).
 */
export interface BrowserContractDefaults {
  /** Default browser client for all contracts in this instance. */
  client?: GlubeanBrowser;
  /**
   * Base URL **for projection / display only.** Travels on `meta.baseUrl` so
   * the scanner / `glubean contracts` markdown / MCP / Cloud can show which
   * surface the journey targets. Real navigation resolves relative `entry`
   * paths through the `client`'s own baseUrl (fixed at client construction).
   */
  baseUrl?: string;
  /** Default entry path (relative to the client baseUrl) for cases. */
  entry?: string;
  /** Tags inherited by all contracts in this instance. */
  tags?: string[];
  /** Default feature grouping key. */
  feature?: string;
  /** Mode B attention list inherited by all contracts (proposal §2.2). */
  agentNotes?: string[];
  /** OpenAPI-style extensions (x-* keys). Inherited by all contracts. */
  extensions?: Extensions;
}

// =============================================================================
// Locator spec (shared by dom matchers)
// =============================================================================

/**
 * A declarative element locator. Exactly one primary selector strategy should
 * be set; `name` refines `role`. Mirrors the @glubean/browser page locator
 * helpers (`byRole` / `byText` / `byLabel` / `byTestId` / raw CSS `selector`).
 */
export interface BrowserLocatorSpec {
  /** Raw CSS selector (or puppeteer `::-p-*` selector). */
  selector?: string;
  /** ARIA role (maps to `page.byRole(role, { name })`). */
  role?: string;
  /** Accessible name — refines `role`. */
  name?: string;
  /** Visible text (maps to `page.byText`). */
  text?: string;
  /** Accessible label (maps to `page.byLabel`). */
  label?: string;
  /** `data-testid` value (maps to `page.byTestId`). */
  testId?: string;
}

// =============================================================================
// Expect vocabulary (P1 minimal — url / dom / calls / console)
// =============================================================================

/**
 * Terminal-URL expectation. `path` is matched against the URL's pathname
 * (exact, after the journey settles); an array is an allowed-set (any match
 * passes). `pattern` (a RegExp source string) is matched against the full URL.
 * `notPath` asserts the terminal pathname is none of the given paths.
 *
 * Authoring guidance (proposal RESULT.md #2): prefer an explicit `path` set
 * over vague "landed somewhere under the app" wording.
 */
export interface UrlExpect {
  path?: string | string[];
  pattern?: string;
  notPath?: string | string[];
}

/**
 * DOM expectation (P1 scope = visible / absent). `visible` asserts the locator
 * resolves to a visible element; `absent` asserts it resolves to none.
 * `containsText`, when paired with `visible`, additionally asserts the
 * element's text contains the substring.
 */
export interface DomExpect {
  visible?: BrowserLocatorSpec;
  absent?: BrowserLocatorSpec;
  containsText?: string;
}

/**
 * Console expectation. `errors` is the max number of **product-domain**
 * console errors allowed (default 0). `allow` lists substrings (matched
 * against the error message OR its source URL) that mark an error as
 * third-party / resource noise — excluded from the count (proposal
 * RESULT.md #3: product-domain API errors count as fail; only resource /
 * third-party errors are noise).
 */
export interface ConsoleExpect {
  errors?: number;
  allow?: string[];
}

/**
 * One expect entry — a stable `id` plus **exactly one** assertion kind. The
 * `id` is the fixed-questionnaire / coverage / cross-round-diff primary key
 * (proposal §2.2 — stable id array, no derived ids). The `never` guards make
 * "exactly one kind" a compile-time constraint.
 */
export type BrowserExpect = { id: string } & (
  | { url: UrlExpect; dom?: never; calls?: never; console?: never }
  | { dom: DomExpect; url?: never; calls?: never; console?: never }
  | {
      /**
       * The killer feature (proposal §3.1): assert the journey triggered a
       * specific backend `contract.http` case. Reference it via
       * `signInEmail.case("validStagingCredentials")`. Mode A judges against
       * the CDP network trace (method + normalized path template + status +
       * atLeastOnce, plus a schema check when the body is available).
       */
      calls: ContractCaseRef<unknown, unknown>;
      url?: never;
      dom?: never;
      console?: never;
    }
  | { console: ConsoleExpect; url?: never; dom?: never; calls?: never }
);

// =============================================================================
// Steps
// =============================================================================

/**
 * One journey step. `intent` is the structured instruction (Mode B's
 * execution directive AND the spec anchor an author/agent uses to repair
 * `action` when a replay drifts). `action` is the Mode A executable replay.
 */
export interface BrowserStep<Input = void> {
  id: string;
  /** Structured instruction. Part of the canonical hash (journey semantics). */
  intent: string;
  /**
   * Mode A executable replay. Receives the instrumented page, the case's
   * logical input (matching `needs`), and the test context (for
   * `ctx.secrets`, etc.). NOT part of the hash. Absent → Mode A marks the
   * case unimplemented and skips (Mode B unaffected — `intent` is enough).
   */
  action?: (page: InstrumentedPage, input: Input, ctx: TestContext) => Promise<void>;
}

// =============================================================================
// Evidence bundle (passed to `verify` and used by the judge)
// =============================================================================

/**
 * One observed network request (from the @glubean/browser network tracer,
 * which emits to `ctx.trace`). Redaction happens downstream in the runner/CLI
 * pipeline — this record carries raw bodies only in-process for judging.
 */
export interface BrowserTraceRecord {
  method: string;
  url: string;
  status: number;
  durationMs: number;
  requestBody?: unknown;
  responseBody?: unknown;
}

/** One observed `browser:console-error` event. */
export interface BrowserConsoleError {
  message: string;
  source?: string;
}

/**
 * Frozen evidence window for a completed journey — the input to `case.verify`
 * and the source the machine-judgeable expects (url/calls/console) read from.
 */
export interface BrowserEvidence {
  /** Network requests observed during the journey (entry nav → freeze). */
  network: BrowserTraceRecord[];
  /** Console errors observed during the journey. */
  consoleErrors: BrowserConsoleError[];
  /** The terminal URL after the journey settled. */
  finalUrl: string;
}

/** Evidence screenshot strategy for a case (proposal §2.2). */
export type BrowserScreenshotStrategy = "final" | "each-step" | "on-failure";

// =============================================================================
// Case spec
// =============================================================================

/**
 * One browser contract case (attachment-model v10). Function-valued fields
 * (`steps[].action`, `verify`) receive the case's **logical input** (matching
 * `needs`), NOT setup state — v10 has no per-case lifecycle; setup-style work
 * belongs to a `contract.bootstrap()` overlay.
 */
export interface BrowserContractCase<Input = void> extends BaseCaseSpec {
  /** Per-case logical input schema (redeclares `BaseCaseSpec.needs`). */
  needs?: SchemaLike<Input>;

  /** Why this case exists — required. */
  description: string;

  /** Per-case entry path override (relative to the client baseUrl). */
  entry?: string;

  /** Mode B attention list (proposal §2.2). Projected; not in the hash. */
  agentNotes?: string[];

  /** Ordered journey steps. */
  steps: BrowserStep<Input>[];

  /** Fixed-questionnaire expectations (stable ids). */
  expect?: BrowserExpect[];

  /** Evidence screenshot strategy. Default `"final"`. */
  screenshot?: BrowserScreenshotStrategy;

  /** Per-case client override. */
  client?: GlubeanBrowser;

  /**
   * Escape hatch: custom assertions over the frozen evidence bundle. Mode A
   * only. Runs after the declared `expect` entries are judged.
   */
  verify?: (ctx: TestContext, evidence: BrowserEvidence) => void | Promise<void>;
}

/**
 * Case factory for input-bearing browser cases. Captures `Input` at the
 * case's own const site so `steps[].action` / `verify` are checked against the
 * declared logical input instead of drifting from the `needs` schema (mirrors
 * `defineHttpCase` / `defineGraphqlCase`).
 */
export function defineBrowserCase<Input = void>(
  c: BrowserContractCase<Input>,
): BrowserContractCase<Input> {
  return c;
}

// =============================================================================
// Contract spec
// =============================================================================

/**
 * User-facing browser contract specification. Contract identity = contract id
 * (string) + case key.
 */
export interface BrowserContractSpec<
  Input = void,
  Cases extends Record<string, BrowserContractCase<Input>> = Record<
    string,
    BrowserContractCase<Input>
  >,
> {
  /** Browser client (resolved `GlubeanBrowser`) for all cases. */
  client?: GlubeanBrowser;

  /** Default entry path (relative to the client baseUrl) for cases. */
  entry?: string;

  /**
   * Base URL **for projection / display only** (travels on `meta.baseUrl`).
   * Real navigation resolves through the `client`'s own baseUrl — see
   * `BrowserContractDefaults.baseUrl`.
   */
  baseUrl?: string;

  description?: string;
  feature?: string;

  /** Contract-level Mode B attention list (merged under each case's). */
  agentNotes?: string[];

  tags?: string[];
  deprecated?: string;
  extensions?: Extensions;

  /** Named journey cases. */
  cases: Cases;
}

// =============================================================================
// Adapter payload schemas + meta
// =============================================================================

/**
 * Per-case projection payload. Browser journeys have no request/response
 * schema the way HTTP does; the projectable surface is the journey skeleton
 * (intents + expect ids + agentNotes) plus a Mode-A runnability flag. All
 * fields are JSON-safe by construction, so `BrowserSafeSchemas` is identical.
 */
export interface BrowserPayloadSchemas {
  /** Effective entry path for the case. */
  entry?: string;
  /** Ordered step id + intent pairs (journey skeleton). */
  intents?: Array<{ id: string; intent: string }>;
  /** Declared expect ids (the fixed questionnaire). */
  expectIds?: string[];
  /** Mode B attention list effective for the case. */
  agentNotes?: string[];
  /**
   * True iff every step has an `action` (Mode A can replay the whole
   * journey). False → the case is Mode-A *unimplemented* (visible debt).
   */
  hasActions?: boolean;
}

/** JSON-safe payload shape (identical — no live references). */
export type BrowserSafeSchemas = BrowserPayloadSchemas;

/** Runtime contract-level meta carried on the projection. */
export interface BrowserContractMeta {
  /** Base URL (display; may be undefined if client-owned). */
  baseUrl?: string;
  /** Default entry path. */
  entry?: string;
  /** Contract-level Mode B attention list. */
  agentNotes?: string[];
  /** Contract instance name (`contract.browser.with("name")`). */
  instanceName?: string;
}

/** JSON-safe meta (identical — no live references). */
export type BrowserContractSafeMeta = BrowserContractMeta;

/**
 * What `executeCaseInFlow` returns (and what a flow `step.out(state, res)`
 * lens receives). Browser journeys return the frozen evidence bundle.
 */
export type BrowserFlowCaseOutput = BrowserEvidence;

// =============================================================================
// Contract instance / root types
// =============================================================================

/**
 * Signature of `contract.browser.with("name", defaults)`. Returns a factory
 * that creates journey contracts under this instance's defaults. Direct
 * `contract.browser("id", spec)` is forbidden (client injection via a scoped
 * instance is the canonical pattern — same as HTTP / GraphQL / gRPC).
 */
export type BrowserContractRoot = {
  with: (
    instanceName: string,
    defaults?: BrowserContractDefaults,
  ) => BrowserContractFactory;
};

export type BrowserContractFactory = <
  Input,
  Cases extends Record<string, BrowserContractCase<Input>>,
>(
  id: string,
  spec: BrowserContractSpec<Input, Cases>,
) => ProtocolContract<
  BrowserContractSpec<Input, Cases>,
  BrowserSafeSchemas,
  BrowserContractMeta,
  Cases
>;

declare module "@glubean/sdk" {
  interface ContractProtocolRoots {
    browser: BrowserContractRoot;
  }
}
