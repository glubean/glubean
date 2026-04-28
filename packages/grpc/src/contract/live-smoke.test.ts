/**
 * Live gRPC smoke test — reviewer gap priority #1.
 *
 * Validates that `grpcAdapter.execute` + `executeCaseInFlow` work end-to-end
 * against a REAL gRPC server (greeter), not just a mock GrpcClient.
 *
 * Scope: one happy-path unary call via each path (execute + flow). NOT
 * full coverage of real transport — that's Phase 2 (streaming + deadline
 * + metadata edge cases). This test exists to catch the specific class of
 * bugs where the mock client is "too clean" vs real gRPC envelope behavior.
 *
 * Reuses the existing `greeter.proto` + test-server pattern from
 * packages/grpc/src/index.test.ts.
 */

import { test, expect, afterEach, beforeEach, describe } from "vitest";
import * as grpcJs from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { contract, runFlow } from "@glubean/sdk";
import type { FlowContract, TestContext } from "@glubean/sdk";
import { clearRegistry } from "@glubean/sdk/internal";

import { createGrpcClient, type GrpcClient } from "../index.js";
import { grpcAdapter } from "./adapter.js";
import { createGrpcRoot } from "./factory.js";
import type { GrpcContractRoot, GrpcContractSpec } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(__dirname, "../../testdata/greeter.proto");

// ---------------------------------------------------------------------------
// Test server setup (mirrors startTestServer in index.test.ts)
// ---------------------------------------------------------------------------

interface TestServer {
  server: grpcJs.Server;
  port: number;
  address: string;
}

function startTestServer(): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    const proto = grpcJs.loadPackageDefinition(packageDefinition);
    const greeterPkg = (proto.test as grpcJs.GrpcObject).greeter as grpcJs.GrpcObject;
    const v1 = greeterPkg.v1 as grpcJs.GrpcObject;
    const GreeterService = v1.GreeterService as grpcJs.ServiceClientConstructor;

    const server = new grpcJs.Server();

    server.addService(GreeterService.service, {
      SayHello: (
        call: grpcJs.ServerUnaryCall<any, any>,
        callback: grpcJs.sendUnaryData<any>,
      ) => {
        const md = new grpcJs.Metadata();
        md.set("x-request-id", "contract-live-smoke");
        call.sendMetadata(md);
        callback(null, { message: `Hello, ${call.request.name}!` });
      },
    });

    server.bindAsync(
      "127.0.0.1:0",
      grpcJs.ServerCredentials.createInsecure(),
      (err, port) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({
          server,
          port,
          address: `127.0.0.1:${port}`,
        });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Mock TestContext (real-enough to run adapter without Glubean runner)
// ---------------------------------------------------------------------------

function makeCtx(partial: Partial<TestContext> = {}): TestContext {
  const ctx = {
    vars: { get: () => undefined, require: () => { throw new Error(); }, all: () => ({}) } as any,
    secrets: { get: () => undefined, require: () => { throw new Error(); } } as any,
    log: () => {},
    assert: (cond: unknown, message?: string) => {
      if (!cond) throw new Error(message ?? "assertion failed");
    },
    trace: () => {},
    action: () => {},
    event: () => {},
    metric: () => {},
    http: {} as any,
    fetch: {} as any,
    expect: ((v: unknown) => {
      const e: any = {
        toBe: (other: unknown) => {
          if (v !== other) throw new Error(`toBe: ${String(v)} !== ${String(other)}`);
        },
        toEqual: (other: unknown) => {
          if (JSON.stringify(v) !== JSON.stringify(other)) {
            throw new Error(`toEqual: mismatch`);
          }
        },
        toMatchObject: (partial: Record<string, unknown>) => {
          const src = v as Record<string, unknown>;
          for (const [k, expected] of Object.entries(partial)) {
            if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
              const nested = src?.[k];
              if (!nested) throw new Error(`toMatchObject: missing ${k}`);
              for (const [nk, nv] of Object.entries(expected)) {
                if ((nested as Record<string, unknown>)[nk] !== nv) {
                  throw new Error(`toMatchObject: .${k}.${nk} mismatch`);
                }
              }
            } else if (src?.[k] !== expected) {
              throw new Error(`toMatchObject: .${k} = ${String(src?.[k])}, expected ${String(expected)}`);
            }
          }
        },
        toHaveStatus: () => {},
        toMatchSchema: () => {},
      };
      return e;
    }) as any,
    validate: (data: unknown, schema: any) => {
      if (schema && typeof schema.safeParse === "function") {
        const parsed = schema.safeParse(data);
        if (!parsed.success) throw new Error(`validate failed`);
        return parsed.data;
      }
      return data;
    },
    skip: () => {},
    ci: {} as any,
    session: { get: () => undefined, set: () => {}, require: () => { throw new Error(); }, has: () => false, entries: () => ({}) } as any,
    run: {} as any,
    getMemoryUsage: () => null,
    ...partial,
  } as unknown as TestContext;
  return ctx;
}

// ---------------------------------------------------------------------------
// Registry bootstrap — fresh per-test
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearRegistry();
  contract.register("grpc", grpcAdapter);
  const dispatcher = (contract as any).grpc as Parameters<typeof createGrpcRoot>[0];
  (contract as unknown as { grpc: GrpcContractRoot }).grpc = createGrpcRoot(dispatcher);
});

// ---------------------------------------------------------------------------
// Live smoke tests
// ---------------------------------------------------------------------------

describe("live gRPC smoke — execute + flow paths against real server", () => {
  let server: grpcJs.Server | undefined;
  let client: GrpcClient | undefined;

  afterEach(async () => {
    if (client) {
      client.close();
      client = undefined;
    }
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.tryShutdown((err) => (err ? reject(err) : resolve()));
      });
      server = undefined;
    }
  });

  test("live execute: SayHello unary call succeeds end-to-end", async () => {
    const srv = await startTestServer();
    server = srv.server;

    client = createGrpcClient({
      proto: PROTO_PATH,
      address: srv.address,
      package: "test.greeter.v1",
      service: "GreeterService",
    });

    const spec: GrpcContractSpec = {
      target: "GreeterService/SayHello",
      client,
      cases: {
        ok: {
          description: "live server responds",
          expect: {
            statusCode: 0,
            message: { message: "Hello, alice!" },
          },
          request: { name: "alice" },
        },
      },
    };

    const ctx = makeCtx();
    // This is the critical path — the mock version passes but this exercises
    // the real transport envelope: proto serialization, metadata delivery,
    // status code over wire, response decoding.
    await grpcAdapter.execute(ctx, spec.cases.ok as any, spec as any);

    // If we reach here with no throw, both the server echo AND the adapter's
    // assertion against it round-trip correctly.
    expect(true).toBe(true);
  });

  test("live flow: contract.grpc case in a flow step works against real server", async () => {
    const srv = await startTestServer();
    server = srv.server;

    client = createGrpcClient({
      proto: PROTO_PATH,
      address: srv.address,
      package: "test.greeter.v1",
      service: "GreeterService",
    });

    const greeterContracts = (contract as any).grpc.with("greeter", { client });
    // v10 — case has needs schema; function-valued request builds wire
    // shape from the logical input that the flow lens supplies.
    const nameSchema = {
      safeParse: (d: unknown) => ({ success: true as const, data: d as { name: string } }),
    };
    const greeterContract = greeterContracts("say-hello", {
      target: "GreeterService/SayHello",
      cases: {
        ok: {
          description: "flow against real server",
          expect: { statusCode: 0 },
          needs: nameSchema,
          request: (input: { name: string }) => ({ name: input.name }),
        },
      },
    });

    let capturedMessage: string | undefined;

    const flowObj = contract
      .flow("live-greet-flow")
      .setup(async () => ({ name: "bob" }))
      .step(greeterContract.case("ok"), {
        in: (s: any) => ({ name: s.name }),
        out: (s: any, res: any) => {
          capturedMessage = res.message.message;
          return { ...s, greeting: res.message.message };
        },
      } as any)
      .build() as FlowContract<unknown>;

    await runFlow(flowObj, makeCtx());

    expect(capturedMessage).toBe("Hello, bob!");
  });

  test("live execute: response metadata flows through to adapter result", async () => {
    // Server sends x-request-id trailing metadata; verify adapter surfaces it
    // so classifyFailure / verify callbacks can inspect it.
    const srv = await startTestServer();
    server = srv.server;

    client = createGrpcClient({
      proto: PROTO_PATH,
      address: srv.address,
      package: "test.greeter.v1",
      service: "GreeterService",
    });

    let metadataSeenByVerify: Record<string, string> | undefined;

    const spec: GrpcContractSpec = {
      target: "GreeterService/SayHello",
      client,
      cases: {
        ok: {
          description: "verify sees response metadata",
          expect: { statusCode: 0 },
          request: { name: "world" },
          verify: (_ctx, res) => {
            metadataSeenByVerify = res.responseMetadata;
          },
        },
      },
    };

    const ctx = makeCtx();
    await grpcAdapter.execute(ctx, spec.cases.ok as any, spec as any);

    expect(metadataSeenByVerify).toBeDefined();
    // Server-side code sets x-request-id: contract-live-smoke
    expect(metadataSeenByVerify).toMatchObject({
      "x-request-id": "contract-live-smoke",
    });
  });
});
