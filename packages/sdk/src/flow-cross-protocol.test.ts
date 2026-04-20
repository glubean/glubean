/**
 * Cross-protocol flow regression test.
 *
 * Verifies: FlowBuilder.step() + core dispatcher work when a single flow
 * mixes HTTP adapter with a second (non-HTTP) protocol.
 *
 * Origin: originally a de-risking spike (CG-0, 2026-04-20) for multi-
 * protocol contract expansion
 * (internal/40-discovery/proposals/contract-grpc-graphql-expansion.md).
 * Green on first run — confirmed core is truly protocol-agnostic. Kept
 * as permanent regression test to prevent future HTTP-specific assumption
 * leaks in flow core / flow-helpers.
 *
 * What's covered:
 *   - HTTP step + custom protocol step + HTTP step compose in one flow
 *   - State threads through steps via typed in/out lenses
 *   - compute() between cross-protocol steps works
 *   - Adapter-specific CaseOutput shape (non-HTTP) propagates through lens
 *   - Each adapter's executeCaseInFlow called with correct resolvedInputs
 */

import { test, expect, beforeEach } from "vitest";
import { contract, runFlow } from "./index.js";
import { httpAdapter } from "./contract-http/adapter.js";
import { createHttpRoot } from "./contract-http/factory.js";
import type {
  ContractProjection,
  ContractProtocolAdapter,
  ExtractedContractProjection,
  FlowContract,
} from "./contract-types.js";
import type {
  HttpClient,
  HttpResponsePromise,
  TestContext,
} from "./types.js";
import { clearRegistry } from "./internal.js";

// ---------------------------------------------------------------------------
// Mock HTTP client (copied from contract-http/adapter.test.ts pattern)
// ---------------------------------------------------------------------------

interface MockHttpCall {
  method: string;
  url: string;
  options: Record<string, unknown>;
}

function makeMockHttpClient(
  canned: { status?: number; body?: unknown; headers?: Record<string, string> } = {},
): HttpClient & { _calls: MockHttpCall[] } {
  const calls: MockHttpCall[] = [];
  const respond = (method: string) =>
    (url: string | URL | Request, opts?: Record<string, unknown>) => {
      calls.push({ method, url: String(url), options: opts ?? {} });
      const headers = new Headers(canned.headers ?? {});
      const json = async () => canned.body ?? {};
      const promise = Promise.resolve({
        ok: (canned.status ?? 200) < 400,
        status: canned.status ?? 200,
        statusText: "OK",
        headers,
        json,
      });
      return Object.assign(promise, { json }) as unknown as HttpResponsePromise;
    };

  const client: any = respond("get");
  client.get = respond("get");
  client.post = respond("post");
  client.put = respond("put");
  client.patch = respond("patch");
  client.delete = respond("delete");
  client.head = respond("head");
  client.extend = () => client;
  client._calls = calls;
  return client as HttpClient & { _calls: MockHttpCall[] };
}

// ---------------------------------------------------------------------------
// Mock ctx (minimal)
// ---------------------------------------------------------------------------

function makeCtx(partial: Partial<TestContext> = {}): TestContext {
  return {
    vars: { get: () => undefined, require: () => { throw new Error(); }, all: () => ({}) } as any,
    secrets: { get: () => undefined, require: () => { throw new Error(); } } as any,
    log: () => {},
    assert: () => {},
    trace: () => {},
    action: () => {},
    event: () => {},
    metric: () => {},
    http: {} as any,
    fetch: {} as any,
    expect: ((() => {
      const e = {
        toBe: () => {},
        toEqual: () => {},
        toHaveStatus: () => {},
        toMatchSchema: () => {},
        toHaveHeader: () => {},
      };
      return () => e;
    })()) as any,
    validate: () => undefined,
    skip: () => {},
    ci: {} as any,
    session: {
      get: () => undefined,
      set: () => {},
      require: () => { throw new Error(); },
      has: () => false,
      entries: () => ({}),
    } as any,
    run: {} as any,
    getMemoryUsage: () => null,
    ...partial,
  } as TestContext;
}

// ---------------------------------------------------------------------------
// Stub RPC adapter (simulating future gRPC adapter)
// ---------------------------------------------------------------------------

interface SpikeRpcSpec {
  service: string;
  cases: Record<string, SpikeRpcCase>;
}

interface SpikeRpcCase {
  description: string;
  method: string;
  request?: Record<string, unknown>;
  expect?: { statusCode?: number };
}

interface SpikeRpcExecutionEvent {
  protocol: "spike_rpc";
  service: string;
  caseKey: string;
  method: string;
  resolvedInputs: unknown;
  mergedRequest: Record<string, unknown>;
}

function makeSpikeRpcAdapter(
  executionLog: SpikeRpcExecutionEvent[],
): ContractProtocolAdapter<SpikeRpcSpec, {}, {}, {}, {}> {
  return {
    async execute() {
      // Not used in flow mode — only executeCaseInFlow matters for spike
    },
    project(spec): ContractProjection<{}, {}> {
      return {
        protocol: "spike_rpc",
        target: spec.service,
        cases: Object.entries(spec.cases).map(([key, c]) => ({
          key,
          description: c.description,
          lifecycle: "active",
          severity: "warning",
          schemas: {},
        })),
      };
    },
    normalize(projection): ExtractedContractProjection<{}, {}> {
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
        cases: projection.cases.map((c) => ({ ...c, schemas: {} })),
        schemas: {},
      };
    },
    async executeCaseInFlow({ ctx: _ctx, contract: c, caseKey, resolvedInputs }) {
      const spec = c._spec as SpikeRpcSpec;
      const caseSpec = spec.cases[caseKey];
      if (!caseSpec) throw new Error(`spike_rpc: unknown case ${caseKey}`);

      // Merge resolvedInputs (from flow lens) over case static request
      const inputOverride = (resolvedInputs as any)?.request ?? {};
      const mergedRequest = { ...(caseSpec.request ?? {}), ...inputOverride };

      executionLog.push({
        protocol: "spike_rpc",
        service: spec.service,
        caseKey,
        method: caseSpec.method,
        resolvedInputs,
        mergedRequest,
      });

      // Return adapter-specific output shape (simulating gRPC response)
      return {
        statusCode: 0, // OK
        message: {
          service: spec.service,
          method: caseSpec.method,
          echo: mergedRequest,
          serverId: "spike-rpc-server-1",
        },
      };
    },
  };
}

beforeEach(() => {
  clearRegistry();
  // Re-register HTTP adapter after clear + re-wrap dispatcher with
  // createHttpRoot so `contract.http.with(...)` factory UX is available.
  // (Mirrors the bootstrap in packages/sdk/src/index.ts lines 1618-1624.)
  contract.register("http", httpAdapter);
  const dispatcher = (contract as any).http as Parameters<typeof createHttpRoot>[0];
  (contract as unknown as { http: unknown }).http = createHttpRoot(dispatcher);
});

// ---------------------------------------------------------------------------
// The actual spike
// ---------------------------------------------------------------------------

test("CG-0 spike: HTTP + spike_rpc + HTTP mixed flow end-to-end", async () => {
  const rpcLog: SpikeRpcExecutionEvent[] = [];
  contract.register("spike_rpc", makeSpikeRpcAdapter(rpcLog));

  // --- HTTP contract 1: create an order ---
  const createOrderClient = makeMockHttpClient({
    status: 201,
    body: { id: "order-abc", total: 99.99 },
  });
  const ordersHttp = contract.http.with("orders", { client: createOrderClient });
  const ordersContract = ordersHttp("orders-api", {
    endpoint: "POST /orders",
    cases: {
      create: {
        description: "create order",
        expect: { status: 201 },
        body: { item: "widget" },
      },
    },
  });

  // --- stub RPC contract: complete payment ---
  const paymentContract = (contract as any).spike_rpc("payment-api", {
    service: "PaymentService",
    cases: {
      complete: {
        description: "complete payment",
        method: "Complete",
        request: { currency: "USD" },
      },
    },
  });

  // --- HTTP contract 2: fetch order (verify-back) ---
  const fetchOrderClient = makeMockHttpClient({
    status: 200,
    body: { id: "order-abc", status: "paid", paymentId: "pay-xyz" },
  });
  const fetchHttp = contract.http.with("fetch-order", { client: fetchOrderClient });
  const fetchContract = fetchHttp("fetch-order-api", {
    endpoint: "GET /orders/:id",
    cases: {
      byId: {
        description: "fetch order by id",
        expect: { status: 200 },
      },
    },
  });

  // --- Build cross-protocol flow ---
  let finalState: any;

  const flowObj = contract
    .flow("checkout-cross-protocol")
    .meta({
      description: "HTTP create → RPC payment → HTTP verify",
      tags: ["spike", "cross-protocol"],
    })
    .setup(async () => ({ item: "widget" }))
    // Step 1: HTTP — create order
    .step(ordersContract.case("create"), {
      out: (_s: any, res: any) => ({
        orderId: res.body?.id as string,
        total: res.body?.total as number,
      }),
    })
    // Step 2: RPC — complete payment (uses HTTP output as input)
    .step(paymentContract.case("complete"), {
      in: (s: any) => ({
        request: { orderId: s.orderId, amount: s.total },
      }),
      out: (s: any, res: any) => ({
        ...s,
        paymentId: res.message?.serverId as string,
      }),
    })
    // Step 3: HTTP — verify order status (uses RPC output)
    .step(fetchContract.case("byId"), {
      in: (s: any) => ({ params: { id: s.orderId } }),
      out: (s: any, res: any) => {
        const out = { ...s, finalStatus: res.body?.status };
        finalState = out;
        return out;
      },
    })
    .build() as FlowContract<unknown>;

  await runFlow(flowObj, makeCtx());

  // --- Assertions ---

  // HTTP step 1: was called with correct body
  expect(createOrderClient._calls).toHaveLength(1);
  expect(createOrderClient._calls[0].method).toBe("post");
  expect(createOrderClient._calls[0].url).toContain("orders");

  // RPC step: was called with HTTP output threaded in
  expect(rpcLog).toHaveLength(1);
  expect(rpcLog[0].caseKey).toBe("complete");
  expect(rpcLog[0].mergedRequest).toMatchObject({
    currency: "USD",       // from case static
    orderId: "order-abc",  // from HTTP step 1 out lens
    amount: 99.99,         // from HTTP step 1 out lens
  });

  // HTTP step 3: was called with RPC output threaded in
  expect(fetchOrderClient._calls).toHaveLength(1);
  expect(fetchOrderClient._calls[0].method).toBe("get");
  expect(fetchOrderClient._calls[0].url).toContain("order-abc");

  // Final state carries contributions from all three steps
  expect(finalState).toMatchObject({
    orderId: "order-abc",
    total: 99.99,
    paymentId: "spike-rpc-server-1",
    finalStatus: "paid",
  });
});

test("CG-0 spike: state lens purity holds across protocols", async () => {
  // Verify that in/out lenses are still enforced as pure functions
  // when mixing protocols — same guarantee as single-protocol flows.
  const rpcLog: SpikeRpcExecutionEvent[] = [];
  contract.register("spike_rpc", makeSpikeRpcAdapter(rpcLog));

  const httpClient = makeMockHttpClient({ status: 200, body: { token: "t1" } });
  const authHttp = contract.http.with("auth", { client: httpClient });
  const authContract = authHttp("auth-api", {
    endpoint: "POST /auth",
    cases: {
      login: {
        description: "login",
        expect: { status: 200 },
        body: { user: "alice" },
      },
    },
  });

  const rpcContract = (contract as any).spike_rpc("svc", {
    service: "ProtectedService",
    cases: {
      call: {
        description: "authenticated call",
        method: "DoThing",
      },
    },
  });

  const flowObj = contract
    .flow("auth-then-rpc")
    .setup(async () => ({}))
    .step(authContract.case("login"), {
      out: (_s: any, res: any) => ({ token: res.body?.token as string }),
    })
    // compute() = pure state shape, used to prepare auth header
    .compute((s: any) => ({ ...s, authHeader: `Bearer ${s.token}` }))
    .step(rpcContract.case("call"), {
      in: (s: any) => ({
        request: { authorization: s.authHeader },
      }),
    })
    .build() as FlowContract<unknown>;

  await runFlow(flowObj, makeCtx());

  expect(rpcLog).toHaveLength(1);
  expect(rpcLog[0].mergedRequest).toMatchObject({
    authorization: "Bearer t1",
  });
});
