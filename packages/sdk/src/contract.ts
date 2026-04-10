/**
 * contract.http() — declarative API contract testing.
 *
 * Spec in, Test[] out. Each case becomes a runnable Test.
 * The return value extends Array<Test> so runner/resolve handles it natively.
 */

import type {
  ContractCase,
  ContractProtocolAdapter,
  ContractRegistryMeta,
  HttpContract,
  HttpContractSpec,
  HttpFlowStepSpec,
} from "./contract-types.js";
import type { HttpClient, Test, TestContext, TestMeta } from "./types.js";
import { registerTest } from "./internal.js";

// =============================================================================
// HttpContractImpl — extends Array<Test> with contract-level methods
// =============================================================================

/**
 * Create an HttpContract — a Test[] with contract-level properties.
 * Uses Object.assign on a plain array to avoid class-extends-Array pitfalls.
 */
function createHttpContract(
  id: string,
  endpoint: string,
  tests: Test[],
  request?: import("./types.js").SchemaLike<unknown>,
): HttpContract {
  const arr = [...tests];

  const asSteps = () => {
    return <S>(b: import("./index.js").TestBuilder<S>) => {
      for (const t of arr) {
        if (t.fn) {
          b.step(t.meta.name ?? t.meta.id, async (ctx) => {
            await t.fn!(ctx);
          });
        }
      }
      return b;
    };
  };

  const asStep = (caseKey?: string) => {
    const target = caseKey
      ? arr.find((t) => t.meta.id.endsWith(`.${caseKey}`))
      : arr.find((t) => t.fn !== undefined && !t.meta.deferred);
    if (!target) throw new Error(`Case "${caseKey ?? "default"}" not found in contract "${id}"`);

    return <S>(b: import("./index.js").TestBuilder<S>) => {
      b.step(target.meta.name ?? target.meta.id, async (ctx) => {
        await target.fn!(ctx);
      });
      return b;
    };
  };

  return Object.assign(arr, { id, endpoint, request, asSteps, asStep }) as HttpContract;
}

// =============================================================================
// Parse endpoint string
// =============================================================================

function parseEndpoint(endpoint: string): { method: string; path: string } {
  const spaceIdx = endpoint.indexOf(" ");
  if (spaceIdx === -1) return { method: "GET", path: endpoint };
  return {
    method: endpoint.slice(0, spaceIdx).toUpperCase(),
    path: endpoint.slice(spaceIdx + 1),
  };
}

function resolveParams(
  path: string,
  params: Record<string, string> | undefined,
): string {
  if (!params) return path;
  let resolved = path;
  for (const [key, value] of Object.entries(params)) {
    resolved = resolved.replace(`:${key}`, encodeURIComponent(value));
  }
  return resolved;
}

// =============================================================================
// Build a Test from a single case
// =============================================================================

function buildCaseTest<T, S>(
  contractId: string,
  caseKey: string,
  endpoint: string,
  c: ContractCase<T, S>,
  spec: HttpContractSpec,
): Test {
  const { method, path } = parseEndpoint(endpoint);
  const contractTags = spec.tags ? (Array.isArray(spec.tags) ? spec.tags : [spec.tags]) : [];
  const caseTags = c.tags ?? [];
  const allTags = [...contractTags, ...caseTags];

  const testId = `${contractId}.${caseKey}`;
  const testName = `${contractId} — ${caseKey}`;

  // Auto-imply: non-headless requires → defaultRun: "opt-in"
  const requires = c.requires ?? "headless";
  const defaultRun = c.defaultRun ?? (requires !== "headless" ? "opt-in" : "always");

  // Auto-tag: requires:browser, requires:out-of-band, default-run:opt-in
  const runtimeTags: string[] = [];
  if (requires !== "headless") runtimeTags.push(`requires:${requires}`);
  if (defaultRun === "opt-in") runtimeTags.push("default-run:opt-in");
  const finalTags = [...allTags, ...runtimeTags];

  const meta: TestMeta = {
    id: testId,
    name: testName,
    description: c.description,
    tags: finalTags.length > 0 ? finalTags : undefined,
    deferred: c.deferred,
    requires,
    defaultRun,
  };

  const fn = async (ctx: import("./types.js").TestContext) => {
    // 1. Deferred → skip
    if (c.deferred) {
      ctx.skip(c.deferred);
    }

    // 2. Setup
    const state = c.setup ? await c.setup(ctx) : (undefined as S);

    try {
      // 3. Resolve client
      const client: HttpClient = (c.client ?? spec.client) as HttpClient;
      if (!client) {
        throw new Error(
          `No HTTP client provided for case "${caseKey}". ` +
          `Set "client" on the case or on the contract spec.`,
        );
      }

      // 4. Resolve params and path
      const params =
        typeof c.params === "function" ? c.params(state) : c.params;
      const resolvedPath = resolveParams(path, params);

      // 5. Build request options
      const requestOptions: Record<string, unknown> = {};
      if (c.body !== undefined) requestOptions.json = c.body;
      if (c.headers) requestOptions.headers = c.headers;
      if (c.query) {
        const q = typeof c.query === "function" ? c.query(state) : c.query;
        requestOptions.searchParams = q;
      }
      requestOptions.throwHttpErrors = false;

      // 6. Send request
      const methodLower = method.toLowerCase() as keyof HttpClient;
      const res = await (client[methodLower] as Function)(
        resolvedPath,
        requestOptions,
      );

      // 7. Assert status
      ctx.expect(res).toHaveStatus(c.expect.status);

      // 8. Parse response + validate schema
      let parsed: T;
      if (c.expect.schema) {
        const body = await res.json();
        const validated = ctx.validate(body, c.expect.schema, `${testId} response`);
        parsed = (validated !== undefined ? validated : body) as T;
      } else if (c.verify) {
        // No schema but verify needs the body — parse as raw JSON
        parsed = (await res.json()) as T;
      } else {
        parsed = undefined as T;
      }

      // 9. Verify callback
      if (c.verify) {
        await c.verify(ctx, parsed);
      }
    } finally {
      // 10. Teardown (always)
      if (c.teardown) {
        await c.teardown(ctx, state);
      }
    }
  };

  // Register to global registry with contract metadata
  const registryMeta: ContractRegistryMeta = {
    endpoint,
    protocol: "http",
    caseKey,
    expectStatus: c.expect.status,
    hasSchema: !!c.expect.schema,
    deferred: c.deferred,
  };

  registerTest({
    id: testId,
    name: testName,
    type: "simple",
    tags: finalTags.length > 0 ? finalTags : undefined,
    groupId: contractId,
    requires,
    defaultRun,
    contract: registryMeta,
  });

  return { meta, type: "simple", fn };
}

// =============================================================================
// contract.http()
// =============================================================================

function contractHttp<
  Cases extends Record<string, ContractCase<any, any>>,
>(
  id: string,
  spec: HttpContractSpec<Cases>,
): HttpContract {
  const tests: Test[] = [];

  for (const [caseKey, caseSpec] of Object.entries(spec.cases)) {
    tests.push(buildCaseTest(id, caseKey, spec.endpoint, caseSpec, spec));
  }

  return createHttpContract(id, spec.endpoint, tests, spec.request);
}

// =============================================================================
// FlowBuilder — declarative stateful endpoint chain (verification)
// =============================================================================

interface FlowStepMeta {
  name: string;
  endpoint: string;
  expectStatus: number;
}

class FlowBuilder<S = unknown> {
  private _id: string;
  private _defaultClient?: HttpClient;
  private _tags?: string[];
  private _requires?: import("./contract-types.js").CaseRequires;
  private _defaultRun?: import("./contract-types.js").CaseDefaultRun;
  private _steps: Array<{
    meta: FlowStepMeta;
    fn: (ctx: TestContext, state: any) => Promise<any>;
  }> = [];
  private _setupFn?: (ctx: TestContext) => Promise<any>;
  private _teardownFn?: (ctx: TestContext, state: any) => Promise<void>;

  constructor(id: string, options?: {
    client?: HttpClient;
    tags?: string[];
    /** Physical capability this flow requires. Default: "headless". */
    requires?: import("./contract-types.js").CaseRequires;
    /** Default run policy. Default: "always". Non-headless implies "opt-in". */
    defaultRun?: import("./contract-types.js").CaseDefaultRun;
  }) {
    this._id = id;
    this._defaultClient = options?.client;
    this._tags = options?.tags;
    this._requires = options?.requires;
    this._defaultRun = options?.defaultRun;
  }

  setup<NewS>(fn: (ctx: TestContext) => Promise<NewS>): FlowBuilder<NewS> {
    this._setupFn = fn;
    return this as unknown as FlowBuilder<NewS>;
  }

  teardown(fn: (ctx: TestContext, state: S) => Promise<void>): FlowBuilder<S> {
    this._teardownFn = fn;
    return this;
  }

  http<T, NewS>(
    name: string,
    spec: import("./contract-types.js").HttpFlowStepSpec<T, S> & { returns: (res: T, state: S) => NewS },
  ): FlowBuilder<NewS>;
  http<T>(
    name: string,
    spec: import("./contract-types.js").HttpFlowStepSpec<T, S> & { returns?: undefined },
  ): FlowBuilder<S>;
  http(
    name: string,
    spec: import("./contract-types.js").HttpFlowStepSpec<any, any>,
  ): FlowBuilder<any> {
    const { method, path } = parseEndpoint(spec.endpoint);
    const expectedStatus = spec.expect.status;

    const stepFn = async (ctx: TestContext, state: any): Promise<any> => {
      // Resolve client
      const client: HttpClient = (spec.client ?? this._defaultClient) as HttpClient;
      if (!client) {
        throw new Error(`No HTTP client for flow step "${name}". Set client on the step or flow.`);
      }

      // Resolve params/query/body from state
      const params = typeof spec.params === "function" ? spec.params(state) : spec.params;
      const resolvedPath = resolveParams(path, params);
      const query = typeof spec.query === "function" ? spec.query(state) : spec.query;
      const body = typeof spec.body === "function" ? (spec.body as Function)(state) : spec.body;

      // Build request options
      const opts: Record<string, unknown> = { throwHttpErrors: false };
      if (body !== undefined) opts.json = body;
      if (spec.headers) opts.headers = spec.headers;
      if (query) opts.searchParams = query;

      // Send request
      const methodLower = method.toLowerCase() as keyof HttpClient;
      const res = await (client[methodLower] as Function)(resolvedPath, opts);

      // Assert status
      ctx.expect(res).toHaveStatus(expectedStatus);

      // Validate schema + parse response
      let parsed: any;
      if (spec.expect.schema) {
        const jsonBody = await res.json();
        const validated = ctx.validate(jsonBody, spec.expect.schema, `${this._id}/${name} response`);
        parsed = validated !== undefined ? validated : jsonBody;
      } else if (spec.verify || spec.returns) {
        parsed = await res.json();
      }

      // Verify callback
      if (spec.verify) {
        await spec.verify(ctx, parsed);
      }

      // State evolution
      if (spec.returns) {
        return spec.returns(parsed, state);
      }
      return state;
    };

    this._steps.push({
      meta: { name, endpoint: spec.endpoint, expectStatus: expectedStatus },
      fn: stepFn,
    });

    return this as FlowBuilder<any>;
  }

  build(): Test & {
    readonly flowId: string;
    readonly flowSteps: FlowStepMeta[];
    asSteps(): <B>(b: import("./index.js").TestBuilder<B>) => import("./index.js").TestBuilder<B>;
  } {
    // Auto-imply: non-headless requires → defaultRun: "opt-in"
    const requires = this._requires ?? "headless";
    const defaultRun = this._defaultRun ?? (requires !== "headless" ? "opt-in" : "always");

    // Auto-tag
    const baseTags = this._tags ?? [];
    const runtimeTags: string[] = [];
    if (requires !== "headless") runtimeTags.push(`requires:${requires}`);
    if (defaultRun === "opt-in") runtimeTags.push("default-run:opt-in");
    const finalTags = [...baseTags, ...runtimeTags];

    const test: Test = {
      meta: {
        id: this._id,
        name: this._id,
        tags: finalTags.length > 0 ? finalTags : undefined,
        requires,
        defaultRun,
      },
      type: "steps",
      setup: this._setupFn as any,
      teardown: this._teardownFn as any,
      steps: this._steps.map((s) => ({
        meta: { name: s.meta.name },
        fn: s.fn,
      })),
    };

    const flowStepsMeta = this._steps.map((s) => s.meta);

    // Register to global registry with flow metadata
    registerTest({
      id: this._id,
      name: this._id,
      type: "steps",
      tags: finalTags.length > 0 ? finalTags : undefined,
      requires,
      defaultRun,
      steps: this._steps.map((s) => ({ name: s.meta.name })),
      hasSetup: !!this._setupFn,
      hasTeardown: !!this._teardownFn,
      flow: {
        steps: flowStepsMeta,
      },
    });

    const asSteps = () => {
      const steps = test.steps!;
      const setupFn = this._setupFn;
      const teardownFn = this._teardownFn;
      return <B>(b: import("./index.js").TestBuilder<B>) => {
        // Note: setup and teardown are injected as regular steps.
        // This means teardown does NOT have finally semantics —
        // if an earlier step fails, teardown won't run.
        // For guaranteed cleanup, use standalone flow or add
        // .teardown() on the outer test builder.
        if (setupFn) {
          b.step(`${this._id} [setup]`, async (ctx) => {
            return setupFn(ctx);
          });
        }
        // Inject flow steps
        for (const s of steps) {
          b.step(s.meta.name, async (ctx, state) => {
            return s.fn(ctx, state);
          });
        }
        // Inject teardown as last step if flow has one
        if (teardownFn) {
          b.step(`${this._id} [teardown]`, async (ctx, state) => {
            await teardownFn(ctx, state);
            return state;
          });
        }
        return b;
      };
    };

    return Object.assign(test, { flowId: this._id, flowSteps: flowStepsMeta, asSteps }) as any;
  }
}

function contractFlow(id: string, options?: { client?: HttpClient; tags?: string[] }): FlowBuilder {
  return new FlowBuilder(id, options);
}

// =============================================================================
// contract namespace + register()
// =============================================================================

const _adapters = new Map<string, ContractProtocolAdapter<any>>();

/**
 * The contract namespace.
 *
 * - `contract.http(id, spec)` — builtin HTTP contract
 * - `contract.register(protocol, adapter)` — plugin extension point
 * - `contract[protocol](id, spec)` — available after register()
 */
export const contract: {
  http: typeof contractHttp;
  flow: typeof contractFlow;
  register: <Spec>(protocol: string, adapter: ContractProtocolAdapter<Spec>) => void;
  [protocol: string]: unknown;
} = {
  http: contractHttp,
  flow: contractFlow,

  register<Spec>(protocol: string, adapter: ContractProtocolAdapter<Spec>) {
    if (protocol === "http" || protocol === "flow" || protocol === "register") {
      throw new Error(`Cannot register reserved protocol "${protocol}"`);
    }
    _adapters.set(protocol, adapter);

    // Dynamically attach contract[protocol]()
    (contract as any)[protocol] = (
      id: string,
      spec: Spec & { cases?: Record<string, { expect?: { status?: number }; deferred?: string; tags?: string[] }>; tags?: string[] },
    ): Test[] => {
      const meta = adapter.metadata(spec);
      const cases = spec.cases ?? {};
      const contractTags = spec.tags ? (Array.isArray(spec.tags) ? spec.tags : [spec.tags]) : [];

      const tests: Test[] = Object.entries(cases).map(([caseKey, caseSpec]) => {
        const testId = `${id}.${caseKey}`;
        const testName = `${id} — ${caseKey}`;
        const caseTags = caseSpec.tags ?? [];
        const allTags = [...contractTags, ...caseTags];

        const testDef: Test = {
          meta: {
            id: testId,
            name: testName,
            tags: allTags.length > 0 ? allTags : undefined,
            deferred: caseSpec.deferred,
          },
          type: "simple",
          fn: async (ctx) => {
            if (caseSpec.deferred) ctx.skip(caseSpec.deferred);
            await adapter.execute(ctx, caseSpec, spec);
          },
        };

        registerTest({
          id: testId,
          name: testName,
          type: "simple",
          tags: allTags.length > 0 ? allTags : undefined,
          groupId: id,
          contract: {
            endpoint: meta.endpoint ?? "",
            protocol,
            caseKey,
            expectStatus: caseSpec.expect?.status ?? 0,
            hasSchema: false,
            deferred: caseSpec.deferred,
          },
        });

        return testDef;
      });

      return tests;
    };
  },
};
