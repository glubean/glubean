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
 * The Mode A executor is a resolved browser page client
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
import type {
  BrowserPageClient,
  InstrumentedPage,
} from "../page.js";

// =============================================================================
// Instance defaults (contract.browser.with)
// =============================================================================

/**
 * Defaults for a browser contract instance
 * (`contract.browser.with("name", {...})`).
 *
 * The `client` binding is the primary reason to use `.with`: supplying a
 * pre-configured `GlubeanBrowser` or `ExtensionBrowser` lets the adapter drive
 * it without rebuilding per contract. The client owns the real navigation
 * base URL (it was fixed at `browser({ baseUrl })` construction time); the
 * contract-level `baseUrl` here is **projection / display only** (mirrors
 * GraphQL `endpoint`).
 */
export interface BrowserContractDefaults<
  PageType extends InstrumentedPage = InstrumentedPage,
> {
  /** Default browser client for all contracts in this instance. */
  client?: BrowserPageClient<PageType>;
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
export interface BrowserStep<
  Input = void,
  PageType extends InstrumentedPage = InstrumentedPage,
> {
  id: string;
  /** Structured instruction. Part of the canonical hash (journey semantics). */
  intent: string;
  /**
   * Mode A executable replay. Receives the instrumented page, the case's
   * logical input (matching `needs`), and the test context (for
   * `ctx.secrets`, etc.). NOT part of the hash. Absent → Mode A marks the
   * case unimplemented and skips (Mode B unaffected — `intent` is enough).
   */
  action?: (page: PageType, input: Input, ctx: TestContext) => Promise<void>;
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
export interface BrowserContractCase<
  Input = void,
  PageType extends InstrumentedPage = InstrumentedPage,
> extends BaseCaseSpec {
  /** Per-case logical input schema (redeclares `BaseCaseSpec.needs`). */
  needs?: SchemaLike<Input>;

  /** Why this case exists — required. */
  description: string;

  /** Per-case entry path override (relative to the client baseUrl). */
  entry?: string;

  /** Mode B attention list (proposal §2.2). Projected; not in the hash. */
  agentNotes?: string[];

  /** Ordered journey steps. */
  steps: BrowserStep<Input, PageType>[];

  /** Fixed-questionnaire expectations (stable ids). */
  expect?: BrowserExpect[];

  /** Evidence screenshot strategy. Default `"final"`. */
  screenshot?: BrowserScreenshotStrategy;

  /** Per-case client override. */
  client?: BrowserPageClient<PageType>;

  /**
   * Escape hatch: custom assertions over the frozen evidence bundle. Mode A
   * only. Runs after the declared `expect` entries are judged. Receives the
   * case's logical input (matching `needs`) as the third argument, so a
   * verify can assert on it against the captured evidence (e.g. "the submitted
   * email appears in the sign-in request body").
   */
  verify?: (
    ctx: TestContext,
    evidence: BrowserEvidence,
    input: Input,
  ) => void | Promise<void>;
}

/**
 * Case factory for input-bearing browser cases. Captures `Input` at the
 * case's own const site so `steps[].action` / `verify` are checked against the
 * declared logical input instead of drifting from the `needs` schema (mirrors
 * `defineHttpCase` / `defineGraphqlCase`).
 *
 * @deprecated Use {@link browserCase} — same drift guard with zero explicit
 * generics. Before:
 * `defineBrowserCase<{ email: string }>({ needs: Schema, steps: [...] })`;
 * after: `browserCase(Schema)({ steps: [...] })`.
 *
 * One shape still needs this factory: a case declared OUTSIDE its contract, with
 * no per-case `client`, whose `action` must reach a non-default page capability
 * (e.g. `page.extension` on an `ExtensionPage`). `browserCase` infers `PageType`
 * from a value — the case's own `client`, or the enclosing contract — and a
 * standalone client-less case supplies neither, while `defineBrowserCase<Input,
 * ExtensionPage>` can still spell it out. Declaring the case inline in its
 * contract (the documented pattern) infers it and needs nothing explicit.
 */
export function defineBrowserCase<
  Input = void,
  PageType extends InstrumentedPage = InstrumentedPage,
>(
  c: BrowserContractCase<Input, PageType>,
): BrowserContractCase<Input, PageType> {
  return c;
}

/**
 * Case body for {@link browserCase} — `BrowserContractCase` WITHOUT `needs`;
 * the factory owns that field.
 *
 * `needs` is pinned to `never` rather than merely omitted: TypeScript runs no
 * excess-property check against a type parameter's CONSTRAINT, so a bare
 * `Omit<...>` would silently absorb a stray `needs` key into the inferred case
 * type and leave two competing declarations of the same schema. The `never`
 * makes writing a schema there a compile error at the offending property. An
 * explicit `needs: undefined` still passes — `exactOptionalPropertyTypes` is
 * off in this repo and it declares nothing anyway.
 *
 * `PageType` defaults to `InstrumentedPage`. {@link browserCase} infers it from
 * the case's own `client` or from the enclosing contract's `.with(...)` client;
 * a client passed as the contract SPEC's `client` does NOT reach it (see
 * {@link browserCase} for why, and for the two supported alternatives). Pass the
 * parameter explicitly when annotating a case body for a non-default page.
 */
export type BrowserCaseBody<
  N,
  PageType extends InstrumentedPage = InstrumentedPage,
> = Omit<BrowserContractCase<N, PageType>, "needs"> & { needs?: never };

/**
 * Curried browser case factory — {@link defineBrowserCase}'s needs-drift guard
 * with zero explicit generics. Prefer this.
 *
 * **Why curried.** TypeScript can't correlate sibling fields of one object
 * literal, so `needs: SchemaLike<X>` never types the `steps[].action` written
 * beside it — a factory has to capture `Input` first. But TS also has no PARTIAL
 * type-argument inference: the moment an author writes
 * `defineBrowserCase<Input>(...)`, every remaining type parameter falls back to
 * its default. Splitting the call in two leaves nothing to default — `N` is
 * inferred from the schema VALUE in the first call, `C` from the case literal in
 * the second (contextually typed by `BrowserCaseBody<N, P>`, which is what still
 * threads `N` into `action` / `verify`).
 *
 * What that buys over `defineBrowserCase`:
 * - **No explicit generics.** The schema is written once, as a value, and the
 *   whole case is checked against it.
 * - **Drift guard on the journey.** `steps[].action` and `verify` take the
 *   case's logical input, so destructuring a key that isn't on `N` is a compile
 *   error instead of an `undefined` typed into a form field at replay time.
 * - **One declaration site.** A `needs` SCHEMA inside the case literal is both a
 *   compile error (see {@link BrowserCaseBody}) and a runtime `Error`. The one
 *   tolerated form is an explicit `needs: undefined`, which declares nothing:
 *   `exactOptionalPropertyTypes` is off here, so `needs?: never` admits it, and
 *   every runtime reader already treats undefined as "no needs" — rejecting it
 *   would make the type layer and the runtime promise different things.
 *
 * **How `PageType` survives.** It is the one type parameter with no schema to
 * infer from, so it rides two value-shaped routes instead, and the return type
 * restates `steps` as `BrowserStep<N, P>[]` for exactly that reason — a `P` that
 * appeared only in `C`'s constraint would be unreachable by inference:
 * 1. the case's own `client` (hence the `& { client?: BrowserPageClient<P> }` on
 *    the parameter — an inference site for a VALUE the author already writes), or
 * 2. the enclosing contract: `contract.browser.with("x", { client: chrome })`
 *    fixes the factory's page type, which contextually types this call's return
 *    and pins `P` before the `action` bodies are checked.
 *
 * Restating `steps` costs the step literals' types, which nothing consumes —
 * core reads only `needs`.
 *
 * **Two shapes those routes do NOT cover** (both fall back to
 * `InstrumentedPage`; annotating an `action`'s `page` parameter more narrowly
 * cannot recover either, because parameter contravariance rejects it):
 * - A standalone, client-less case. Give the case a `client`, declare it inline
 *   in its contract, or keep `defineBrowserCase<Input, PageType>`.
 * - A client supplied as the CONTRACT SPEC's `client` — `journeys("id", {
 *   client: chrome, cases: { ... } })` — rather than on `.with(...)` or on the
 *   case. This route is fully supported at runtime, but `BrowserContractFactory`
 *   binds its page type when `.with(...)` is called, so by the time the spec
 *   literal is checked the type is already fixed and the spec's own `client` has
 *   no say. Making it an inference site requires a per-call type parameter on
 *   the factory, and that DEMOTES the page type to an unresolved type variable
 *   while `cases` is being contextually typed — which breaks route 2, the common
 *   one (measured: both a per-call parameter and an overload pair regressed
 *   `.with({ client })`). Until that is solved, pass the client to `.with(...)`.
 *   The case route does NOT substitute here: a case-level client types the case
 *   itself, but cannot widen the contract it is placed in — that contract's
 *   `cases` constraint wants an action accepting its own, wider page.
 *   `types.test-d.ts` pins all three behaviors so a future change cannot land
 *   silently.
 *
 * Runtime output is VALUE-IDENTICAL to the pre-migration shape — a case that
 * declared `needs` inline — because the factory only spreads the schema back
 * in. Migrating an existing case moves neither its projection nor its
 * `canonicalHash`.
 *
 * @example
 * ```ts
 * import { contract } from "@glubean/sdk";
 * import { browserCase } from "@glubean/browser";
 * import { z } from "zod";
 *
 * const signIn = browserCase(z.object({ email: z.string(), password: z.string() }))({
 *   description: "a returning user signs in",
 *   entry: "/login",
 *   steps: [
 *     {
 *       id: "submit",
 *       intent: "fill the credentials and submit the form",
 *       // `input` is { email: string; password: string } — inferred.
 *       action: async (page, { email, password }) => {
 *         await page.fill(page.byLabel("Email"), email);
 *         await page.fill(page.byLabel("Password"), password);
 *         await page.click(page.byRole("button", { name: "Sign in" }));
 *       },
 *     },
 *   ],
 *   expect: [{ id: "lands-on-dashboard", url: { path: "/dashboard" } }],
 * });
 *
 * const journeys = contract.browser.with("app", { client });
 * export const auth = journeys("auth.signIn", { cases: { signIn } });
 * ```
 *
 * @param needs The case's logical input schema — declared here, exactly once.
 *   Omit the argument entirely for a case with no logical input; that form
 *   returns the case unchanged and still rejects a literal `needs`.
 * @returns A function taking the case literal, returning it with `needs` attached.
 */
export function browserCase<N>(
  needs: SchemaLike<N>,
): <
  const C extends BrowserCaseBody<N, PageType>,
  PageType extends InstrumentedPage = InstrumentedPage,
>(
  c: C & { client?: BrowserPageClient<PageType> },
  // `Omit<C, "needs">` before the intersection, never a bare `C & {...}`: a case
  // written against the exported `BrowserCaseBody<X>` annotation carries the
  // `needs?: never` guard INTO `C`, and intersecting that with the required
  // `needs: SchemaLike<N>` collapses the property (and with it core's
  // `InferCaseInput`, and with THAT the whole `.case()` I/O chain) to `never`.
  // Dropping the guarded key first keeps every other property's literal type
  // intact. `steps` is restated for the `PageType` inference route documented
  // above.
) => Omit<C, "needs" | "steps"> & {
  needs: SchemaLike<N>;
  steps: BrowserStep<N, PageType>[];
};
export function browserCase(): <
  const C extends BrowserCaseBody<void, PageType>,
  PageType extends InstrumentedPage = InstrumentedPage,
>(
  c: C & { client?: BrowserPageClient<PageType> },
) => Omit<C, "steps"> & { steps: BrowserStep<void, PageType>[] };
export function browserCase(needs?: SchemaLike<unknown>) {
  // Keep JS consumers aligned with the type-level `needs?: never` — a literal
  // `needs` SCHEMA is a hard error in BOTH forms, so it always has exactly one
  // declaration site. The zero-arg form returns the case unchanged.
  //
  // The two overloads above are the checked authoring surface; this
  // implementation is untyped glue (a concrete param type is not compatible
  // with both of them).
  return (c: any) => {
    // Value check, NOT hasOwnProperty: `exactOptionalPropertyTypes` is off in
    // this repo, so `needs?: never` accepts an explicit `needs: undefined` and
    // the runtime must accept it too, or the two layers promise different
    // things. Tolerating it is safe because every runtime reader treats
    // undefined as "no needs declared" (core's §5.1 branches are falsy checks;
    // the projection records `hasNeeds: c.needs !== undefined`). In the schema
    // form the spread below overwrites the key anyway.
    if (c.needs !== undefined) {
      throw new Error(
        "browserCase: do not declare `needs` inside the case literal — the factory " +
          "owns that field. Declare it once as `browserCase(schema)({ ... })` and " +
          "remove `needs` from the case object.",
      );
    }
    return needs === undefined ? c : { ...c, needs };
  };
}

// =============================================================================
// Contract spec
// =============================================================================

/**
 * User-facing browser contract specification. Contract identity = contract id
 * (string) + case key.
 */
export interface BrowserContractSpec<
  // Each case carries its OWN logical input via `needs` (extracted per-case by
  // core's `InferCaseInput`), so the map is constrained to `BrowserContractCase<any>`
  // rather than a single shared `Input` — otherwise a contract mixing cases with
  // different `needs` (or any input-bearing case) fails to type-check. Same shape
  // as GraphQL/gRPC (`GraphqlContractCase<Vars, Res, any>`).
  Cases extends Record<string, BrowserContractCase<any, any>> = Record<
    string,
    BrowserContractCase<any>
  >,
  PageType extends InstrumentedPage = InstrumentedPage,
> {
  /** Browser page client for all cases, preserving its instrumented page type. */
  client?: BrowserPageClient<PageType>;

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
 * One projected expect — the JSON-safe SEMANTICS of an expect entry, not just
 * its id. Consumers (markdown, `glubean contracts`, Cloud, agent QA surfaces)
 * diff on these, so a change to `url.path` / `dom` / the `calls` target must be
 * visible even when the stable `id` is unchanged. The live `calls`
 * ContractCaseRef is flattened to `"contractId#caseKey"`.
 */
export interface ProjectedExpect {
  id: string;
  kind: "url" | "dom" | "calls" | "console" | "unknown";
  url?: UrlExpect;
  dom?: DomExpect;
  /** `"<contractId>#<caseKey>"` — the referenced contract.http case. */
  calls?: string;
  console?: ConsoleExpect;
}

/**
 * Per-case projection payload. Browser journeys have no request/response
 * schema the way HTTP does; the projectable surface is the journey skeleton
 * (intents + expects + agentNotes) plus a Mode-A runnability flag. All fields
 * are JSON-safe by construction, so `BrowserSafeSchemas` is identical.
 */
export interface BrowserPayloadSchemas {
  /** Effective entry path for the case. */
  entry?: string;
  /** Ordered step id + intent pairs (journey skeleton). */
  intents?: Array<{ id: string; intent: string }>;
  /** Declared expects (the fixed questionnaire) with their semantics. */
  expects?: ProjectedExpect[];
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
 * lens receives at runtime). Browser journeys return the frozen evidence
 * bundle.
 *
 * Flow-typing convention (matches GraphQL/gRPC): `journey.case(key)` resolves
 * its `res` type to `unknown`, not `BrowserEvidence`. Core's `ApplyCaseOutput`
 * only propagates a concrete `res` type for adapters whose `__caseOutputShape`
 * marker has a `body` field to replace per-case (that mechanism is HTTP-only —
 * only `HttpPayloadSchemas` declares the marker). Browser journeys have no
 * per-case response schema, so — exactly like `GraphqlFlowCaseOutput` /
 * `GrpcFlowCaseOutput` — this concrete type is exported for authors to annotate
 * a lens manually (`(s, res: BrowserFlowCaseOutput) => ...`); we deliberately
 * do NOT add a non-functional `__caseOutputShape` marker (it would still
 * resolve to `unknown` and only imply typing that isn't there).
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
  with: <PageType extends InstrumentedPage = InstrumentedPage>(
    instanceName: string,
    defaults?: BrowserContractDefaults<PageType>,
  ) => BrowserContractFactory<PageType>;
};

export type BrowserContractFactory<
  PageType extends InstrumentedPage = InstrumentedPage,
> = <
  Cases extends Record<string, BrowserContractCase<any, PageType>>,
>(
  id: string,
  spec: BrowserContractSpec<Cases, PageType>,
) => ProtocolContract<
  BrowserContractSpec<Cases, PageType>,
  BrowserSafeSchemas,
  BrowserContractMeta,
  Cases
>;

declare module "@glubean/sdk" {
  interface ContractProtocolRoots {
    browser: BrowserContractRoot;
  }
}
