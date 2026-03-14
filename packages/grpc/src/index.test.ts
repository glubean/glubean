/**
 * Tests for @glubean/grpc plugin.
 *
 * Spins up a real gRPC server per test to verify unary calls end-to-end.
 */

import { test, expect, afterEach } from "vitest";
import * as grpcJs from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createGrpcClient, grpc } from "./index.js";
import type { GrpcClient } from "./index.js";
import type { GlubeanRuntime } from "@glubean/sdk";

// =============================================================================
// Test helpers
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(__dirname, "../testdata/greeter.proto");

interface TestServer {
  server: grpcJs.Server;
  port: number;
  address: string;
}

/**
 * Start a real gRPC server with the greeter service.
 * Returns the server and the dynamically assigned port.
 */
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
    const greeterPkg = (proto.test as grpcJs.GrpcObject)
      .greeter as grpcJs.GrpcObject;
    const v1 = greeterPkg.v1 as grpcJs.GrpcObject;
    const GreeterService = v1.GreeterService as grpcJs.ServiceClientConstructor;

    const server = new grpcJs.Server();

    server.addService(GreeterService.service, {
      SayHello: (
        call: grpcJs.ServerUnaryCall<any, any>,
        callback: grpcJs.sendUnaryData<any>,
      ) => {
        const md = new grpcJs.Metadata();
        md.set("x-request-id", "test-123");
        call.sendMetadata(md);
        callback(null, { message: `Hello, ${call.request.name}!` });
      },
      SayGoodbye: (
        call: grpcJs.ServerUnaryCall<any, any>,
        callback: grpcJs.sendUnaryData<any>,
      ) => {
        callback(null, { message: `Goodbye, ${call.request.name}!` });
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

/**
 * Start a gRPC server that checks the "authorization" metadata.
 * Returns UNAUTHENTICATED if missing/wrong, echoes the token in the reply if correct.
 */
function startAuthServer(expectedToken: string): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    const proto = grpcJs.loadPackageDefinition(packageDefinition);
    const greeterPkg = (proto.test as grpcJs.GrpcObject)
      .greeter as grpcJs.GrpcObject;
    const v1 = greeterPkg.v1 as grpcJs.GrpcObject;
    const GreeterService = v1.GreeterService as grpcJs.ServiceClientConstructor;

    const server = new grpcJs.Server();

    server.addService(GreeterService.service, {
      SayHello: (
        call: grpcJs.ServerUnaryCall<any, any>,
        callback: grpcJs.sendUnaryData<any>,
      ) => {
        const auth = call.metadata.get("authorization")[0] as string | undefined;
        if (!auth || auth !== expectedToken) {
          callback({
            code: grpcJs.status.UNAUTHENTICATED,
            details: "invalid or missing authorization",
          } as any);
          return;
        }
        callback(null, { message: `Authenticated: ${call.request.name}` });
      },
      SayGoodbye: (
        call: grpcJs.ServerUnaryCall<any, any>,
        callback: grpcJs.sendUnaryData<any>,
      ) => {
        callback(null, { message: `Goodbye, ${call.request.name}!` });
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
        resolve({ server, port, address: `127.0.0.1:${port}` });
      },
    );
  });
}

function stopServer(server: grpcJs.Server): Promise<void> {
  return new Promise((resolve) => {
    server.tryShutdown(() => resolve());
  });
}

function createMockRuntime(
  vars: Record<string, string> = {},
  secrets: Record<string, string> = {},
): GlubeanRuntime {
  const allValues = { ...vars, ...secrets };
  return {
    vars,
    secrets,
    http: {} as any,
    requireVar(key: string): string {
      const val = vars[key];
      if (val === undefined) throw new Error(`Missing var: ${key}`);
      return val;
    },
    requireSecret(key: string): string {
      const val = secrets[key];
      if (val === undefined) throw new Error(`Missing secret: ${key}`);
      return val;
    },
    resolveTemplate(template: string): string {
      return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
        const val = allValues[key];
        if (val === undefined) return `{{${key}}}`;
        return val;
      });
    },
    action() {},
    event() {},
    log() {},
  };
}

// =============================================================================
// createGrpcClient - unary calls
// =============================================================================

let testServer: TestServer | null = null;
let client: GrpcClient | null = null;

afterEach(async () => {
  client?.close();
  client = null;
  if (testServer) {
    await stopServer(testServer.server);
    testServer = null;
  }
});

test("createGrpcClient - SayHello returns greeting", async () => {
  testServer = await startTestServer();
  client = createGrpcClient({
    proto: PROTO_PATH,
    address: testServer.address,
    package: "test.greeter.v1",
    service: "GreeterService",
  });

  const res = await client.call("SayHello", { name: "World" });

  expect(res.status.code).toBe(0);
  expect(res.status.details).toBe("OK");
  expect((res.message as any).message).toBe("Hello, World!");
  expect(res.duration).toBeGreaterThanOrEqual(0);
  expect(res.responseMetadata["x-request-id"]).toBe("test-123");
});

test("createGrpcClient - SayGoodbye returns farewell", async () => {
  testServer = await startTestServer();
  client = createGrpcClient({
    proto: PROTO_PATH,
    address: testServer.address,
    package: "test.greeter.v1",
    service: "GreeterService",
  });

  const res = await client.call("SayGoodbye", { name: "Alice" });

  expect(res.status.code).toBe(0);
  expect((res.message as any).message).toBe("Goodbye, Alice!");
});

test("createGrpcClient - method not found rejects", async () => {
  testServer = await startTestServer();
  client = createGrpcClient({
    proto: PROTO_PATH,
    address: testServer.address,
    package: "test.greeter.v1",
    service: "GreeterService",
  });

  await expect(
    client.call("NonExistentMethod", {}),
  ).rejects.toThrow('Method "NonExistentMethod" not found');
});

test("createGrpcClient - wrong service name throws", () => {
  expect(
    () =>
      createGrpcClient({
        proto: PROTO_PATH,
        address: "127.0.0.1:0",
        package: "test.greeter.v1",
        service: "NonExistentService",
      }),
  ).toThrow('Service "NonExistentService" not found');
});

test("createGrpcClient - wrong package name throws", () => {
  expect(
    () =>
      createGrpcClient({
        proto: PROTO_PATH,
        address: "127.0.0.1:0",
        package: "nonexistent.package",
        service: "GreeterService",
      }),
  ).toThrow('Package "nonexistent.package" not found');
});

test("createGrpcClient - emits trace event on success", async () => {
  testServer = await startTestServer();

  const events: any[] = [];
  client = createGrpcClient(
    {
      proto: PROTO_PATH,
      address: testServer.address,
      package: "test.greeter.v1",
      service: "GreeterService",
    },
    { event: (ev) => events.push(ev) },
  );

  await client.call("SayHello", { name: "Trace" });

  expect(events.length).toBe(1);
  expect(events[0].type).toBe("trace");
  expect(events[0].data.protocol).toBe("grpc");
  expect(events[0].data.target).toBe("GreeterService/SayHello");
  expect(events[0].data.ok).toBe(true);
  expect(events[0].data.status).toBe(0);
  expect(events[0].data.durationMs).toBeGreaterThanOrEqual(0);
  expect(events[0].data.service).toBe("GreeterService");
  expect(events[0].data.method).toBe("SayHello");
  expect(events[0].data.peer).toBe(testServer.address);
  expect(events[0].data.request).toEqual({ name: "Trace" });
  expect(events[0].data.response.message).toBe("Hello, Trace!");
});

test("createGrpcClient - emits trace event with ok=false on error", async () => {
  const events: any[] = [];
  client = createGrpcClient(
    {
      proto: PROTO_PATH,
      address: "127.0.0.1:1", // unreachable
      package: "test.greeter.v1",
      service: "GreeterService",
      deadlineMs: 500,
    },
    { event: (ev) => events.push(ev) },
  );

  const res = await client.call("SayHello", { name: "Fail" });

  expect(res.status.code).not.toBe(0);
  expect(events.length).toBe(1);
  expect(events[0].type).toBe("trace");
  expect(events[0].data.ok).toBe(false);
});

// =============================================================================
// createGrpcClient - metadata
// =============================================================================

test("createGrpcClient - sends static metadata", async () => {
  // We test metadata indirectly — if the server responds, metadata was accepted
  testServer = await startTestServer();
  client = createGrpcClient({
    proto: PROTO_PATH,
    address: testServer.address,
    package: "test.greeter.v1",
    service: "GreeterService",
    metadata: { "x-request-id": "test-123" },
  });

  const res = await client.call("SayHello", { name: "Meta" });
  expect(res.status.code).toBe(0);
});

test("createGrpcClient - per-call metadata merges with static", async () => {
  testServer = await startTestServer();
  client = createGrpcClient({
    proto: PROTO_PATH,
    address: testServer.address,
    package: "test.greeter.v1",
    service: "GreeterService",
    metadata: { "x-static": "base" },
  });

  const res = await client.call("SayHello", { name: "Merge" }, {
    metadata: { "x-dynamic": "extra" },
  });
  expect(res.status.code).toBe(0);
});

test("createGrpcClient - trace includes merged metadata (static + per-call)", async () => {
  testServer = await startTestServer();
  const events: any[] = [];
  client = createGrpcClient(
    {
      proto: PROTO_PATH,
      address: testServer.address,
      package: "test.greeter.v1",
      service: "GreeterService",
      metadata: { "x-static": "base" },
    },
    { event: (ev) => events.push(ev) },
  );

  await client.call("SayHello", { name: "Meta" }, {
    metadata: { "x-dynamic": "extra" },
  });

  expect(events[0].data.metadata).toEqual({
    "x-static": "base",
    "x-dynamic": "extra",
  });
});

// =============================================================================
// createGrpcClient - deadline
// =============================================================================

test("createGrpcClient - per-call deadline overrides default", async () => {
  testServer = await startTestServer();
  client = createGrpcClient({
    proto: PROTO_PATH,
    address: testServer.address,
    package: "test.greeter.v1",
    service: "GreeterService",
    deadlineMs: 100,
  });

  // Override with a generous deadline — should succeed
  const res = await client.call(
    "SayHello",
    { name: "Deadline" },
    { deadlineMs: 10_000 },
  );
  expect(res.status.code).toBe(0);
});

// =============================================================================
// grpc() plugin factory
// =============================================================================

test("grpc() - returns a PluginFactory with create method", () => {
  const factory = grpc({
    proto: PROTO_PATH,
    address: "localhost:50051",
    package: "test.greeter.v1",
    service: "GreeterService",
  });
  expect(typeof factory.create).toBe("function");
});

test("grpc() - resolves address template", async () => {
  testServer = await startTestServer();

  const factory = grpc({
    proto: PROTO_PATH,
    address: "{{GREETER_ADDR}}",
    package: "test.greeter.v1",
    service: "GreeterService",
  });

  const runtime = createMockRuntime({ GREETER_ADDR: testServer.address });
  const grpcClient = factory.create(runtime);
  client = grpcClient; // for cleanup

  const res = await grpcClient.call("SayHello", { name: "Plugin" });
  expect(res.status.code).toBe(0);
  expect((res.message as any).message).toBe("Hello, Plugin!");
});

test("grpc() - resolves metadata templates from secrets", async () => {
  testServer = await startTestServer();

  const factory = grpc({
    proto: PROTO_PATH,
    address: "{{GREETER_ADDR}}",
    package: "test.greeter.v1",
    service: "GreeterService",
    metadata: { authorization: "Bearer {{API_TOKEN}}" },
  });

  const runtime = createMockRuntime(
    { GREETER_ADDR: testServer.address },
    { API_TOKEN: "secret-token-xyz" },
  );
  const grpcClient = factory.create(runtime);
  client = grpcClient;

  const res = await grpcClient.call("SayHello", { name: "Auth" });
  expect(res.status.code).toBe(0);
});

test("grpc() - plugin factory wires event hook for trace", async () => {
  testServer = await startTestServer();
  const events: any[] = [];

  const factory = grpc({
    proto: PROTO_PATH,
    address: "{{GREETER_ADDR}}",
    package: "test.greeter.v1",
    service: "GreeterService",
  });

  const runtime = createMockRuntime({ GREETER_ADDR: testServer.address });
  runtime.event = (ev: any) => events.push(ev);
  const grpcClient = factory.create(runtime);
  client = grpcClient;

  await grpcClient.call("SayHello", { name: "Action" });

  expect(events.length).toBe(1);
  expect(events[0].type).toBe("trace");
  expect(events[0].data.protocol).toBe("grpc");
  expect(events[0].data.ok).toBe(true);
});

// =============================================================================
// Auth: server-side verification
// =============================================================================

test("auth - correct token succeeds", async () => {
  testServer = await startAuthServer("Bearer valid-token");
  client = createGrpcClient({
    proto: PROTO_PATH,
    address: testServer.address,
    package: "test.greeter.v1",
    service: "GreeterService",
    metadata: { authorization: "Bearer valid-token" },
  });

  const res = await client.call("SayHello", { name: "Authed" });
  expect(res.status.code).toBe(0);
  expect((res.message as any).message).toBe("Authenticated: Authed");
});

test("auth - missing token returns UNAUTHENTICATED", async () => {
  testServer = await startAuthServer("Bearer valid-token");
  client = createGrpcClient({
    proto: PROTO_PATH,
    address: testServer.address,
    package: "test.greeter.v1",
    service: "GreeterService",
    // no metadata
  });

  const res = await client.call("SayHello", { name: "NoAuth" });
  expect(res.status.code).toBe(16); // UNAUTHENTICATED
  expect(res.status.details).toBe("invalid or missing authorization");
});

test("auth - wrong token returns UNAUTHENTICATED", async () => {
  testServer = await startAuthServer("Bearer valid-token");
  client = createGrpcClient({
    proto: PROTO_PATH,
    address: testServer.address,
    package: "test.greeter.v1",
    service: "GreeterService",
    metadata: { authorization: "Bearer wrong-token" },
  });

  const res = await client.call("SayHello", { name: "BadAuth" });
  expect(res.status.code).toBe(16);
});

test("auth - per-call metadata can override static auth", async () => {
  testServer = await startAuthServer("Bearer call-token");
  client = createGrpcClient({
    proto: PROTO_PATH,
    address: testServer.address,
    package: "test.greeter.v1",
    service: "GreeterService",
    metadata: { authorization: "Bearer wrong-token" },
  });

  // Static metadata has wrong token, but per-call overrides it
  const res = await client.call("SayHello", { name: "Override" }, {
    metadata: { authorization: "Bearer call-token" },
  });
  expect(res.status.code).toBe(0);
  expect((res.message as any).message).toBe("Authenticated: Override");
});

test("auth - plugin factory resolves auth from secrets", async () => {
  testServer = await startAuthServer("Bearer secret-abc");

  const factory = grpc({
    proto: PROTO_PATH,
    address: "{{ADDR}}",
    package: "test.greeter.v1",
    service: "GreeterService",
    metadata: { authorization: "Bearer {{TOKEN}}" },
  });

  const runtime = createMockRuntime(
    { ADDR: testServer.address },
    { TOKEN: "secret-abc" },
  );
  const grpcClient = factory.create(runtime);
  client = grpcClient;

  const res = await grpcClient.call("SayHello", { name: "SecretAuth" });
  expect(res.status.code).toBe(0);
  expect((res.message as any).message).toBe("Authenticated: SecretAuth");
});

// =============================================================================
// Trace event: auth error
// =============================================================================

test("trace - emits trace with ok=false on auth error", async () => {
  testServer = await startAuthServer("Bearer correct");
  const events: any[] = [];
  client = createGrpcClient(
    {
      proto: PROTO_PATH,
      address: testServer.address,
      package: "test.greeter.v1",
      service: "GreeterService",
    },
    { event: (ev) => events.push(ev) },
  );

  await client.call("SayHello", { name: "Fail" });

  expect(events.length).toBe(1);
  expect(events[0].type).toBe("trace");
  expect(events[0].data.ok).toBe(false);
  expect(events[0].data.status).toBe(16); // UNAUTHENTICATED
});
