/**
 * Core types for the protocol-agnostic contract system.
 *
 * This file defines:
 *   - Protocol-agnostic enums (lifecycle / severity / requires / defaultRun)
 *   - Failure classification types
 *   - ContractProtocolAdapter<Spec, Rt, RtM, Sf, SfM> interface
 *   - ContractProjection<RuntimeSchemas, RuntimeMeta> — Runtime (live objects OK)
 *   - ExtractedContractProjection<SafeSchemas, SafeMeta> — JSON-safe (downstream)
 *   - ProtocolContract<Spec, PayloadSchemas, Meta> — runtime carrier
 *   - Flow types — ContractCaseRef / FlowBuilder / FlowContract etc.
 *
 * Protocol-specific types (HttpContractSpec / HttpPayloadSchemas / etc.) live
 * in `./contract-http/types.ts`. Core code never imports from there; other
 * adapter plugins (gRPC / GraphQL / etc.) will follow the same pattern.
 *
 * See `internal/40-discovery/proposals/contract-generics-complete.md` v5
 * and `internal/40-discovery/proposals/contract-flow.md` v9 for design.
 */

import type { SchemaLike, Test, TestContext } from "./types.js";
import type {
  KnownArtifacts,
  KnownArtifactParts,
  KnownArtifactOptions,
} from "./index.js";

// =============================================================================
// Protocol-agnostic enums
// =============================================================================

/**
 * Case lifecycle.
 *
 * - `"active"` — executable, will run normally
 * - `"deferred"` — not yet executable (missing credentials, infrastructure)
 * - `"deprecated"` — retained for history but no longer executed
 */
export type CaseLifecycle = "active" | "deferred" | "deprecated";

/**
 * Case severity. Affects Cloud alert routing and projection diff weight.
 *
 * - `"critical"` — failure triggers immediate alert
 * - `"warning"` — failure is recorded but may not alert (default)
 * - `"info"` — informational check, failure does not trigger alerts
 */
export type CaseSeverity = "critical" | "warning" | "info";

/**
 * Physical capability required by a case or flow.
 *
 * - `"headless"` — fully automated, no human in loop (default)
 * - `"browser"` — needs a real browser (OAuth code flow, checkout, captcha)
 * - `"out-of-band"` — needs an out-of-band channel (email, SMS, webhook tunnel)
 */
export type CaseRequires = "headless" | "browser" | "out-of-band";

/**
 * Default run policy for a case or flow.
 *
 * - `"always"` — run whenever the runner satisfies `requires` (default)
 * - `"opt-in"` — skip unless explicitly requested (`--include-opt-in`)
 */
export type CaseDefaultRun = "always" | "opt-in";

// =============================================================================
// Extensions (OpenAPI-style x-* keys)
// =============================================================================

/**
 * OpenAPI-style extensions. Keys MUST start with "x-".
 * Non-x keys are rejected at the type level.
 */
export type Extensions = Record<`x-${string}`, unknown>;

// =============================================================================
// Failure classification
// =============================================================================

/**
 * Standardized failure classification kind. Protocol-agnostic.
 *
 * Open string type — adapters can extend with custom values.
 * Recommended: "auth", "permission", "not-found", "schema", "timeout",
 * "transport", "rate-limit", "business-rule", "unknown".
 */
export type FailureKind = string;

/**
 * Standardized failure classification.
 * Produced by protocol adapters or core. Consumed by repair loop, Cloud,
 * runner summary.
 */
export interface FailureClassification {
  kind: FailureKind;
  source: "assertion" | "trace" | "plugin";
  retryable?: boolean;
  message?: string;
}

// =============================================================================
// Case spec authoring base
// =============================================================================

/**
 * Minimum shape every case spec must satisfy. Adapter-specific case specs
 * (HttpContractCase / GrpcContractCase / GraphqlContractCase / ...) extend
 * this with protocol-specific fields.
 *
 * Core (`dispatchContract`) reads these fields directly from `spec.cases[key]`.
 * Adapter-specific fields are opaque to core and passed through to the adapter.
 *
 * @see contract-attachment-model.md v1.3 for `needs` / `given` / `runnability` semantics.
 */
export interface BaseCaseSpec {
  description?: string;

  /**
   * Logical input schema for the case. The only public input contract.
   * Protocol action fields (HTTP body/headers/params/query etc.) receive
   * this typed input as their argument.
   *
   * Typed as `SchemaLike<unknown>` at the base to accept any concrete
   * schema. The specific type is extracted per-case via `InferCaseInput<C>`
   * when `ProtocolContract.case<K>()` types its return — TS infers the
   * concrete T from the literal `SchemaLike<T>` the author wrote.
   *
   * This avoids a generic on `BaseCaseSpec<Needs>` which would force every
   * adapter's case type (ContractCase / GrpcContractCase / GraphqlContractCase)
   * to thread a Needs parameter through — too invasive for the authoring API.
   */
  needs?: SchemaLike<unknown>;

  /**
   * World-state precondition this case assumes. Projected as part of the
   * contract because it changes what `expect` means (see §0.9 of the
   * attachment model proposal). Bootstrap may *satisfy* `given` at
   * runtime, but it must not be the only place where a semantically
   * relevant precondition is declared.
   */
  given?: string;

  /**
   * Runnability metadata — grouped under `runnability` to make the
   * "not contract semantic" stance structurally visible. Fields here
   * do NOT enter contract projection; they enter runnable inventory.
   */
  runnability?: {
    requireAttachment?: boolean;
  };

  deferred?: string;
  deprecated?: string;
  severity?: CaseSeverity;
  requires?: CaseRequires;
  defaultRun?: CaseDefaultRun;
  tags?: string[];
  extensions?: Extensions;
}

// =============================================================================
// Standalone bootstrap context + attachment types
// =============================================================================

/**
 * Context passed to `bootstrap.run(ctx, params)`. Extends TestContext with
 * cleanup registration — cleanups run LIFO after standalone case execution,
 * even if case expect/verify fails.
 *
 * Flow NEVER invokes bootstrap, so StandaloneBootstrapContext only exists
 * for the standalone execution path.
 */
export interface StandaloneBootstrapContext extends TestContext {
  cleanup(fn: () => Promise<void> | void): void;
}

/**
 * Bootstrap spec. Plain function form is shorthand for structured form
 * with no `params`.
 *
 * Body is opaque (§4.2 attachment model); only `params` schema is projectable.
 */
export type Bootstrap<Params, Output> =
  | ((ctx: StandaloneBootstrapContext) => Promise<Output>)
  | {
      params?: SchemaLike<Params>;
      run: (
        ctx: StandaloneBootstrapContext,
        params: Params,
      ) => Promise<Output>;
    };

/**
 * Runtime marker carried by a registered bootstrap overlay. Scanner reads
 * the __glubean_type discriminator; runner consults the registry at
 * runnable resolution time.
 */
export interface BootstrapAttachment<Needs = void, Params = void> {
  readonly __glubean_type: "bootstrap-attachment";
  readonly testId: string;
  readonly __phantom_needs?: Needs;
  readonly __phantom_params?: Params;
}

// =============================================================================
// Case & contract projection (Runtime + Extracted)
// =============================================================================

/**
 * Protocol-agnostic case metadata. `schemas` is plugin-defined payload shape,
 * opaque to core.
 *
 * @template PayloadSchemas Plugin-defined payload shape (e.g. HttpPayloadSchemas).
 *   Same shape for every case in a contract; differences between cases live in
 *   the values, not in the type.
 * @template Meta Plugin-defined free-form metadata (opaque to core).
 */
export interface CaseMeta<PayloadSchemas = unknown, Meta = unknown> {
  key: string;
  description?: string;
  lifecycle: CaseLifecycle;
  severity: CaseSeverity;
  deferredReason?: string;
  deprecatedReason?: string;
  requires?: CaseRequires;
  defaultRun?: CaseDefaultRun;
  tags?: string[];
  extensions?: Extensions;

  /** Plugin-defined payload shape. Opaque to core. */
  schemas?: PayloadSchemas;

  /** Plugin-defined free-form metadata. Opaque to core. */
  meta?: Meta;
}

/**
 * Runtime contract projection — adapter.project() output.
 * Allowed to contain live objects (Zod schemas, class instances). Never crosses
 * a serialization boundary; adapter.normalize() converts to Extracted.
 */
export interface ContractProjection<PayloadSchemas = unknown, Meta = unknown> {
  protocol: string;
  target: string;
  description?: string;
  feature?: string;
  instanceName?: string;
  tags?: string[];
  extensions?: Extensions;
  deprecated?: string;

  cases: Array<CaseMeta<PayloadSchemas, Meta>>;

  /** Contract-level schemas (e.g. HTTP request body shared across cases). */
  schemas?: PayloadSchemas;

  /** Contract-level free-form metadata. */
  meta?: Meta;
}

/**
 * JSON-safe case metadata. Shape-identical to CaseMeta but `schemas` / `meta`
 * must be JSON-safe (plain objects / arrays / primitives). Produced by
 * adapter.normalize().
 */
export type ExtractedCaseMeta<
  SafeSchemas = unknown,
  SafeMeta = unknown,
> = CaseMeta<SafeSchemas, SafeMeta>;

/**
 * JSON-safe contract projection. Downstream (scanner / MCP / CLI / Cloud)
 * consume this. Includes `id` (injected by core).
 */
export interface ExtractedContractProjection<
  SafeSchemas = unknown,
  SafeMeta = unknown,
> {
  id: string;
  protocol: string;
  target: string;
  description?: string;
  feature?: string;
  instanceName?: string;
  tags?: string[];
  extensions?: Extensions;
  deprecated?: string;

  cases: Array<ExtractedCaseMeta<SafeSchemas, SafeMeta>>;

  schemas?: SafeSchemas;
  meta?: SafeMeta;
}

// =============================================================================
// ContractProtocolAdapter
// =============================================================================

/**
 * Protocol adapter interface. Implement to add support for a new protocol
 * (HTTP is built-in; gRPC / GraphQL etc. will be external plugins).
 *
 * @template Spec Adapter's input spec type (e.g. HttpContractSpec).
 * @template RuntimeSchemas Runtime payload shape (live objects allowed).
 * @template RuntimeMeta Runtime free-form meta (live objects allowed).
 * @template SafeSchemas JSON-safe payload shape (after normalize).
 * @template SafeMeta JSON-safe free-form meta.
 */
export interface ContractProtocolAdapter<
  Spec = unknown,
  RuntimeSchemas = unknown,
  RuntimeMeta = unknown,
  SafeSchemas = unknown,
  SafeMeta = unknown,
> {
  /**
   * Execute a single case. Called by the core dispatcher for each spec case.
   * Adapter does the full case lifecycle: setup → request/invoke → expect →
   * verify → teardown.
   *
   * **Legacy path** — uses case-local `setup` / `teardown` fields.
   * Replaced by `executeCase` in v10 attachment model (setup/teardown are
   * removed from contract case surface; state is provided via bootstrap
   * overlay or explicit input). Kept for backward compat during migration;
   * removed in Spike 2 Phase 2c.
   */
  execute: (
    ctx: TestContext,
    caseSpec: unknown,
    contractSpec: Spec,
  ) => Promise<void>;

  /**
   * Execute a single case in **standalone mode** with an already-resolved
   * logical input.
   *
   * Scope note: this method is **standalone-only**. Flow dispatch continues
   * to use `executeCaseInFlow` (below). The two paths coexist because flow
   * never invokes bootstrap (attachment model §14.0 non-negotiable invariant)
   * — if executeCase took `mode: "flow"`, it would imply flow could route
   * through here, which contradicts the invariant.
   *
   * v10 attachment model entry point. Core dispatcher calls this after:
   *   - resolving bootstrap overlay (if registered) to produce `resolvedInput`
   *   - OR receiving explicit `--input-json` / `input` from runner
   *   - validating against the case's `needs` schema
   *
   * Adapter responsibilities:
   *   1. Receive already-validated `resolvedInput` (no re-validation needed)
   *   2. Call function-valued action fields (body / headers / etc.) with the input
   *   3. Execute request / expect / verify
   *   4. No setup / teardown — those are gone in v10
   *
   * @see contract-attachment-model.md v1.3 §10.1
   * @see single-case-execution-api.md v1 §5
   */
  executeCase?: (options: {
    ctx: TestContext;
    contract: ProtocolContract<Spec, SafeSchemas, SafeMeta>;
    caseKey: string;
    /** Logical input already validated against `needs`. `void` when case has no needs. */
    resolvedInput: unknown;
  }) => Promise<void>;

  /**
   * Project the spec to a Runtime projection (may contain live schemas).
   *
   * **Invariant**: `project().cases[].key` must 1:1 match `spec.cases` keys.
   * Core validates this at registration time:
   *   - projected key not in spec.cases → hard error
   *   - spec.cases key not in projection → hard error
   *   - duplicate key → hard error
   *
   * The returned projection does NOT include `id` — core injects it.
   */
  project: (spec: Spec) => ContractProjection<RuntimeSchemas, RuntimeMeta>;

  /**
   * Optional: normalize a Runtime projection to JSON-safe Extracted form.
   * Called by scanner / MCP / CLI / Cloud.
   *
   * **Input is already `id`-injected** by core. Adapter just passes `id`
   * through to the returned object.
   *
   * If adapter does NOT implement normalize, downstream consumers see only a
   * protocol-agnostic skeleton (no `schemas` / `meta`). See `contract-flow.md`
   * §3.5.3 rule 3.
   */
  /**
   * Convert the runtime projection (may contain live refs like Zod schemas)
   * into the JSON-safe `Extracted` form consumed by downstream (scanner /
   * MCP / CLI / cloud). SDK's `dispatchContract` calls this unconditionally
   * at contract construction and stores the result on the carrier as
   * `_extracted` — scanner reads that directly. Adapter is responsible for
   * knowing which fields are schemas (convert Zod → JSON Schema) vs literal
   * example data (pass through) vs protocol-specific metadata that must
   * survive normalize (e.g. HTTP `security`).
   */
  normalize: (
    projection: ContractProjection<RuntimeSchemas, RuntimeMeta> & { id: string },
  ) => ExtractedContractProjection<SafeSchemas, SafeMeta>;

  /**
   * Optional: classify failure from error + event log.
   * Consumers: repair loop, Cloud alerts, runner summary.
   */
  classifyFailure?: (input: {
    error?: unknown;
    events: Array<{ type: string; data: Record<string, unknown> }>;
  }) => FailureClassification | undefined;

  /**
   * Artifact producers declared by this adapter. Each entry is a
   * per-contract renderer for a registered artifact kind (see
   * `@glubean/sdk`'s `ArtifactKind` + `renderArtifact` / `KnownArtifacts`).
   * Producers return the kind's Part type; cross-contract merging is the
   * kind's responsibility.
   *
   * Keyed by `ArtifactKind.name`. Third-party plugins add new keys by
   * augmenting `KnownArtifacts` / `KnownArtifactParts` / `KnownArtifactOptions`
   * at the package root via `declare module "@glubean/sdk"`.
   *
   * Replaces the deprecated per-adapter `toMarkdown?` / `toOpenApi?` hooks
   * (removed after v0.2.x) which polluted the generic interface with
   * protocol-specific artifacts (OpenAPI is HTTP-only).
   */
  artifacts?: {
    [K in keyof KnownArtifacts]?: (
      projection: ExtractedContractProjection<SafeSchemas, SafeMeta>,
      options?: KnownArtifactOptions[K],
    ) => KnownArtifactParts[K];
  };


  /**
   * Optional: render the `target` string for display. HTTP: "POST /users"
   * stays as-is. gRPC: "Greeter/SayHello" might become "Greeter.SayHello()".
   */
  renderTarget?: (target: string) => string;

  /**
   * Optional: produce a high-level payload summary for indexing / UI.
   * Input: already-normalized SafeSchemas. Used when full schemas would be
   * too heavy (e.g. index views).
   */
  describePayload?: (schemas: SafeSchemas) => PayloadDescriptor | undefined;

  /**
   * Optional: execute a single case as a flow step.
   *
   * Core has already:
   *   1. Computed `resolvedInputs` via `step.bindings.in(state)` (may be partial)
   *   2. Prepared current flow state
   *   3. Passed the live contract instance (access merged scoped-factory state
   *      via `contract._spec`)
   *
   * Adapter responsibilities:
   *   1. Deep-merge `resolvedInputs` into the case's static input fields
   *   2. Run case setup / request / expect / verify / case teardown
   *      (Rule 1: case teardown is step-local finally — see contract-flow §7.3)
   *   3. Return adapter-specific CaseOutput shape (HTTP: { status, headers, body })
   *
   * Not implemented = this protocol cannot be referenced in a flow.
   */
  executeCaseInFlow?: (input: {
    ctx: TestContext;
    contract: ProtocolContract<Spec, SafeSchemas, SafeMeta>;
    caseKey: string;
    resolvedInputs: unknown;
  }) => Promise<unknown>;

  /**
   * Optional: validate that a case can be referenced in a flow. Called by
   * ProtocolContract.case(key). HTTP's implementation rejects cases with
   * function-valued input fields (body/params/query/headers) because those
   * depend on case-local setup state unavailable in flow mode. See
   * contract-flow v9 §5.1.1 for rationale.
   *
   * Throws on invalid case; returns undefined on success.
   */
  validateCaseForFlow?: (
    spec: Spec,
    caseKey: string,
    contractId: string,
  ) => void;
}

/**
 * Protocol-agnostic payload summary. Adapter-provided via describePayload.
 * Free-form — common keys: "hasRequest", "hasResponse", "contentType",
 * "messageCount", "streaming".
 */
export interface PayloadDescriptor {
  hasRequest?: boolean;
  hasResponse?: boolean;
  [key: string]: unknown;
}

// =============================================================================
// ProtocolContract (runtime carrier)
// =============================================================================

/**
 * Runtime contract object returned by `contract[protocol](id, spec)`.
 * Extends Array<Test> so runner/resolve iterate it directly.
 *
 * @template Spec Adapter's spec type — executable info stored in `_spec`.
 * @template PayloadSchemas Runtime (live) payload shape.
 * @template Meta Runtime free-form meta.
 */
export interface ProtocolContract<
  Spec = unknown,
  PayloadSchemas = unknown,
  Meta = unknown,
  Cases extends Record<string, unknown> = Record<string, unknown>,
> extends Array<Test> {
  /**
   * Runtime projection with `id` injected by core. Consumers duck-type this.
   */
  readonly _projection: ContractProjection<PayloadSchemas, Meta> & { id: string };

  /**
   * JSON-safe extracted projection — result of `adapter.normalize(_projection)`,
   * computed by the dispatcher at contract construction. Scanner / MCP / CLI
   * / cloud read this field directly as the canonical safe form. Never
   * contains live refs (Zod schemas converted to plain JSON Schema etc.).
   *
   * Typed with the same generic slot as `_projection` for structural
   * compatibility; at runtime it is always the Safe shape produced by
   * the adapter's `normalize`.
   */
  readonly _extracted: ExtractedContractProjection<PayloadSchemas, Meta> & { id: string };

  /**
   * Adapter-private runtime spec carrier. Holds the merged executable spec
   * (scoped-factory defaults + contract spec) used by `executeCaseInFlow`
   * and any adapter-internal helpers.
   *
   * Core never inspects this field. Adapter writes it at construction, reads
   * it during execution.
   */
  readonly _spec: Spec;

  /**
   * Return a ContractCaseRef for use in `contract.flow(...).step(...)`.
   *
   * Runtime validation: adapter's `.case(key)` implementation MUST fail-fast
   * if the case contains function-valued input fields (body/params/query/
   * headers as functions). Function fields reference case-local setup state
   * which is not available in flow mode. See contract-flow §5.1.1.
   */
  case<K extends keyof Cases & string>(
    key: K,
  ): ContractCaseRef<
    InferCaseInput<Cases[K]>,
    InferOutput<PayloadSchemas>
  >;
}

/**
 * Adapter-defined helper: extract the "case inputs" shape from PayloadSchemas.
 * Each adapter exports its own version (HTTP adapter defines InferHttpInputs).
 * Used by `.case()` return type to give lens functions TS autocomplete.
 *
 * The contract-level `PayloadSchemas` is the same for every case; I/O shape
 * differences between cases live in values, not types.
 *
 * This is a default fallback — adapters override via module augmentation or
 * direct typing of their own ContractCaseRef.
 */
export type InferInputs<_PayloadSchemas> = unknown;

/**
 * Extract per-case logical input type from a case spec's `needs` field.
 *
 * Works for any case spec that extends `BaseCaseSpec<Needs>` and declares
 * `needs: SchemaLike<T>`. Returns `void` for cases without `needs`.
 *
 * Used by `ProtocolContract.case<K>()` to infer `ContractCaseRef<Needs, ...>`
 * per-case, so `contract.bootstrap(ref, { run: ... })` can type-check the
 * run return against the specific case's Needs.
 *
 * @see contract-attachment-model.md v1.3 §4.1 / §5.3
 * @see Spike 0 Finding 2 — requires `any` (not `unknown`) in don't-care slot
 *      for contravariant positions.
 */
export type InferCaseInput<C> = C extends {
  needs?: SchemaLike<infer N>;
}
  ? unknown extends N
    ? void
    : N
  : void;

/** Adapter-defined helper: extract the "case output" shape from PayloadSchemas. */
export type InferOutput<_PayloadSchemas> = unknown;

// =============================================================================
// Flow types
// =============================================================================

/**
 * Opaque reference to a single case of a contract. Produced by
 * `ProtocolContract.case(key)`. Used as input to `FlowBuilder.step(...)`.
 *
 * The generic parameters carry type information for lens TS inference; at
 * runtime the ref only holds identification strings + the live contract ref.
 */
export interface ContractCaseRef<
  CaseInputs = unknown,
  CaseOutput = unknown,
> {
  readonly __glubean_type: "contract-case-ref";
  readonly contractId: string;
  readonly caseKey: string;
  readonly protocol: string;
  readonly target: string;

  /** Live ProtocolContract instance — flow runtime uses this, not contractId lookup. */
  readonly contract: ProtocolContract<any, any, any>;

  /** Phantom fields — do not populate at runtime. TS-only. */
  readonly __phantom_inputs?: CaseInputs;
  readonly __phantom_output?: CaseOutput;
}

/** Contract-level metadata for a flow (set via `.meta()`). */
export interface FlowMeta {
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
  extensions?: Extensions;
  /**
   * Mark this flow as skipped at run time. Value is the skip reason
   * displayed in reports. Useful for illustrative examples that should
   * be discoverable (for scanner extraction / docs rendering) but must
   * not attempt live HTTP calls.
   *
   * Mirrors `TestMeta.skip`.
   */
  skip?: string;
  /**
   * Mark this flow as focused. When any flows/tests in a run are `only`,
   * non-focused ones may be excluded. Mirrors `TestMeta.only`.
   */
  only?: boolean;
}

/**
 * Field dependency / mapping produced by Proxy dry-run of a lens function.
 * Consumed by downstream (MCP/CLI/Cloud) to render flow data-flow diagrams.
 */
export interface FieldMapping {
  /** Destination path (within step inputs or flow state). */
  target: string;
  /** Source — a path in state/response, a literal, or pass-through. */
  source:
    | { kind: "path"; path: string }
    | { kind: "literal"; value: unknown }
    | { kind: "pass-through" };
}

// --- Runtime (live) ----------------------------------------------------------

/**
 * Runtime flow step — discriminated union.
 * kind "contract-call" = a ContractCaseRef with bindings (Rule 1 teardown applies).
 * kind "compute" = a pure sync data-transform function (no adapter, no teardown).
 */
export type RuntimeFlowStep = RuntimeContractCallStep | RuntimeComputeStep;

export interface RuntimeContractCallStep {
  kind: "contract-call";
  name?: string;
  ref: ContractCaseRef;
  caseKey: string;
  /** Live contract instance (mirrors ref.contract, kept for direct access). */
  contract: ProtocolContract<any, any, any>;
  bindings?: {
    in?: (state: any) => any;
    out?: (state: any, response: any) => any;
  };
}

export interface RuntimeComputeStep {
  kind: "compute";
  name?: string;
  /**
   * Synchronous pure function. NOT subject to lens Proxy purity — may use
   * template literals / method calls / .map(). MUST be synchronous and
   * MUST NOT return a thenable (enforced at runtime).
   */
  fn: (state: any) => any;
}

/**
 * Runtime flow projection. Carries live callbacks + live contract refs.
 * Never crosses serialization boundaries. `normalizeFlow()` converts to
 * ExtractedFlowProjection for downstream consumers.
 */
export interface RuntimeFlowProjection<State = unknown> {
  protocol: "flow";
  description?: string;
  tags?: string[];
  extensions?: Extensions;

  /** Live flow-level setup callback (only I/O-capable callback in flow). */
  setup?: (ctx: TestContext) => Promise<State>;

  /** Live flow-level teardown callback. Rule 2: outer finally. */
  teardown?: (ctx: TestContext, state: State) => Promise<void>;

  steps: RuntimeFlowStep[];
}

// --- Extracted (JSON-safe) ---------------------------------------------------

/**
 * Extracted flow step — discriminated union, JSON-safe.
 */
export type ExtractedFlowStep =
  | ExtractedContractCallStep
  | ExtractedComputeStep;

export interface ExtractedContractCallStep {
  kind: "contract-call";
  name?: string;
  contractId: string;
  caseKey: string;
  protocol: string;
  target: string;
  /** Proxy dry-run output — input mappings. */
  inputs?: FieldMapping[];
  /** Proxy dry-run output — state update mappings. */
  outputs?: FieldMapping[];
}

export interface ExtractedComputeStep {
  kind: "compute";
  name?: string;
  /** Top-level state paths read (from Proxy dry-run). */
  reads: string[];
  /** Top-level state keys written (keys of returned object). */
  writes: string[];
}

/**
 * JSON-safe flow projection. Downstream (scanner / MCP / CLI / Cloud) consume
 * this. Produced by `normalizeFlow(runtime)`.
 */
export interface ExtractedFlowProjection {
  id: string;
  protocol: "flow";
  description?: string;
  tags?: string[];
  extensions?: Extensions;
  /** Present when flow has a setup callback (state source is dynamic). */
  setupDynamic?: true;
  steps: ExtractedFlowStep[];
}

// --- FlowBuilder / FlowContract ----------------------------------------------

/**
 * Builder for `contract.flow(id)`. State chain threads through `.step()` /
 * `.compute()` via TypeScript generics.
 */
export interface FlowBuilder<State = unknown> {
  readonly __glubean_type: "flow-builder";

  meta(m: Omit<FlowMeta, "id">): FlowBuilder<State>;

  /**
   * Flow-level setup — the ONLY I/O-capable callback in a flow. May be async,
   * may read ctx, may call external services. Returns the initial state.
   */
  setup<NewState>(
    fn: (ctx: TestContext) => Promise<NewState>,
  ): FlowBuilder<NewState>;

  /**
   * Add a contract-call step. `bindings.in` and `bindings.out` MUST be pure
   * lens functions (select / repack only; no I/O, no method calls, no
   * branching). Lens purity is enforced at Proxy dry-run time during
   * projection extraction.
   */
  step<CaseInputs, CaseOutput, NewState = State>(
    ref: ContractCaseRef<CaseInputs, CaseOutput>,
    bindings?: {
      in?: (state: State) => CaseInputs;
      out?: (state: State, response: CaseOutput) => NewState;
      name?: string;
    },
  ): FlowBuilder<NewState>;

  /**
   * Add a pure synchronous data-transform step. Accepts any synchronous TS
   * expression (template literals, method calls, .map()). Projection records
   * only read/write dependencies, NOT the formula.
   *
   * Runtime enforcement: throws if `fn` is async or returns a thenable.
   */
  compute<NewState>(fn: (state: State) => NewState): FlowBuilder<NewState>;

  /**
   * Flow-level teardown — runs in Rule 2 outer-finally, receives last-
   * committed state. If flow.setup threw, teardown does NOT run.
   */
  teardown(
    fn: (ctx: TestContext, state: State) => Promise<void>,
  ): FlowBuilder<State>;

  build(): FlowContract<State>;
}

/**
 * Runtime flow contract. Extends Array<Test> so runner iterates directly.
 * The single Test inside orchestrates setup → steps → teardown via runFlow.
 */
export interface FlowContract<State = unknown> extends Array<Test> {
  readonly _flow: RuntimeFlowProjection<State> & { id: string };
  /**
   * Pre-computed JSON-safe extracted projection. Populated by the flow
   * builder via `normalizeFlow(_flow)` so downstream consumers (scanner,
   * CLI, MCP, Cloud) don't need to import the SDK to get field mappings
   * for `.step()` lenses and reads/writes for `.compute()` nodes.
   */
  readonly _extracted: ExtractedFlowProjection;
}

// =============================================================================
// Registry metadata (embedded in RegisteredTestMeta.contract / .flow)
// =============================================================================

/**
 * Contract registry metadata attached to tests produced by `contract[protocol]()`.
 * Mirrored by `RegisteredTestMeta.contract` in types.ts.
 */
export interface ContractRegistryMeta {
  /** Protocol-agnostic target. HTTP: "POST /users", gRPC: "Greeter/SayHello". */
  target: string;
  /** Protocol identifier. */
  protocol: string;
  /** Case key within the contract. */
  caseKey: string;
  lifecycle: CaseLifecycle;
  severity: CaseSeverity;
  instanceName?: string;
  /**
   * Adapter.describePayload() output — protocol-agnostic payload overview.
   * Optional because describePayload is optional.
   */
  payloadSummary?: PayloadDescriptor;
  /** Plugin-defined free-form meta; core does not inspect. */
  meta?: unknown;
}

/**
 * Flow registry metadata attached to the single Test generated by
 * `contract.flow()`. Mirrored by `RegisteredTestMeta.flow` in types.ts.
 */
export interface FlowRegistryMeta {
  id: string;
  description?: string;
  tags?: string[];
  /** Flattened step descriptors (same shape as ExtractedFlowStep). */
  steps: Array<{
    kind: "contract-call" | "compute";
    name?: string;
    contractId?: string;
    caseKey?: string;
    protocol?: string;
    target?: string;
    inputs?: FieldMapping[];
    outputs?: FieldMapping[];
    reads?: string[];
    writes?: string[];
  }>;
  setupDynamic?: true;
}
