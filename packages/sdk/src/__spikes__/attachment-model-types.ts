/**
 * Spike 0 — Attachment Model Type Spike (v10)
 *
 * Proposal: internal/40-discovery/proposals/contract-attachment-model.md v1.3
 * Execution log: internal/30-execution/2026-04-24-attachment-model-spike-0/
 *
 * Goal: prove in TypeScript that the attachment-model types work without
 * `any` leakage. No runtime code. Excluded from `tsconfig.build.json`.
 *
 * All types are declared self-contained here (no imports from production
 * types) to isolate noise. This is a throwaway proof; Spike 2 will put
 * the real types in production locations.
 *
 * Verification:
 *   pnpm --filter @glubean/sdk exec -- tsc --noEmit 2>&1
 *
 * Expected:
 *   - Positive cases (P1..P7) compile clean
 *   - Negative cases (N1..N9) each produce an error consumed by
 *     `@ts-expect-error` (if an expected error doesn't occur, TS flags
 *     the unused directive — that's the failure signal)
 *   - Zero `any` in author-facing examples
 */

// =============================================================================
// 1. Protocol-agnostic base
// =============================================================================

// A structural stand-in for zod / valibot / json-schema. Extracting `T`
// via `SchemaLike<infer T>` is the pattern used in production SDK.
interface SchemaLike<T> {
  readonly __type?: T; // phantom to carry T; real impl has parse/validate
}

// Minimal schema factory for spike purposes (no zod dep).
function schema<T>(): SchemaLike<T> {
  return {} as SchemaLike<T>;
}

type CaseSeverity = "critical" | "warning" | "info";
type CaseRequires = "headless" | "browser" | "out-of-band";
type CaseDefaultRun = "always" | "opt-in";
type Extensions = Record<`x-${string}`, unknown>;

interface TestContext {
  // placeholder — real TestContext has env / http / log etc.
  log(msg: string): void;
}

interface StandaloneBootstrapContext extends TestContext {
  cleanup(fn: () => Promise<void> | void): void;
}

// =============================================================================
// 2. BaseCaseSpec — semantic surface + runnability metadata
// =============================================================================

interface BaseCaseSpec<Needs = void> {
  description: string;

  // Contract semantic — projected
  needs?: SchemaLike<Needs>;
  given?: string; // world-state precondition (§0.9 principle)

  // Runnability metadata — nested to make non-semantic stance visible
  runnability?: {
    requireAttachment?: boolean;
  };

  // Standard metadata (unchanged from v1–v9)
  deferred?: string;
  deprecated?: string;
  severity?: CaseSeverity;
  requires?: CaseRequires;
  defaultRun?: CaseDefaultRun;
  tags?: string[];
  extensions?: Extensions;
}

// =============================================================================
// 3. Bootstrap + BootstrapAttachment
// =============================================================================

type Bootstrap<Params, Output> =
  | ((ctx: StandaloneBootstrapContext) => Promise<Output>)
  | {
      params?: SchemaLike<Params>;
      run: (
        ctx: StandaloneBootstrapContext,
        params: Params,
      ) => Promise<Output>;
    };

interface BootstrapAttachment<Needs = void, Params = void> {
  readonly __glubean_type: "bootstrap-attachment";
  readonly testId: string;
  readonly __phantom_needs?: Needs;
  readonly __phantom_params?: Params;
}

// =============================================================================
// 4. HTTP as reference protocol
// =============================================================================

interface HttpExpect<Res> {
  status: number;
  body?: Res;
  headers?: Record<string, string>;
}

interface HttpContractCase<Res = unknown, Needs = void>
  extends BaseCaseSpec<Needs> {
  expect: HttpExpect<Res>;
  body?: unknown | ((input: Needs) => unknown);
  params?:
    | Record<string, string>
    | ((input: Needs) => Record<string, string>);
  query?:
    | Record<string, string>
    | ((input: Needs) => Record<string, string>);
  headers?:
    | Record<string, string>
    | ((input: Needs) => Record<string, string>);
  verify?: (ctx: TestContext, res: Res) => Promise<void>;
}

// Cases constraint uses `HttpContractCase<any, any>` so that per-case
// Res/Needs generics propagate instead of collapsing to defaults.
// `unknown` in the constraint would cause contravariant positions
// (body/headers/params input) to collapse to `void`.
interface HttpContractSpec<
  Cases extends Record<string, HttpContractCase<any, any>> = Record<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    HttpContractCase<any, any>
  >,
> {
  endpoint: string;
  cases: Cases;
  tags?: string[];
  description?: string;
}

// =============================================================================
// 5. ContractCaseRef + ProtocolContract (with Cases generic preserved)
// =============================================================================

interface ContractCaseRef<CaseInput = void, CaseOutput = unknown> {
  readonly __glubean_type: "contract-case-ref";
  readonly contractId: string;
  readonly caseKey: string;
  readonly protocol: string;
  readonly target: string;
  readonly runnability?: {
    requireAttachment?: boolean;
  };
  readonly __phantom_input?: CaseInput;
  readonly __phantom_output?: CaseOutput;
}

// Helpers to infer per-case Needs / Res from a Cases map entry.
// `any` in the don't-care position is deliberate: `Needs` sits in a
// contravariant (parameter) slot, so `unknown` in the conditional would
// fail to match a concrete Needs type. `any` is bivariant and matches.
type InferCaseNeeds<C> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  C extends HttpContractCase<any, infer N> ? N : never;
type InferCaseRes<C> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  C extends HttpContractCase<infer R, any> ? R : never;

interface ProtocolContract<
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _Spec,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _Schemas,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _Meta,
  Cases extends Record<string, unknown> = Record<string, unknown>,
> {
  case<K extends keyof Cases & string>(
    key: K,
  ): ContractCaseRef<InferCaseNeeds<Cases[K]>, InferCaseRes<Cases[K]>>;
}

// =============================================================================
// 6. FlowBuilder
// =============================================================================

interface FlowBuilder<State = unknown> {
  // Overload 1: case has no logical input (CaseInput = void). No `in` required.
  step<CaseOutput, NewState = State>(
    ref: ContractCaseRef<void, CaseOutput>,
    bindings?: {
      out?: (state: State, response: CaseOutput) => NewState;
      name?: string;
    },
  ): FlowBuilder<NewState>;

  // Overload 2: case has typed input. `in` is REQUIRED.
  step<CaseInput, CaseOutput, NewState = State>(
    ref: ContractCaseRef<CaseInput, CaseOutput>,
    bindings: {
      in: (state: State) => CaseInput;
      out?: (state: State, response: CaseOutput) => NewState;
      name?: string;
    },
  ): FlowBuilder<NewState>;

  setup<SetupState>(
    fn: (ctx: TestContext) => Promise<SetupState>,
  ): FlowBuilder<SetupState>;

  teardown(
    fn: (ctx: TestContext, state: State) => Promise<void>,
  ): FlowBuilder<State>;
}

// =============================================================================
// 7. Factory surface
// =============================================================================

interface HttpSchemas {
  _tag: "http";
}
interface HttpMeta {
  _tag: "http";
}

declare const contract: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  http<Cases extends Record<string, HttpContractCase<any, any>>>(
    id: string,
    spec: HttpContractSpec<Cases>,
  ): ProtocolContract<HttpContractSpec<Cases>, HttpSchemas, HttpMeta, Cases>;

  // bootstrap's Output must be exactly `Needs`, not `Needs | void`. The
  // `| void` form was allowing non-void Needs cases to return arbitrary
  // shapes (void branch silently matched anything).
  //
  // `NoInfer<Needs>` is critical: without it, TS does multi-site inference
  // — `Needs` appears in `ref` AND in `spec.run`'s return position, and TS
  // merges inferences from both, silently accepting wrong return shapes.
  // NoInfer pins `Needs` to what ref dictated; spec is checked against
  // that fixed Needs, not reverse-inferring.
  bootstrap<Needs, Params = void>(
    ref: ContractCaseRef<Needs, unknown>,
    spec: Bootstrap<Params, NoInfer<Needs>>,
  ): BootstrapAttachment<Needs, Params>;

  flow(id: string): FlowBuilder<Record<string, never>>;
};

// =============================================================================
// POSITIVE CASES (must compile clean)
// =============================================================================

// -----------------------------------------------------------------------------
// P1: HTTP case with `needs`, using inferred type in action fields
// -----------------------------------------------------------------------------
const p1_getProject = contract.http("project.get", {
  endpoint: "GET /projects/:projectId",
  cases: {
    success: {
      description: "fetches an existing project",
      needs: schema<{ token: string; projectId: string }>(),
      headers: ({ token }) => ({ Authorization: `Bearer ${token}` }),
      params: ({ projectId }) => ({ projectId }),
      expect: { status: 200 },
    } satisfies HttpContractCase<unknown, { token: string; projectId: string }>,
  },
});

// P1 proof: .case("success") returns ref with inferred Needs
const p1_ref = p1_getProject.case("success");
// Expected: ContractCaseRef<{ token: string; projectId: string }, unknown>
// (We don't assert the exact type here; the downstream flow step does.)

// -----------------------------------------------------------------------------
// P2: contract.bootstrap plain form
// -----------------------------------------------------------------------------
const p2_overlay = contract.bootstrap(p1_ref, async (_ctx) => ({
  token: "real-token",
  projectId: "p_1",
}));
void p2_overlay;

// -----------------------------------------------------------------------------
// P3: contract.bootstrap structured form with params
// -----------------------------------------------------------------------------
const p3_overlay = contract.bootstrap(p1_ref, {
  params: schema<{ projectId: string }>(),
  run: async (_ctx, { projectId }) => {
    return { token: "t", projectId };
  },
});
void p3_overlay;

// -----------------------------------------------------------------------------
// P4: contract.bootstrap structured form without params (void Params)
// -----------------------------------------------------------------------------
const p4_overlay = contract.bootstrap(p1_ref, {
  run: async (_ctx) => {
    return { token: "t", projectId: "p" };
  },
});
void p4_overlay;

// -----------------------------------------------------------------------------
// P5: flow.step(needsCaseRef, { in }) — in required and type-checked
// -----------------------------------------------------------------------------
declare const p5_login: ProtocolContract<
  unknown,
  HttpSchemas,
  HttpMeta,
  {
    success: HttpContractCase<{ token: string }, { username: string }>;
  }
>;
const p5_loginRef = p5_login.case("success");

const p5_flow = contract
  .flow("checkout")
  .step(p5_loginRef, {
    in: () => ({ username: "alice" }),
    out: (_s, res) => ({ token: res.token }),
  })
  .step(p1_ref, {
    in: (s) => ({ token: s.token, projectId: "p_1" }),
  });
void p5_flow;

// -----------------------------------------------------------------------------
// P6: flow.step(noInputCaseRef) — no bindings required
// -----------------------------------------------------------------------------
declare const p6_health: ProtocolContract<
  unknown,
  HttpSchemas,
  HttpMeta,
  {
    ok: HttpContractCase<{ status: "ok" }, void>;
  }
>;
const p6_healthRef = p6_health.case("ok");

const p6_flow = contract.flow("smoke").step(p6_healthRef);
void p6_flow;

// -----------------------------------------------------------------------------
// P7: flow.step(noInputCaseRef, { out: ... }) — out only, no in
// -----------------------------------------------------------------------------
const p7_flow = contract.flow("smoke").step(p6_healthRef, {
  out: (_s, res) => ({ lastStatus: res.status }),
});
void p7_flow;

// =============================================================================
// NEGATIVE CASES (must fail to compile; verified via @ts-expect-error)
// =============================================================================

// -----------------------------------------------------------------------------
// N1: Contract case declares `setup` — should be rejected
// -----------------------------------------------------------------------------
// Excess property check requires explicit `satisfies` or literal context.
const n1_spec = {
  endpoint: "GET /x",
  cases: {
    success: {
      description: "n1",
      expect: { status: 200 },
      // @ts-expect-error — `setup` is not in HttpContractCase
      setup: async () => ({}),
    },
  },
} satisfies HttpContractSpec<Record<string, HttpContractCase>>;
void n1_spec;

// -----------------------------------------------------------------------------
// N2: Contract case declares `teardown` — should be rejected
// -----------------------------------------------------------------------------
const n2_spec = {
  endpoint: "GET /x",
  cases: {
    success: {
      description: "n2",
      expect: { status: 200 },
      // @ts-expect-error — `teardown` is not in HttpContractCase
      teardown: async () => {},
    },
  },
} satisfies HttpContractSpec<Record<string, HttpContractCase>>;
void n2_spec;

// -----------------------------------------------------------------------------
// N3: Contract case declares `bootstrap` as a field — should be rejected
// -----------------------------------------------------------------------------
const n3_spec = {
  endpoint: "GET /x",
  cases: {
    success: {
      description: "n3",
      expect: { status: 200 },
      // @ts-expect-error — `bootstrap` is not in HttpContractCase; use contract.bootstrap()
      bootstrap: async () => ({}),
    },
  },
} satisfies HttpContractSpec<Record<string, HttpContractCase>>;
void n3_spec;

// -----------------------------------------------------------------------------
// N4: Contract case declares top-level `requireAttachment` (outside runnability)
// -----------------------------------------------------------------------------
const n4_spec = {
  endpoint: "GET /x",
  cases: {
    success: {
      description: "n4",
      expect: { status: 200 },
      // @ts-expect-error — must be `runnability.requireAttachment`
      requireAttachment: true,
    },
  },
} satisfies HttpContractSpec<Record<string, HttpContractCase>>;
void n4_spec;

// -----------------------------------------------------------------------------
// N5: bootstrap.run returns wrong shape for Needs
// -----------------------------------------------------------------------------
declare const n5_ref: ContractCaseRef<{ token: string; projectId: string }, unknown>;
const n5_overlay = contract.bootstrap(n5_ref, {
  // @ts-expect-error — run's return `{ token }` missing `projectId`; does not satisfy Needs
  run: async (_ctx) => ({ token: "t" }),
});
void n5_overlay;

// -----------------------------------------------------------------------------
// N6: FlowBuilder.step(bootstrapAttachment) — attachment is not a valid ref
// -----------------------------------------------------------------------------
declare const n6_attachment: BootstrapAttachment<
  { token: string },
  { projectId: string }
>;
// @ts-expect-error — BootstrapAttachment is not a ContractCaseRef
const n6_bad = contract.flow("bad").step(n6_attachment);
void n6_bad;

// -----------------------------------------------------------------------------
// N7: FlowBuilder.step(needsCaseRef) without bindings — `in` required
// -----------------------------------------------------------------------------
declare const n7_needsRef: ContractCaseRef<
  { token: string },
  { profile: { name: string } }
>;
// @ts-expect-error — bindings.in is required for non-void CaseInput
const n7_bad = contract.flow("x").step(n7_needsRef);
void n7_bad;

// -----------------------------------------------------------------------------
// N8: (SKIPPED in overload form) FlowBuilder.step(voidCase, { in: ... })
// -----------------------------------------------------------------------------
// TS overload resolution limitation: when overload 1 (void ref, bindings
// without `in`) gets excess property `in`, TS silently falls to overload 2
// (which requires `in`). Overload 2 then accepts because the case input is
// `void` and any `() => X` is assignable to `() => void` in TS (void return
// is bivariant). To catch this at compile time, FlowBuilder.step must use
// a single signature with a conditional `StepBindings` type rather than
// overloads. Documented as a Spike 0 finding — Spike 2 should switch to
// conditional bindings. Not a blocker (runtime load-time check is a backup).

// -----------------------------------------------------------------------------
// N9: body function with contextually inferred input (no explicit annotation)
// -----------------------------------------------------------------------------
// When author writes `body: (input) => ...` without annotation, TS should
// contextually infer input from the expected function signature
// `(input: Needs) => unknown`. Destructuring a key not in Needs then errors.
//
// Note: if author uses EXPLICIT param annotation (e.g. `body: (x: {wrong}) => ...`),
// TS accepts it because the body field union includes permissive types
// (`unknown | Fn`). That is a pre-existing body-typing issue, not specific
// to the attachment model. Addressing it (e.g. narrowing body union in the
// real HttpContractCase) is out of scope for Spike 0.
const n9_contract = contract.http("bad9", {
  endpoint: "POST /x",
  cases: {
    make: {
      description: "n9",
      needs: schema<{ userId: string }>(),
      // @ts-expect-error — destructure `nope` not in inferred input `{ userId: string }`
      body: ({ nope }) => ({ nope }),
      expect: { status: 201 },
    },
  },
});
void n9_contract;
