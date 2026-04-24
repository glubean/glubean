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
  BaseCaseSpec,
  Bootstrap,
  BootstrapAttachment,
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
import { getBootstrap, registerBootstrap } from "./bootstrap-registry.js";

/**
 * Validate a value against a `needs` schema. Used by the v10 attachment model
 * dispatcher after bootstrap overlay produces `resolvedInput` — before passing
 * to `adapter.executeCase`. Keeps the invariant that adapter receives
 * already-validated input.
 *
 * Handles both SchemaLike flavors (safeParse preferred, parse fallback).
 * When neither is present, passes value through — the schema was purely
 * type-level and carries no runtime check.
 */
function validateNeedsOutput(
  needsSchema: { safeParse?: unknown; parse?: unknown },
  value: unknown,
  ctx: { testId: string; source: "bootstrap" | "explicit" },
): unknown {
  const sp = (needsSchema as { safeParse?: (d: unknown) => unknown }).safeParse;
  if (typeof sp === "function") {
    const result = sp(value) as
      | { success: true; data: unknown }
      | { success: false; error: { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey> }> } };
    if (result.success) return result.data;
    const lines = result.error.issues.map(
      (i) => `  - ${i.path?.join(".") ?? "<root>"}: ${i.message}`,
    );
    throw new Error(
      `${ctx.source === "bootstrap" ? "Bootstrap output" : "Explicit input"} ` +
        `for case "${ctx.testId}" does not satisfy needs schema:\n${lines.join("\n")}`,
    );
  }
  const p = (needsSchema as { parse?: (d: unknown) => unknown }).parse;
  if (typeof p === "function") {
    return p(value);
  }
  // Schema declares neither safeParse nor parse — type-level only, pass through.
  return value;
}

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

/**
 * List all currently registered protocol names. Used by the artifact
 * registry's capability introspection (`listArtifactCapability`) to iterate
 * all adapters and classify them against a given artifact kind.
 *
 * Order is insertion order (Map semantics). Consumers that need stable
 * output should sort.
 */
export function listRegisteredProtocols(): string[] {
  return [..._adapters.keys()];
}

/**
 * Test-only: unregister a protocol adapter + remove its dispatcher from the
 * `contract` namespace. Used by `__resetInstalledPluginsForTesting` in
 * `install-plugin.ts` to restore a clean state between test scenarios.
 *
 * Not exposed via the public `contract` object — callers must import it
 * directly from `@glubean/sdk/internal`. Reserved protocol names
 * (`register`, `flow`, `getAdapter`) are refused.
 *
 * @internal
 */
export function __unregisterProtocolForTesting(protocol: string): void {
  if (RESERVED_PROTOCOL_NAMES.has(protocol)) return;
  _adapters.delete(protocol);
  delete (contract as Record<string, unknown>)[protocol];
}

/**
 * Test-only: unregister all protocol adapters at once (iterates the current
 * registry and calls `__unregisterProtocolForTesting` for each, including
 * built-in "http"). Used by contract-artifacts tests that need a clean
 * adapter registry between assertions. Reserved names are naturally skipped.
 *
 * @internal
 */
export function __resetAdapterRegistryForTesting(): void {
  for (const protocol of [..._adapters.keys()]) {
    __unregisterProtocolForTesting(protocol);
  }
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
 * external protocol packages (`@glubean/grpc`, `@glubean/graphql` etc.) on
 * their import — single-package model, each protocol package owns both
 * transport + contract adapter.
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
  // Generic `Cases` preserves per-case Needs/Output through ProtocolContract
  // so `.case("key")` returns a properly-typed ContractCaseRef. Without this,
  // `contract.bootstrap(ref, { run })` cannot type-check the run return
  // against the specific case's needs.
  (contract as any)[protocol] = <
    Cases extends Record<string, BaseCaseSpec>,
  >(
    id: string,
    spec: Spec & {
      cases?: Cases;
      tags?: string[];
    },
  ): ProtocolContract<Spec, SafeSchemas, SafeMeta, Cases> => {
    return dispatchContract(protocol, adapter, id, spec) as ProtocolContract<
      Spec,
      SafeSchemas,
      SafeMeta,
      Cases
    >;
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
    cases?: Record<string, BaseCaseSpec>;
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

  // Forward-declared carrier reference. Populated below via Object.assign and
  // captured by each test.fn closure so that v10 bootstrap overlay dispatch
  // can pass `contract` to `adapter.executeCase({ ..., contract, ... })` at
  // runtime. Safe because fn closures only execute after contractObj is set.
  let contractObj:
    | ProtocolContract<Spec, SafeSchemas, SafeMeta>
    | undefined;

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

        // v10 attachment model: check for bootstrap overlay registered via
        // contract.bootstrap(). If one exists AND the adapter supports the
        // new executeCase entry point, run overlay → call executeCase with
        // resolved input. Otherwise fall back to legacy adapter.execute.
        //
        // Phase 2b Step 1 scope: plain-function bootstrap form only. Structured
        // form with `bootstrap.params` + runner-provided `bootstrapInput` is
        // Spike 3 (CLI / MCP channels). Structured form with required params
        // will throw at runtime until Spike 3 wires the input channel.
        //
        // No `needs` schema validation yet — Phase 2b Step 2 adds that once
        // the input channel exists. For now the adapter's body/headers fns
        // receive whatever the bootstrap run returned; type safety comes from
        // the authoring type (InferCaseInput<Cases[K]> on ref).
        const overlay = getBootstrap(testId);
        if (overlay && adapter.executeCase && contractObj) {
          const cleanups: Array<() => Promise<void> | void> = [];
          const bootstrapCtx = Object.assign(Object.create(ctx as object), ctx, {
            cleanup(fn: () => Promise<void> | void) {
              cleanups.push(fn);
            },
          });

          const runFn = typeof overlay.spec === "function"
            ? overlay.spec
            : overlay.spec.run;

          let resolvedInput: unknown;
          try {
            resolvedInput = await runFn(bootstrapCtx, undefined as unknown);
          } catch (err) {
            // Bootstrap failed; still run cleanups registered so far.
            while (cleanups.length > 0) {
              try { await cleanups.pop()!(); } catch { /* swallow */ }
            }
            throw err;
          }

          // v10 Phase 2b Step 2: validate bootstrap output against `needs`
          // schema before handing off to adapter. Adapter's contract is
          // "receives already-validated input"; validation at the runner
          // boundary matches single-case-execution-api.md §7.
          const needsSchema = (caseSpec as { needs?: unknown }).needs;
          if (needsSchema) {
            try {
              resolvedInput = validateNeedsOutput(
                needsSchema as { safeParse?: unknown; parse?: unknown },
                resolvedInput,
                { testId, source: "bootstrap" },
              );
            } catch (err) {
              // Validation failed — run cleanups, re-throw. Same policy as
              // bootstrap run failure (cleanups registered during bootstrap
              // should still tear down what was set up).
              while (cleanups.length > 0) {
                try { await cleanups.pop()!(); } catch { /* swallow */ }
              }
              throw err;
            }
          }

          try {
            await adapter.executeCase({
              ctx,
              contract: contractObj,
              caseKey,
              resolvedInput,
            });
          } finally {
            // LIFO cleanup, errors reported but don't mask primary failure.
            while (cleanups.length > 0) {
              const cleanup = cleanups.pop()!;
              try {
                await cleanup();
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  `bootstrap cleanup error for ${testId}:`,
                  err,
                );
              }
            }
          }
          return;
        }

        // Legacy path: no overlay, adapter lacks executeCase, or carrier
        // not yet assembled (impossible at fn-call time, but TS-safe).
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

  // Dispatcher-level invariant: call adapter.normalize once and store the
  // JSON-safe result as _extracted. Scanner / MCP / CLI / cloud read this
  // directly. Declared required on ContractProtocolAdapter so failure to
  // implement is a compile error, not a silent runtime hole.
  const extracted = adapter.normalize(enrichedProjection);

  const arr: Test[] = [...tests];

  contractObj = Object.assign(arr, {
    _projection: enrichedProjection,
    _extracted: extracted,
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
  bootstrap: typeof bootstrap;
  [protocol: string]: unknown;
};

/**
 * Register a bootstrap overlay for a contract case. Standalone-only
 * execution path; flow NEVER invokes bootstrap (non-negotiable invariant
 * from attachment model §0.4 / §14.0).
 *
 * `NoInfer<Needs>` on the spec parameter prevents TypeScript's multi-site
 * inference from silently accepting a mismatched `run` return type —
 * without it, TS merges inferences from ref + spec and produces a
 * compatible Needs, masking real type errors (Spike 0 Finding 1).
 */
export function bootstrap<Needs, Params = void>(
  ref: ContractCaseRef<Needs, unknown>,
  spec: Bootstrap<Params, NoInfer<Needs>>,
): BootstrapAttachment<Needs, Params> {
  return registerBootstrap(ref, spec as Bootstrap<Params, Needs>);
}

export const contract: ContractNamespace = {
  register,
  flow,
  bootstrap,
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
            `Did you forget to import a contract plugin package (e.g. "@glubean/grpc")?`,
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
        description: extraMeta.description,
        // `FlowMeta.skip: string` (the reason) → `TestMeta.deferred: string`
        // mirrors the ContractCase.deferred convention so downstream
        // reporters render the skip reason consistently.
        ...(extraMeta.skip !== undefined ? { deferred: extraMeta.skip } : {}),
        ...(extraMeta.only !== undefined ? { only: extraMeta.only } : {}),
      },
      type: "simple",
      fn: async (ctx) => {
        // Belt-and-suspenders: runtime ctx.skip in case the runner didn't
        // filter on meta.deferred (e.g. the user ran with an explicit
        // target that bypasses skip filters).
        if (extraMeta.skip) ctx.skip(extraMeta.skip);
        await runFlow(resultHandle, ctx);
      },
    };

    const arr: Test[] = [flowTest];
    const runtimeWithId = { ...runtime, id: meta.id };

    // Pre-compute extracted projection so downstream consumers (scanner,
    // CLI, MCP, Cloud) get full field mappings + compute reads/writes
    // without having to import the SDK to call normalizeFlow themselves.
    const extracted = normalizeFlow(runtimeWithId);

    const resultHandle = Object.assign(arr, {
      _flow: runtimeWithId,
      _extracted: extracted,
    }) as FlowContract<any>;

    // Register flow in the registry
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
 *
 * Lens purity is enforced here: if a `step.bindings.in` or `.out` lens
 * violates purity (method call, `new`, etc.), `LensPurityError` is thrown
 * with step context so the author sees which step needs fixing.
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
    steps: runtime.steps.map<ExtractedFlowStep>((s, idx) => {
      const stepLabel = s.name ??
        (s.kind === "contract-call" ? `${s.contract._projection.id}#${s.caseKey}` : `step-${idx + 1}`);

      if (s.kind === "compute") {
        try {
          const { reads, writes } = traceComputeFn(s.fn);
          return { kind: "compute", name: s.name, reads, writes };
        } catch (err) {
          // Wrap compute-tracer failures with the same step-context format
          // used for lens errors, so authoring mistakes are equally easy
          // to localize regardless of which tracer caught them.
          throw new Error(
            `flow "${runtime.id}" step ${idx + 1} "${stepLabel}" (compute): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      let inputs: FieldMapping[] | undefined;
      if (s.bindings?.in) {
        try {
          inputs = extractMappings(s.bindings.in);
        } catch (err) {
          if (err instanceof LensPurityError) {
            throw new Error(
              `flow "${runtime.id}" step ${idx + 1} "${stepLabel}" (in lens): ${err.message}`,
            );
          }
          throw err;
        }
      }

      let outputs: FieldMapping[] | undefined;
      if (s.bindings?.out) {
        try {
          outputs = extractMappingsOut(s.bindings.out);
        } catch (err) {
          if (err instanceof LensPurityError) {
            throw new Error(
              `flow "${runtime.id}" step ${idx + 1} "${stepLabel}" (out lens): ${err.message}`,
            );
          }
          throw err;
        }
      }

      return {
        kind: "contract-call",
        name: s.name,
        contractId: s.contract._projection.id,
        caseKey: s.caseKey,
        protocol: s.ref.protocol,
        target: s.ref.target,
        inputs,
        outputs,
      };
    }),
  };
}

/**
 * Run a pure lens `fn: (state) => output` with a tracing Proxy, extracting
 * FieldMappings from state paths to output paths.
 *
 * Pure-lens enforcement: method calls, `new`, and coercion on the state
 * proxy raise `LensPurityError`. Errors are **not** swallowed — the caller
 * (typically `normalizeFlow`) wraps them with step context and re-throws,
 * so authors see the failure at flow build time rather than silently
 * losing projection data.
 */
export function extractMappings(fn: (state: any) => any): FieldMapping[] {
  const proxy = makeLensProxy("state");
  const result = fn(proxy);
  return collectMappings(result, []);
}

/**
 * Extract FieldMappings from `out: (state, response) => newState`.
 * Same purity contract as `extractMappings`.
 */
export function extractMappingsOut(
  fn: (state: any, response: any) => any,
): FieldMapping[] {
  const stateProxy = makeLensProxy("state");
  const resProxy = makeLensProxy("response");
  const result = fn(stateProxy, resProxy);
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
  // Lens proxy uses a callable function target (for apply-trap purity
  // enforcement), so the proxy itself reports `typeof === "function"` in
  // V8. Accept either object or function.
  return (
    (typeof v === "object" || typeof v === "function") &&
    v !== null &&
    (v as any)[TRACE_MARKER] !== undefined
  );
}

/**
 * Raised by the strict lens Proxy when a user lens fn attempts an operation
 * that breaks the "pure field access + repack" contract. Caught and re-
 * thrown with step context by `normalizeFlow`.
 */
export class LensPurityError extends Error {
  readonly path: string;
  readonly operation: string;
  constructor(path: string, operation: string) {
    super(
      `Flow step in/out lens must be a pure select/repack function ` +
        `(no method calls, branches, or arithmetic). ` +
        `Illegal operation: "${operation}" on path "${path}". ` +
        `If you need computation, move it to a .compute(s => ...) step between ` +
        `this .step() and the next one.`,
    );
    this.name = "LensPurityError";
    this.path = path;
    this.operation = operation;
  }
}

/**
 * Strict lens proxy — records top-level property access path as a TracedValue
 * on read. Used for `.step()` in/out lenses where we want precise field
 * mappings. Trace marker is a Symbol so it doesn't leak through spread.
 *
 * Enforces the lens purity invariant (contract-flow v9 §3.1 + §3.3):
 * method calls / coercion / method dispatch on state or response throw
 * `LensPurityError`. Authors who need computation must move it to a
 * `.compute(s => ...)` step.
 */
function makeLensProxy(rootPath: string): any {
  function childProxy(path: string): any {
    // Use a callable **arrow** function target so `apply` trap fires on
    // method calls. Arrow functions don't own `prototype`, so ownKeys can
    // return [] without violating Proxy invariants (regular functions own
    // a non-configurable `prototype` that would have to be surfaced).
    const target = (() => {}) as unknown as object;
    return new Proxy(target, {
      get(_target, prop) {
        if (prop === TRACE_MARKER) return path;
        if (typeof prop === "symbol") return undefined;
        return childProxy(`${path}.${String(prop)}`);
      },
      apply(_target, _thisArg, _args) {
        // Method call — forbidden. Extract the leaf segment as the offending op.
        const dot = path.lastIndexOf(".");
        const op = dot >= 0 ? path.slice(dot + 1) : path;
        const owner = dot >= 0 ? path.slice(0, dot) : path;
        throw new LensPurityError(owner, `${op}()`);
      },
      construct(_target, _args) {
        throw new LensPurityError(path, "new");
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
  // compute fn is permitted to do arbitrary synchronous TS — the proxy is
  // tolerant of method calls / coercion / iteration via its permissive
  // trap rules, so any exception here is genuine (e.g. fn threw explicitly).
  // Don't silently swallow: let the error propagate so callers surface it.
  const result = fn(proxy);
  const writes =
    result && typeof result === "object" && !Array.isArray(result)
      ? Object.keys(result as object).filter((k) => typeof k === "string")
      : [];
  return { reads: [...reads].sort(), writes };
}

function makeComputeProxy(rootPath: string, reads: Set<string>): any {
  // Arrow-function target: callable (for `apply` trap on method calls) but
  // does NOT own `prototype`, so `ownKeys` returning [] is valid and spread
  // (`{ ...s }`) works without triggering a Proxy invariant violation.
  return new Proxy((() => {}) as unknown as object, {
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
  const self: any = new Proxy((() => {}) as unknown as object, {
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
