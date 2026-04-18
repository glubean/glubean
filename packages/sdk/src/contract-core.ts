/**
 * Protocol-agnostic contract core.
 *
 * Provides:
 *   - Adapter registry (`_adapters`)
 *   - `contract.register(protocol, adapter)` — plugin extension point
 *   - `contract[protocol](id, spec)` dispatcher — validates 1:1 case keys,
 *     invokes adapter.execute per case, registers tests + ContractRegistryMeta
 *   - `contract.flow(id)` — protocol-agnostic FlowBuilder
 *   - `runFlow(flow, ctx)` — core flow execution helper (Rule 1/2 teardown)
 *   - `normalizeFlow(runtime)` — Runtime → ExtractedFlowProjection
 *   - Permissive Proxy tracer for `compute` nodes (best-effort reads/writes)
 *
 * HTTP is NOT handled here — it registers itself in `./contract-http/`.
 * This file has zero HTTP-specific code.
 *
 * See:
 *   - `internal/40-discovery/proposals/contract-generics-complete.md` v5
 *   - `internal/40-discovery/proposals/contract-flow.md` v9
 */

import type { Test, TestContext } from "./types.js";
import type {
  ContractCaseRef,
  ContractProtocolAdapter,
  ContractProjection,
  ContractRegistryMeta,
  ExtractedFlowProjection,
  ExtractedFlowStep,
  FieldMapping,
  FlowBuilder,
  FlowContract,
  FlowMeta,
  FlowRegistryMeta,
  ProtocolContract,
  RuntimeComputeStep,
  RuntimeContractCallStep,
  RuntimeFlowProjection,
  RuntimeFlowStep,
} from "./contract-types.js";
import { registerTest } from "./internal.js";

// =============================================================================
// Adapter registry
// =============================================================================

const _adapters = new Map<string, ContractProtocolAdapter<any, any, any, any, any>>();

/** Internal accessor for plugins / downstream (scanner, runner). */
export function getAdapter(
  protocol: string,
): ContractProtocolAdapter<any, any, any, any, any> | undefined {
  return _adapters.get(protocol);
}

// =============================================================================
// contract.register + dispatcher
// =============================================================================

const RESERVED_PROTOCOL_NAMES = new Set([
  "register",
  "flow",
  "getAdapter",
]);

/**
 * Register an adapter. Called by built-in HTTP adapter on SDK load, and by
 * external adapter plugins (`@glubean/contract-grpc` etc.) on their import.
 */
function register<
  Spec,
  RuntimeSchemas = unknown,
  RuntimeMeta = unknown,
  SafeSchemas = unknown,
  SafeMeta = unknown,
>(
  protocol: string,
  adapter: ContractProtocolAdapter<Spec, RuntimeSchemas, RuntimeMeta, SafeSchemas, SafeMeta>,
): void {
  if (RESERVED_PROTOCOL_NAMES.has(protocol)) {
    throw new Error(`Cannot register reserved protocol name "${protocol}"`);
  }
  _adapters.set(protocol, adapter as ContractProtocolAdapter<any, any, any, any, any>);

  // Attach contract[protocol] dispatcher dynamically.
  (contract as any)[protocol] = (
    id: string,
    spec: Spec & {
      cases?: Record<string, CaseSpecShape>;
      tags?: string[];
    },
  ): ProtocolContract<Spec, SafeSchemas, SafeMeta> => {
    return dispatchContract(protocol, adapter, id, spec);
  };
}

/**
 * Generic contract dispatcher — shared across all protocols.
 * Called by `contract[protocol](id, spec)` above.
 */
function dispatchContract<
  Spec,
  RuntimeSchemas,
  RuntimeMeta,
  SafeSchemas,
  SafeMeta,
>(
  protocol: string,
  adapter: ContractProtocolAdapter<Spec, RuntimeSchemas, RuntimeMeta, SafeSchemas, SafeMeta>,
  id: string,
  spec: Spec & {
    cases?: Record<string, CaseSpecShape>;
    tags?: string[];
  },
): ProtocolContract<Spec, SafeSchemas, SafeMeta> {
  const rawProjection: ContractProjection<RuntimeSchemas, RuntimeMeta> =
    adapter.project(spec);

  // Registered protocol name is source of truth — adapters may report a
  // canonical name that drifts from the registration name.
  const projection: ContractProjection<RuntimeSchemas, RuntimeMeta> = {
    ...rawProjection,
    protocol,
  };

  // 1:1 key invariant between spec.cases and projection.cases
  validateCaseKeys(protocol, spec.cases ?? {}, projection.cases);

  const cases = spec.cases ?? {};
  const contractTagsRaw = spec.tags;
  const contractTags = Array.isArray(contractTagsRaw)
    ? contractTagsRaw
    : contractTagsRaw
      ? [contractTagsRaw as unknown as string]
      : [];

  const projCaseMap = new Map(projection.cases.map((c) => [c.key, c]));

  const tests: Test[] = Object.entries(cases).map(([caseKey, caseSpec]) => {
    const testId = `${id}.${caseKey}`;
    const testName = `${id} — ${caseKey}`;
    const projCase = projCaseMap.get(caseKey)!;

    const caseTags = caseSpec.tags ?? [];
    const allTags = [...contractTags, ...caseTags];

    // Projection lifecycle/severity are authoritative
    const requires = projCase.requires ?? caseSpec.requires ?? "headless";
    const defaultRun =
      projCase.defaultRun ?? caseSpec.defaultRun ??
      (requires !== "headless" ? "opt-in" : "always");

    const runtimeTags: string[] = [];
    if (requires !== "headless") runtimeTags.push(`requires:${requires}`);
    if (defaultRun === "opt-in") runtimeTags.push("default-run:opt-in");
    const finalTags = [...allTags, ...runtimeTags];

    const skipDeprecated = projCase.lifecycle === "deprecated"
      ? `deprecated: ${projCase.deprecatedReason ?? caseSpec.deprecated ?? "deprecated"}`
      : caseSpec.deprecated
        ? `deprecated: ${caseSpec.deprecated}`
        : undefined;
    const skipDeferred = projCase.lifecycle === "deferred"
      ? (projCase.deferredReason ?? caseSpec.deferred ?? "deferred")
      : caseSpec.deferred;

    const testDef: Test = {
      meta: {
        id: testId,
        name: testName,
        description: projCase.description,
        tags: finalTags.length > 0 ? finalTags : undefined,
        deferred: skipDeferred,
        deprecated: skipDeprecated
          ? (projCase.deprecatedReason ?? caseSpec.deprecated ?? "deprecated")
          : undefined,
        requires,
        defaultRun,
      },
      type: "simple",
      fn: async (ctx) => {
        if (skipDeprecated) ctx.skip(skipDeprecated);
        if (skipDeferred) ctx.skip(skipDeferred);
        await adapter.execute(ctx, caseSpec, spec);
      },
    };

    // Build ContractRegistryMeta
    const payloadSummary = adapter.describePayload
      ? (() => {
          // describePayload expects SafeSchemas — we don't have safe form yet,
          // so pass projCase.schemas as a best-effort (adapters using this in
          // runtime meta should be tolerant of live objects).
          try {
            return adapter.describePayload((projCase.schemas ?? undefined) as any);
          } catch {
            return undefined;
          }
        })()
      : undefined;

    const registryMeta: ContractRegistryMeta = {
      target: projection.target,
      protocol: projection.protocol,
      caseKey,
      lifecycle: projCase.lifecycle,
      severity: projCase.severity,
      instanceName: projection.instanceName,
      payloadSummary,
      meta: projCase.meta,
    };

    registerTest({
      id: testId,
      name: testName,
      type: "simple",
      tags: finalTags.length > 0 ? finalTags : undefined,
      description: projCase.description,
      groupId: id,
      requires,
      defaultRun,
      contract: registryMeta,
    });

    return testDef;
  });

  // Core injects id into both _projection and _spec carrier
  const enrichedProjection = { ...projection, id };

  const arr: Test[] = [...tests];

  const contractObj = Object.assign(arr, {
    _projection: enrichedProjection,
    _spec: spec as Spec,
    case(key: string): ContractCaseRef<any, any> {
      // Delegate fail-fast validation to adapter (e.g. HTTP rejects
      // function-valued body/params/query/headers).
      adapter.validateCaseForFlow?.(spec as Spec, key, id);
      return makeContractCaseRef(
        protocol,
        id,
        projection.target,
        key,
        contractObj as unknown as ProtocolContract<Spec, SafeSchemas, SafeMeta>,
        spec as Spec,
      );
    },
  }) as unknown as ProtocolContract<Spec, SafeSchemas, SafeMeta>;

  return contractObj;
}

type CaseSpecShape = {
  description?: string;
  deferred?: string;
  deprecated?: string;
  severity?: import("./contract-types.js").CaseSeverity;
  requires?: import("./contract-types.js").CaseRequires;
  defaultRun?: import("./contract-types.js").CaseDefaultRun;
  tags?: string[];
  // Arbitrary adapter-specific fields pass through
  [key: string]: unknown;
};

function validateCaseKeys(
  protocol: string,
  specCases: Record<string, unknown>,
  projectionCases: Array<{ key: string }>,
): void {
  // Duplicate check
  const keys = projectionCases.map((c) => c.key);
  const keySet = new Set(keys);
  if (keySet.size !== keys.length) {
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    throw new Error(
      `contract.register("${protocol}"): project() returned duplicate case key(s): ${[...new Set(dupes)].join(", ")}. ` +
        `Each projected case key must be unique.`,
    );
  }
  const specKeys = new Set(Object.keys(specCases));
  for (const key of keySet) {
    if (!specKeys.has(key)) {
      throw new Error(
        `contract.register("${protocol}"): project() returned case "${key}" not present in spec.cases. ` +
          `Projected cases must 1:1 match spec.cases keys.`,
      );
    }
  }
  for (const key of specKeys) {
    if (!keySet.has(key)) {
      throw new Error(
        `contract.register("${protocol}"): spec.cases has "${key}" but project() did not return it. ` +
          `Projected cases must 1:1 match spec.cases keys.`,
      );
    }
  }
}

/**
 * Construct a ContractCaseRef. Adapters may extend this via module
 * augmentation if they want stricter typing for their specific I/O shapes.
 *
 * This function performs the `function-valued field fail-fast` check
 * required by contract-flow §5.1.1 — but since the check is
 * protocol-specific (what counts as an "input slot" varies), adapters
 * should enforce it in their own `.case()` wrapper if needed. For
 * built-in HTTP adapter, see `./contract-http/adapter.ts`.
 */
function makeContractCaseRef(
  protocol: string,
  contractId: string,
  target: string,
  caseKey: string,
  contract: ProtocolContract<any, any, any>,
  _spec: unknown,
): ContractCaseRef<any, any> {
  return {
    __glubean_type: "contract-case-ref",
    contractId,
    caseKey,
    protocol,
    target,
    contract,
  };
}

// =============================================================================
// contract namespace
// =============================================================================

type ContractNamespace = {
  register: typeof register;
  flow: typeof flow;
  [protocol: string]: unknown;
};

export const contract: ContractNamespace = {
  register,
  flow,
};

// =============================================================================
// Flow: FlowBuilder + runFlow + normalizeFlow + tracePureFn
// =============================================================================

/**
 * Protocol-agnostic flow builder. See contract-flow.md v9 §4.1.
 */
export function flow(idOrMeta: string | FlowMeta): FlowBuilder<unknown> {
  const meta: FlowMeta = typeof idOrMeta === "string"
    ? { id: idOrMeta }
    : idOrMeta;
  const steps: RuntimeFlowStep[] = [];
  let setupFn: ((ctx: TestContext) => Promise<any>) | undefined;
  let teardownFn: ((ctx: TestContext, state: any) => Promise<void>) | undefined;
  let built = false;
  let extraMeta: Omit<FlowMeta, "id"> = {};

  const builder: FlowBuilder<any> = {
    __glubean_type: "flow-builder",

    meta(m): FlowBuilder<any> {
      extraMeta = { ...extraMeta, ...m };
      return builder;
    },

    setup(fn): FlowBuilder<any> {
      setupFn = fn;
      return builder;
    },

    teardown(fn): FlowBuilder<any> {
      teardownFn = fn;
      return builder;
    },

    step(ref, bindings): FlowBuilder<any> {
      const adapter = _adapters.get(ref.protocol);
      if (!adapter) {
        throw new Error(
          `contract.flow(${JSON.stringify(meta.id)}).step: unknown protocol "${ref.protocol}". ` +
            `Did you forget to import a contract plugin package (e.g. "@glubean/contract-grpc")?`,
        );
      }
      if (!adapter.executeCaseInFlow) {
        throw new Error(
          `contract.flow(${JSON.stringify(meta.id)}).step: adapter for "${ref.protocol}" ` +
            `does not implement executeCaseInFlow — this protocol cannot appear in a flow.`,
        );
      }
      const step: RuntimeContractCallStep = {
        kind: "contract-call",
        name: bindings?.name,
        ref,
        caseKey: ref.caseKey,
        contract: ref.contract,
        bindings: bindings
          ? { in: bindings.in, out: bindings.out as any }
          : undefined,
      };
      steps.push(step);
      return builder;
    },

    compute(fn): FlowBuilder<any> {
      const step: RuntimeComputeStep = {
        kind: "compute",
        fn: fn as (state: any) => any,
      };
      steps.push(step);
      return builder;
    },

    build(): FlowContract<any> {
      return finalize();
    },
  };

  // Auto-finalize via microtask (mirrors TestBuilder pattern)
  queueMicrotask(() => {
    if (!built) finalize();
  });

  function finalize(): FlowContract<any> {
    if (built) return builtResult!;
    built = true;

    const runtime: RuntimeFlowProjection<any> = {
      protocol: "flow",
      description: extraMeta.description,
      tags: extraMeta.tags,
      extensions: extraMeta.extensions,
      setup: setupFn,
      teardown: teardownFn,
      steps,
    };

    // Build the single Test that runFlow orchestrates.
    const flowTest: Test = {
      meta: {
        id: meta.id,
        name: extraMeta.name ?? meta.id,
        tags: extraMeta.tags,
      },
      type: "simple",
      fn: async (ctx) => {
        await runFlow(resultHandle, ctx);
      },
    };

    const arr: Test[] = [flowTest];
    const runtimeWithId = { ...runtime, id: meta.id };
    const resultHandle = Object.assign(arr, {
      _flow: runtimeWithId,
    }) as FlowContract<any>;

    // Register flow in the registry (with extracted projection for scanner display)
    const extracted = normalizeFlow(runtimeWithId);
    const flowRegistryMeta: FlowRegistryMeta = {
      id: extracted.id,
      description: extracted.description,
      tags: extracted.tags,
      steps: extracted.steps.map(stepProjectionToRegistry),
      setupDynamic: extracted.setupDynamic,
    };

    registerTest({
      id: meta.id,
      name: extraMeta.name ?? meta.id,
      type: "simple",
      tags: extraMeta.tags,
      description: extraMeta.description,
      flow: flowRegistryMeta,
    });

    builtResult = resultHandle;
    return resultHandle;
  }

  let builtResult: FlowContract<any> | undefined;
  return builder;
}

function stepProjectionToRegistry(
  step: ExtractedFlowStep,
): FlowRegistryMeta["steps"][number] {
  if (step.kind === "compute") {
    return {
      kind: "compute",
      name: step.name,
      reads: step.reads,
      writes: step.writes,
    };
  }
  return {
    kind: "contract-call",
    name: step.name,
    contractId: step.contractId,
    caseKey: step.caseKey,
    protocol: step.protocol,
    target: step.target,
    inputs: step.inputs,
    outputs: step.outputs,
  };
}

/**
 * Core flow execution helper. Implements the Rule 1 / Rule 2 teardown
 * semantics from contract-flow.md §7.
 */
export async function runFlow<State>(
  flowContract: FlowContract<State>,
  ctx: TestContext,
): Promise<void> {
  const runtime = flowContract._flow;

  // If flow.setup throws → flow.teardown does NOT run (Rule 2).
  let state: State = runtime.setup
    ? await runtime.setup(ctx)
    : (undefined as State);

  try {
    for (const step of runtime.steps) {
      if (step.kind === "compute") {
        // Compute: synchronous pure function. Enforce both syntactic and
        // value-level async rejection.
        if ((step.fn as { constructor?: { name?: string } }).constructor?.name === "AsyncFunction") {
          throw new Error(
            `flow "${runtime.id}" compute step "${step.name ?? "<unnamed>"}": ` +
              `async functions are not allowed — compute must be synchronous and I/O-free`,
          );
        }
        const result = step.fn(state);
        if (result && typeof (result as any).then === "function") {
          throw new Error(
            `flow "${runtime.id}" compute step "${step.name ?? "<unnamed>"}": ` +
              `returned a thenable (Promise or Promise-like) — compute must not return async values. ` +
              `If you need async initialization, use flow.setup() instead.`,
          );
        }
        state = result as State;
        continue;
      }

      // contract-call branch
      const adapter = _adapters.get(step.ref.protocol);
      if (!adapter) {
        throw new Error(
          `flow "${runtime.id}" step "${step.name ?? step.caseKey}": ` +
            `no registered adapter for protocol "${step.ref.protocol}". ` +
            `Did you forget to import a contract plugin package?`,
        );
      }
      if (!adapter.executeCaseInFlow) {
        throw new Error(
          `flow "${runtime.id}" step "${step.name ?? step.caseKey}": ` +
            `adapter for "${step.ref.protocol}" does not implement executeCaseInFlow`,
        );
      }

      const resolvedInputs = step.bindings?.in?.(state);

      const response = await adapter.executeCaseInFlow({
        ctx,
        contract: step.contract as any,
        caseKey: step.caseKey,
        resolvedInputs,
      });

      if (step.bindings?.out) {
        state = step.bindings.out(state, response) as State;
      }
    }
  } finally {
    if (runtime.teardown) {
      // flow.teardown runs in Rule 2 outer-finally. Its errors are logged
      // but must not mask the primary exception.
      try {
        await runtime.teardown(ctx, state);
      } catch (teardownErr) {
        ctx.log?.(`flow.teardown failed: ${String(teardownErr)}`);
      }
    }
  }
}

// =============================================================================
// normalizeFlow + permissive Proxy tracer
// =============================================================================

/**
 * Normalize a RuntimeFlowProjection to JSON-safe ExtractedFlowProjection.
 * Runs Proxy dry-run of lens functions to extract FieldMappings.
 */
export function normalizeFlow<State>(
  runtime: RuntimeFlowProjection<State> & { id: string },
): ExtractedFlowProjection {
  return {
    id: runtime.id,
    protocol: "flow",
    description: runtime.description,
    tags: runtime.tags,
    extensions: runtime.extensions,
    setupDynamic: runtime.setup ? true : undefined,
    steps: runtime.steps.map<ExtractedFlowStep>((s) => {
      if (s.kind === "compute") {
        const { reads, writes } = traceComputeFn(s.fn);
        return { kind: "compute", name: s.name, reads, writes };
      }
      return {
        kind: "contract-call",
        name: s.name,
        contractId: s.contract._projection.id,
        caseKey: s.caseKey,
        protocol: s.ref.protocol,
        target: s.ref.target,
        inputs: s.bindings?.in ? extractMappings(s.bindings.in) : undefined,
        outputs: s.bindings?.out
          ? extractMappingsOut(s.bindings.out)
          : undefined,
      };
    }),
  };
}

/**
 * Run a pure lens `fn: (state) => output` with a tracing Proxy, extracting
 * FieldMappings from state paths to output paths.
 *
 * Pure-lens enforcement: method calls / Symbol.iterator / length on state
 * proxy cause the result to be returned without panicking (we just accept
 * best-effort). Adapters that need strict enforcement can re-run with a
 * stricter proxy in tests.
 */
export function extractMappings(fn: (state: any) => any): FieldMapping[] {
  const proxy = makeLensProxy("state");
  let result: unknown;
  try {
    result = fn(proxy);
  } catch {
    return [];
  }
  return collectMappings(result, []);
}

/**
 * Extract FieldMappings from `out: (state, response) => newState`.
 */
export function extractMappingsOut(
  fn: (state: any, response: any) => any,
): FieldMapping[] {
  const stateProxy = makeLensProxy("state");
  const resProxy = makeLensProxy("response");
  let result: unknown;
  try {
    result = fn(stateProxy, resProxy);
  } catch {
    return [];
  }
  // outputs target is always state.X
  return collectMappings(result, ["state"]);
}

/**
 * Recursively descend into an object produced by a traced lens, collecting
 * paths. Lens outputs are plain objects whose leaf values are TracedValue
 * markers (recording their source path).
 */
function collectMappings(
  out: unknown,
  targetPath: string[],
): FieldMapping[] {
  const mappings: FieldMapping[] = [];
  walk(out, targetPath);
  return mappings;

  function walk(val: unknown, path: string[]) {
    if (isTracedValue(val)) {
      mappings.push({
        target: path.join("."),
        source: { kind: "path", path: (val as any)[TRACE_MARKER] as string },
      });
      return;
    }
    if (val === undefined || val === null) return;
    if (typeof val === "object" && !Array.isArray(val)) {
      for (const [k, v] of Object.entries(val)) {
        walk(v, [...path, k]);
      }
      return;
    }
    if (Array.isArray(val)) {
      val.forEach((v, i) => walk(v, [...path, String(i)]));
      return;
    }
    // Primitive literal
    mappings.push({
      target: path.join("."),
      source: { kind: "literal", value: val as any },
    });
  }
}

// --- Traced values (returned by lens proxy on property access) ---------------
//
// The trace marker is a Symbol (not a string key) so it is invisible to
// `Object.keys` / spread / JSON.stringify. Without this, `{ ...s }` in a lens
// would copy the tracer sentinel into the result and trip the traced-value
// check against the entire spread object.

const TRACE_MARKER = Symbol.for("@glubean/lens-trace");

interface TracedValue {
  [TRACE_MARKER]: string;
}

function isTracedValue(v: unknown): v is TracedValue {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as any)[TRACE_MARKER] !== undefined
  );
}

/**
 * Strict lens proxy — records top-level property access path as a TracedValue
 * on read. Used for `.step()` in/out lenses where we want precise field
 * mappings. Trace marker is a Symbol so it doesn't leak through spread.
 */
function makeLensProxy(rootPath: string): any {
  function childProxy(path: string): any {
    // Target is an empty object; we expose path only via TRACE_MARKER symbol.
    return new Proxy({}, {
      get(_target, prop) {
        if (prop === TRACE_MARKER) return path;
        if (typeof prop === "symbol") return undefined;
        return childProxy(`${path}.${String(prop)}`);
      },
      // ownKeys returns nothing so spread copies no fields.
      ownKeys() {
        return [];
      },
      getOwnPropertyDescriptor() {
        return undefined;
      },
    });
  }
  return childProxy(rootPath);
}

// --- Permissive compute proxy (different role, different trap rules) --------

/**
 * Trace a `compute` fn to extract top-level reads + writes.
 *
 * Compute allows arbitrary sync TS (template literals, method calls, .map()),
 * so the Proxy must be permissive: respond to primitive coercion, swallow
 * method calls, etc. We only record top-level property access paths.
 *
 * See contract-flow.md §4.1.1 for design + known limitations.
 */
export function traceComputeFn(
  fn: (state: any) => any,
): { reads: string[]; writes: string[] } {
  const reads = new Set<string>();
  const proxy = makeComputeProxy("state", reads);
  let result: unknown;
  try {
    result = fn(proxy);
  } catch {
    return { reads: [], writes: [] };
  }
  const writes =
    result && typeof result === "object" && !Array.isArray(result)
      ? Object.keys(result as object).filter((k) => typeof k === "string")
      : [];
  return { reads: [...reads].sort(), writes };
}

function makeComputeProxy(rootPath: string, reads: Set<string>): any {
  return new Proxy(function dummy() {}, {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === "toString") return () => "";
      if (prop === "valueOf") return () => 0;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === "length") return 0;
      if (prop === Symbol.isConcatSpreadable) return false;
      if (typeof prop !== "string") return undefined;
      reads.add(`${rootPath}.${prop}`);
      return makePermissiveChildProxy();
    },
    apply() {
      return makePermissiveChildProxy();
    },
    has() {
      return true;
    },
    ownKeys() {
      return [];
    },
    getOwnPropertyDescriptor() {
      return { configurable: true, enumerable: true, value: undefined };
    },
  });
}

/**
 * Totally-permissive child proxy — swallows every access / invocation,
 * returns itself. Used for depth-2+ of compute tracing where we don't track.
 */
function makePermissiveChildProxy(): any {
  const self: any = new Proxy(function dummy() {}, {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === "toString") return () => "";
      if (prop === "valueOf") return () => 0;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === "length") return 0;
      return self;
    },
    apply() {
      return self;
    },
    has() {
      return true;
    },
    ownKeys() {
      return [];
    },
    getOwnPropertyDescriptor() {
      return { configurable: true, enumerable: true, value: undefined };
    },
  });
  return self;
}
