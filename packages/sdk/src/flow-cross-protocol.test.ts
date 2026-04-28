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
import { grpcAdapter, createGrpcRoot } from "../../grpc/src/contract/index.js";
import {
  graphqlAdapter,
  createGraphqlRoot,
} from "../../graphql/src/contract/index.js";
import type {
  ContractProjection,
  ContractProtocolAdapter,
  ExtractedContractProjection,
  FlowContract,
} from "./contract-types.js";
import type {
  HttpClient,
  HttpResponsePromise,
  SchemaLike,
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

interface MockGrpcCall {
  method: string;
  request: Record<string, unknown>;
  options: Record<string, unknown>;
}

function makeMockGrpcClient(
  resolveMessage: (call: MockGrpcCall) => Record<string, unknown>,
) {
  const calls: MockGrpcCall[] = [];
  return {
    _calls: calls,
    async call(
      method: string,
      request: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) {
      const call = { method, request, options: options ?? {} };
      calls.push(call);
      return {
        message: resolveMessage(call),
        status: { code: 0, details: "OK" },
        responseMetadata: { "x-grpc-trace": "grpc-1" },
        duration: 1,
      };
    },
    close() {},
    raw: {},
  };
}

interface MockGraphqlCall {
  operation: "query" | "mutation";
  document: string;
  options: {
    variables?: Record<string, unknown>;
    headers?: Record<string, string>;
    operationName?: string;
  };
}

function makeMockGraphqlClient(
  resolveData: (call: MockGraphqlCall) => Record<string, unknown>,
) {
  const calls: MockGraphqlCall[] = [];
  const run = async (
    operation: MockGraphqlCall["operation"],
    document: string,
    options?: MockGraphqlCall["options"],
  ) => {
    const call = { operation, document, options: options ?? {} };
    calls.push(call);
    return {
      data: resolveData(call),
      errors: undefined,
      httpStatus: 200,
      headers: { "content-type": "application/json" },
      rawBody: null,
    };
  };
  return {
    _calls: calls,
    query: (document: string, options?: MockGraphqlCall["options"]) =>
      run("query", document, options),
    mutate: (document: string, options?: MockGraphqlCall["options"]) =>
      run("mutation", document, options),
  };
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
        toMatchObject: () => {},
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
        needs: {} as SchemaLike<{ id: string }>,
        params: ({ id }: { id: string }) => ({ id }),
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
    // Step 3: HTTP — verify order status (uses RPC output). v10 logical
    // input shape: case declares `needs: { id }`, `in` returns `{ id }`,
    // and `params` function resolves URL. gRPC step above keeps v9 adapter-
    // patch shape (Option X: gRPC flow migration deferred to Spike 4).
    .step(fetchContract.case("byId"), {
      in: (s: any) => ({ id: s.orderId }),
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

test("first-party adapters: HTTP + gRPC + GraphQL flow passes logical input across protocols", async () => {
  contract.register("grpc", grpcAdapter);
  const grpcDispatcher = (contract as any)
    .grpc as Parameters<typeof createGrpcRoot>[0];
  (contract as unknown as { grpc: unknown }).grpc = createGrpcRoot(grpcDispatcher);

  contract.register("graphql", graphqlAdapter);
  const graphqlDispatcher = (contract as any)
    .graphql as Parameters<typeof createGraphqlRoot>[0];
  (contract as unknown as { graphql: unknown }).graphql =
    createGraphqlRoot(graphqlDispatcher);

  const createOrderClient = makeMockHttpClient({
    status: 201,
    body: { id: "order-42", total: 49.5 },
  });
  const ordersHttp = contract.http.with("orders", { client: createOrderClient });
  const createOrder = ordersHttp("create-order", {
    endpoint: "POST /orders",
    cases: {
      ok: {
        description: "create order",
        body: { sku: "sku-1" },
        expect: { status: 201 },
      },
    },
  });

  const paymentGrpcClient = makeMockGrpcClient((call) => ({
    paymentId: `pay-${call.request.orderId}`,
    chargedAmount: call.request.amount,
    auth: (call.options.metadata as Record<string, string> | undefined)
      ?.authorization,
  }));
  const payments = (contract as any).grpc.with("payments", {
    client: paymentGrpcClient,
  });
  const capturePayment = payments("capture-payment", {
    target: "PaymentService/Capture",
    defaultMetadata: { "x-service": "orders" },
    cases: {
      capture: {
        description: "capture order payment",
        needs: {} as SchemaLike<{ orderId: string; amount: number }>,
        request: ({ orderId, amount }: { orderId: string; amount: number }) => ({
          orderId,
          amount,
        }),
        metadata: ({ orderId }: { orderId: string }) => ({
          authorization: `Bearer ${orderId}`,
        }),
        expect: {
          statusCode: 0,
          message: { paymentId: "pay-order-42" },
        },
      },
    },
  });

  const auditGraphqlClient = makeMockGraphqlClient((call) => ({
    order: {
      id: call.options.variables?.orderId,
      paymentId: call.options.variables?.paymentId,
      auditToken: call.options.headers?.authorization,
    },
  }));
  const audit = (contract as any).graphql.with("audit", {
    client: auditGraphqlClient,
    endpoint: "/graphql",
  });
  const auditOrder = audit("audit-order", {
    cases: {
      lookup: {
        description: "lookup audited order",
        needs: {} as SchemaLike<{ orderId: string; paymentId: string }>,
        query: `query AuditOrder($orderId: ID!, $paymentId: ID!) {
          order(id: $orderId) { id paymentId auditToken }
        }`,
        variables: ({
          orderId,
          paymentId,
        }: {
          orderId: string;
          paymentId: string;
        }) => ({ orderId, paymentId }),
        headers: ({ paymentId }: { paymentId: string }) => ({
          authorization: `Payment ${paymentId}`,
        }),
        expect: {
          httpStatus: 200,
          data: {
            order: {
              id: "order-42",
              paymentId: "pay-order-42",
            },
          },
        },
      },
    },
  });

  let finalState: unknown;
  const flowObj = contract
    .flow("http-grpc-graphql-checkout")
    .meta({
      description:
        "HTTP order creation, gRPC payment capture, GraphQL audit lookup",
      tags: ["cross-protocol"],
    })
    .step(createOrder.case("ok"), {
      out: (_state, res: any) => ({
        orderId: res.body.id as string,
        total: res.body.total as number,
      }),
    })
    .step(capturePayment.case("capture"), {
      in: (state: any) => ({
        orderId: state.orderId,
        amount: state.total,
      }),
      out: (state: any, res: any) => ({
        ...state,
        paymentId: res.message.paymentId as string,
      }),
    })
    .step(auditOrder.case("lookup"), {
      in: (state: any) => ({
        orderId: state.orderId,
        paymentId: state.paymentId,
      }),
      out: (state: any, res: any) => {
        finalState = { ...state, audit: res.data.order };
        return finalState as Record<string, unknown>;
      },
    })
    .build() as FlowContract<unknown>;

  await runFlow(flowObj, makeCtx());

  expect(createOrderClient._calls).toHaveLength(1);
  expect(createOrderClient._calls[0].method).toBe("post");

  expect(paymentGrpcClient._calls).toHaveLength(1);
  expect(paymentGrpcClient._calls[0]).toMatchObject({
    method: "Capture",
    request: { orderId: "order-42", amount: 49.5 },
  });
  expect(paymentGrpcClient._calls[0].options).toMatchObject({
    metadata: {
      "x-service": "orders",
      authorization: "Bearer order-42",
    },
  });

  expect(auditGraphqlClient._calls).toHaveLength(1);
  expect(auditGraphqlClient._calls[0]).toMatchObject({
    operation: "query",
    options: {
      variables: { orderId: "order-42", paymentId: "pay-order-42" },
      headers: { authorization: "Payment pay-order-42" },
      operationName: "AuditOrder",
    },
  });

  expect(finalState).toMatchObject({
    orderId: "order-42",
    total: 49.5,
    paymentId: "pay-order-42",
    audit: {
      id: "order-42",
      paymentId: "pay-order-42",
      auditToken: "Payment pay-order-42",
    },
  });
});
