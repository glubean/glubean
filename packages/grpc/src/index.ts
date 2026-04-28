/**
 * @glubean/grpc 0.2.0 — single-package owner of both:
 *   - Transport / test-plugin layer (this file — unchanged from 0.1.x)
 *   - Contract adapter layer (`./contract/`, installed via plugin manifest)
 *
 * Install the default plugin manifest from glubean.setup.ts to register the
 * gRPC contract adapter:
 *   `installPlugin(grpcPlugin)` → `contract.grpc.with(...)` UX.
 *
 * See `./contract/index.ts` for the registration logic. See
 * `internal/40-discovery/proposals/contract-grpc-graphql-expansion.md` §5.1
 * for the single-package rationale ("contract is a first-class citizen").
 *
 * Transport (this file) — provides a thin wrapper over `@grpc/grpc-js` that
 * simplifies unary gRPC calls with auto-tracing via Glubean events.
 *
 * ## Usage
 *
 * ### As a plugin via `configure()` (recommended)
 *
 * ```ts
 * import { test, configure } from "@glubean/sdk";
 * import { grpc } from "@glubean/grpc";
 *
 * const { users } = configure({
 *   plugins: {
 *     users: grpc({
 *       proto: "./protos/users.proto",
 *       address: "{{USER_SERVICE_ADDR}}",
 *       package: "acme.users.v1",
 *       service: "UsersService",
 *     }),
 *   },
 * });
 *
 * export const getUser = test("get-user", async (ctx) => {
 *   const res = await users.call("GetUser", { id: "u_123" });
 *   ctx.expect(res.status.code).toBe(0);
 *   ctx.expect(res.message.user.id).toBe("u_123");
 * });
 * ```
 *
 * ### Standalone (without `configure()`)
 *
 * ```ts
 * import { createGrpcClient } from "@glubean/grpc";
 *
 * const client = createGrpcClient({
 *   proto: "./protos/users.proto",
 *   address: "localhost:50051",
 *   package: "acme.users.v1",
 *   service: "UsersService",
 * });
 *
 * const res = await client.call("GetUser", { id: "u_123" });
 * ```
 *
 * @module grpc
 */

import type * as grpcTypes from "@grpc/grpc-js";
import { contract, defineClientFactory, definePlugin } from "@glubean/sdk";
import type {
  ClientFactory,
  GlubeanRuntime,
  PluginManifest,
} from "@glubean/sdk";
import { grpcAdapter } from "./contract/adapter.js";
import { createGrpcRoot } from "./contract/factory.js";
import { grpcMatchers } from "./contract/matchers.js";
import type { GrpcContractRoot } from "./contract/types.js";

let grpcJs: typeof grpcTypes;
let protoLoader: typeof import("@grpc/proto-loader");

try {
  grpcJs = await import("@grpc/grpc-js");
  protoLoader = await import("@grpc/proto-loader");
} catch {
  throw new Error(
    '@glubean/grpc requires "@grpc/grpc-js" and "@grpc/proto-loader" as peer dependencies.\n' +
      "Install them with:\n\n" +
      "  npm install @grpc/grpc-js @grpc/proto-loader\n",
  );
}

// =============================================================================
// Types
// =============================================================================

/** Options for creating a gRPC client. */
export interface GrpcClientOptions {
  /** Path to the .proto file */
  proto: string;
  /** gRPC server address (host:port) */
  address: string;
  /** Protobuf package name (e.g., "acme.users.v1") */
  package: string;
  /** Service name within the package (e.g., "UsersService") */
  service: string;
  /** Static metadata sent with every call */
  metadata?: Record<string, string>;
  /** Use TLS credentials. Default: false (insecure) */
  tls?: boolean;
  /** Default deadline in milliseconds for all calls */
  deadlineMs?: number;
}

/** gRPC status returned with every call. */
export interface GrpcStatus {
  /** gRPC status code (0 = OK) */
  code: number;
  /** Human-readable status details */
  details: string;
}

/** Result of a unary gRPC call. */
export interface GrpcCallResult<T = unknown> {
  /** Decoded response message */
  message: T;
  /** gRPC status */
  status: GrpcStatus;
  /** Response metadata from the server */
  responseMetadata: Record<string, string>;
  /** Duration of the call in milliseconds */
  duration: number;
}

/** Per-call options. */
export interface GrpcCallOptions {
  /** Override deadline for this call (ms) */
  deadlineMs?: number;
  /** Additional metadata for this call only */
  metadata?: Record<string, string>;
}

/** A gRPC client bound to a specific service. */
export interface GrpcClient {
  /** Make a unary RPC call. */
  call<T = unknown>(
    method: string,
    request: Record<string, unknown>,
    options?: GrpcCallOptions,
  ): Promise<GrpcCallResult<T>>;

  /** Close the underlying channel. */
  close(): void;

  /** The underlying `@grpc/grpc-js` client for direct access (streaming, channel state, etc.). */
  raw: grpcTypes.Client;
}

// =============================================================================
// Client implementation
// =============================================================================

/**
 * Resolve a nested package from a loaded proto definition.
 *
 * For example, `resolvePackage(def, "acme.users.v1")` traverses
 * `def.acme.users.v1`.
 */
function resolvePackage(
  packageDef: grpcTypes.GrpcObject,
  packageName: string,
): grpcTypes.GrpcObject {
  const parts = packageName.split(".");
  let current: grpcTypes.GrpcObject = packageDef;
  for (const part of parts) {
    const next = current[part];
    if (!next || typeof next !== "object") {
      throw new Error(
        `Package "${packageName}" not found in proto definition (failed at "${part}")`,
      );
    }
    current = next as grpcTypes.GrpcObject;
  }
  return current;
}

/**
 * Build gRPC metadata from a plain object.
 */
function buildMetadata(
  base?: Record<string, string>,
  extra?: Record<string, string>,
): grpcTypes.Metadata {
  const md = new grpcJs.Metadata();
  if (base) {
    for (const [k, v] of Object.entries(base)) {
      md.set(k, v);
    }
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      md.set(k, v);
    }
  }
  return md;
}

/** Hooks for Glubean runtime instrumentation. */
export interface GrpcHooks {
  trace?: (t: import("@glubean/sdk").Trace) => void;
}

/**
 * Create a gRPC client bound to a specific service.
 *
 * @param options Client configuration
 * @param hooks Optional Glubean runtime hooks for action/event/log
 * @returns A bound `GrpcClient` instance
 */
export function createGrpcClient(
  options: GrpcClientOptions,
  hooks?: GrpcHooks,
): GrpcClient {
  const packageDefinition = protoLoader.loadSync(options.proto, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });

  const packageDef = grpcJs.loadPackageDefinition(packageDefinition);
  const servicePkg = resolvePackage(packageDef, options.package);

  const ServiceConstructor = servicePkg[options.service] as
    | (new (
        address: string,
        credentials: grpcTypes.ChannelCredentials,
      ) => grpcTypes.Client)
    | undefined;

  if (!ServiceConstructor || typeof ServiceConstructor !== "function") {
    throw new Error(
      `Service "${options.service}" not found in package "${options.package}"`,
    );
  }

  const credentials = options.tls
    ? grpcJs.credentials.createSsl()
    : grpcJs.credentials.createInsecure();

  const client = new ServiceConstructor(options.address, credentials);

  return {
    call<T = unknown>(
      method: string,
      request: Record<string, unknown>,
      callOptions?: GrpcCallOptions,
    ): Promise<GrpcCallResult<T>> {
      return new Promise((resolve, reject) => {
        const fn = (client as any)[method];
        if (typeof fn !== "function") {
          reject(
            new Error(
              `Method "${method}" not found on service "${options.service}"`,
            ),
          );
          return;
        }

        const md = buildMetadata(options.metadata, callOptions?.metadata);

        const deadlineMs =
          callOptions?.deadlineMs ?? options.deadlineMs ?? 30_000;
        const deadline = new Date(Date.now() + deadlineMs);

        const target = `${options.service}/${method}`;

        // Merge static + per-call metadata into a plain object for tracing
        const mergedMetadata: Record<string, string> = {
          ...options.metadata,
          ...callOptions?.metadata,
        };

        const start = performance.now();
        let responseMetadata: Record<string, string> = {};

        const call = fn.call(
          client,
          request,
          md,
          { deadline },
          (err: grpcTypes.ServiceError | null, response: T) => {
            const durationMs = Math.round(performance.now() - start);

            if (err) {
              const status: GrpcStatus = {
                code: err.code ?? grpcJs.status.UNKNOWN,
                details: err.details ?? err.message,
              };

              // Extract response metadata from error if available
              if (err.metadata) {
                for (const [k, values] of Object.entries(err.metadata.getMap())) {
                  responseMetadata[k] = String(values);
                }
              }

              hooks?.trace?.({
                protocol: "grpc",
                target,
                status: status.code,
                durationMs,
                ok: false,
                requestBody: request,
                responseBody: response,
                metadata: {
                  service: options.service,
                  method,
                  peer: options.address,
                  requestMetadata: mergedMetadata,
                  responseMetadata,
                },
              });

              // Still resolve with status info instead of rejecting
              // This matches Glubean's pattern of returning results for assertions
              resolve({
                message: (response ?? {}) as T,
                status,
                responseMetadata,
                duration: durationMs,
              });
              return;
            }

            hooks?.trace?.({
              protocol: "grpc",
              target,
              status: grpcJs.status.OK,
              durationMs,
              ok: true,
              requestBody: request,
              responseBody: response,
              metadata: {
                service: options.service,
                method,
                peer: options.address,
                requestMetadata: mergedMetadata,
                responseMetadata,
              },
            });

            resolve({
              message: response,
              status: { code: grpcJs.status.OK, details: "OK" },
              responseMetadata,
              duration: durationMs,
            });
          },
        );

        // Capture response headers metadata
        call.on("metadata", (md: grpcTypes.Metadata) => {
          for (const [k, values] of Object.entries(md.getMap())) {
            responseMetadata[k] = String(values);
          }
        });
      });
    },

    close() {
      client.close();
    },

    raw: client,
  };
}

// =============================================================================
// Plugin factory
// =============================================================================

/**
 * Plugin options for use with `configure()`.
 * `address` supports `{{VAR}}` template syntax.
 * `metadata` values support `{{VAR}}` template syntax.
 */
export interface GrpcPluginOptions {
  /** Path to the .proto file */
  proto: string;
  /** Var key or `{{template}}` for the gRPC address */
  address: string;
  /** Protobuf package name */
  package: string;
  /** Service name */
  service: string;
  /** Metadata with `{{template}}` support */
  metadata?: Record<string, string>;
  /** Use TLS */
  tls?: boolean;
  /** Default deadline in ms */
  deadlineMs?: number;
}

/**
 * Create a gRPC plugin for use with `configure({ plugins })`.
 *
 * Resolves `{{template}}` placeholders in `address` and `metadata` using
 * the Glubean runtime (vars and secrets).
 *
 * @example
 * ```ts
 * import { test, configure } from "@glubean/sdk";
 * import { grpc } from "@glubean/grpc";
 *
 * const { billing } = configure({
 *   plugins: {
 *     billing: grpc({
 *       proto: "./protos/billing.proto",
 *       address: "{{BILLING_ADDR}}",
 *       package: "acme.billing.v1",
 *       service: "BillingService",
 *       metadata: { authorization: "Bearer {{API_TOKEN}}" },
 *     }),
 *   },
 * });
 *
 * export const createInvoice = test("create-invoice", async (ctx) => {
 *   const res = await billing.call("CreateInvoice", {
 *     customer_id: "cus_123",
 *     amount_cents: 1200,
 *   });
 *   ctx.expect(res.status.code).toBe(0);
 * });
 * ```
 */
export function grpc(options: GrpcPluginOptions): ClientFactory<GrpcClient> {
  return defineClientFactory((runtime: GlubeanRuntime) => {
    const resolvedAddress = runtime.resolveTemplate(options.address);

    const resolvedMetadata: Record<string, string> | undefined =
      options.metadata
        ? Object.fromEntries(
            Object.entries(options.metadata).map(([k, v]) => [
              k,
              runtime.resolveTemplate(v),
            ]),
          )
        : undefined;

    return createGrpcClient(
      {
        proto: options.proto,
        address: resolvedAddress,
        package: options.package,
        service: options.service,
        metadata: resolvedMetadata,
        tls: options.tls,
        deadlineMs: options.deadlineMs,
      },
      {
        trace: (t) => runtime.trace(t),
      },
    );
  });
}

// ── Redaction Scopes ──────────────────────────────────────────────────────

/**
 * Redaction scope declarations for gRPC traces.
 *
 * Pass these as `pluginScopes` when compiling redaction scopes so that
 * gRPC metadata (which may contain auth tokens) is redacted.
 *
 * @example
 * ```ts
 * import { GRPC_REDACTION_SCOPES } from "@glubean/grpc";
 * import { compileScopes, BUILTIN_SCOPES, DEFAULT_GLOBAL_RULES } from "@glubean/redaction";
 *
 * const compiled = compileScopes({
 *   builtinScopes: BUILTIN_SCOPES,
 *   pluginScopes: GRPC_REDACTION_SCOPES,
 *   globalRules: DEFAULT_GLOBAL_RULES,
 * });
 * ```
 */
export const GRPC_REDACTION_SCOPES = [
  {
    id: "grpc.metadata",
    name: "gRPC call metadata",
    event: "trace" as const,
    target: "data.metadata",
    handler: "json" as const,
    rules: {
      sensitiveKeys: [
        "authorization",
        "cookie",
        "token",
        "api_key",
        "apikey",
        "secret",
      ],
    },
  },
  {
    id: "grpc.request",
    name: "gRPC request body",
    event: "trace" as const,
    target: "data.requestBody",
    handler: "json" as const,
  },
  {
    id: "grpc.response",
    name: "gRPC response body",
    event: "trace" as const,
    target: "data.responseBody",
    handler: "json" as const,
  },
];

// =============================================================================
// Plugin manifest (default export)
// =============================================================================

/**
 * Plugin manifest for `@glubean/grpc`. Declares:
 *
 *   - `matchers`  — `toHaveGrpcStatus`, `toHaveGrpcOk`, `toHaveGrpcMetadata`
 *   - `contracts` — `grpc` protocol adapter
 *   - `setup()`   — wraps the auto-attached `contract.grpc` dispatcher with
 *                   `createGrpcRoot` so `contract.grpc.with("name", { client })`
 *                   UX works
 *
 * Install explicitly in your project's `glubean.setup.ts`:
 *
 * ```ts
 * import { installPlugin } from "@glubean/sdk";
 * import grpcPlugin from "@glubean/grpc";
 * await installPlugin(grpcPlugin);
 * ```
 *
 * **Note:** top-level `import "@glubean/grpc"` is **no longer** a side-effect
 * registration. The manifest must be installed explicitly (directly or via
 * `bootstrap(projectRoot)` which loads `glubean.setup.ts`).
 */
const grpcPlugin: PluginManifest = definePlugin({
  name: "@glubean/grpc",
  matchers: grpcMatchers,
  contracts: { grpc: grpcAdapter },
  setup() {
    // Wrap the dispatcher attached by installPlugin with the scoped-defaults
    // factory so `contract.grpc.with("name", { client })("case", spec)` works.
    const dispatcher = (contract as unknown as { grpc: Parameters<typeof createGrpcRoot>[0] }).grpc;
    (contract as unknown as { grpc: GrpcContractRoot }).grpc = createGrpcRoot(dispatcher);
  },
});

export default grpcPlugin;

// Re-export contract surface for type consumers
export {
  grpcAdapter,
  createGrpcFactory,
  createGrpcRoot,
  grpcMatchers,
} from "./contract/index.js";
export type {
  GrpcContractCase,
  GrpcContractDefaults,
  GrpcContractExample,
  GrpcContractExpect,
  GrpcContractFactory,
  GrpcContractMeta,
  GrpcContractRoot,
  GrpcContractSafeMeta,
  GrpcContractSpec,
  GrpcCaseResult,
  GrpcFlowCaseOutput,
  GrpcPayloadSchemas,
  GrpcSafeSchemas,
  InferGrpcRequest,
  InferGrpcResponse,
} from "./contract/index.js";
