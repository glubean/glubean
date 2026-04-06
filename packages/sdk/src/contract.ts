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
} from "./contract-types.js";
import type { HttpClient, Test, TestMeta } from "./types.js";
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

  const meta: TestMeta = {
    id: testId,
    name: testName,
    tags: allTags.length > 0 ? allTags : undefined,
    deferred: c.deferred,
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
    tags: allTags.length > 0 ? allTags : undefined,
    groupId: contractId,
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
  register: <Spec>(protocol: string, adapter: ContractProtocolAdapter<Spec>) => void;
  [protocol: string]: unknown;
} = {
  http: contractHttp,

  register<Spec>(protocol: string, adapter: ContractProtocolAdapter<Spec>) {
    if (protocol === "http" || protocol === "register") {
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
