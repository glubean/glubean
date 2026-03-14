/**
 * gRPC plugin for Glubean tests.
 *
 * Provides a thin wrapper over `@grpc/grpc-js` that simplifies
 * unary gRPC calls with auto-tracing via Glubean events.
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
import { definePlugin } from "@glubean/sdk/plugin";
import type { GlubeanRuntime, PluginFactory } from "@glubean/sdk";

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
  event?: (ev: { type: string; data: Record<string, unknown> }) => void;
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

              hooks?.event?.({
                type: "trace",
                data: {
                  protocol: "grpc",
                  target,
                  status: status.code,
                  durationMs,
                  ok: false,
                  service: options.service,
                  method,
                  peer: options.address,
                  request,
                  metadata: mergedMetadata,
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

            hooks?.event?.({
              type: "trace",
              data: {
                protocol: "grpc",
                target,
                status: grpcJs.status.OK,
                durationMs,
                ok: true,
                service: options.service,
                method,
                peer: options.address,
                request,
                response,
                metadata: mergedMetadata,
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
export function grpc(options: GrpcPluginOptions): PluginFactory<GrpcClient> {
  return definePlugin((runtime: GlubeanRuntime) => {
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
        event: (ev) => runtime.event(ev),
      },
    );
  });
}
