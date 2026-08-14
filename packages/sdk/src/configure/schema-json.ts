/**
 * @module configure/schema-json
 *
 * Schema-aware `.json(schema)` for the `configure()` HTTP client (issue #32).
 *
 * The recurring authoring pattern is:
 *
 * ```ts
 * const raw = await http.get(url).json<unknown>();
 * const user = UserSchema.parse(raw);
 * ```
 *
 * `.json(schema)` collapses that into one call: decode the body, run it through
 * the schema, return the VALIDATED value typed from the schema. The no-arg
 * `.json<T>()` form is untouched — it still returns the decoded body with `T` as
 * an author assertion.
 *
 * The runner/engine build the underlying response promise (ky's
 * `ResponsePromise`, possibly already patched for `schema:` option validation);
 * we only decorate the object the configured client hands back, so every
 * existing behaviour (`text()`, `blob()`, `track()`, `await`) is preserved.
 */

import type {
  ConfiguredHttpClient,
  HttpClient,
  HttpRequestOptions,
  SchemaLike,
} from "../types.js";

/** Marks a response promise whose `json` already accepts a schema. */
const SCHEMA_JSON_ATTACHED = Symbol.for("glubean.schemaJsonAttached");

/** Max issues quoted when a `safeParse`-only schema rejects the body. */
const MAX_QUOTED_ISSUES = 3;

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head"] as const;

/**
 * Validate a decoded body with a `SchemaLike`.
 *
 * `parse` is preferred so the caller sees EXACTLY what their schema library
 * throws (e.g. a `ZodError`, with its issues intact). A `safeParse`-only schema
 * has no error to re-throw, so we raise an `Error` carrying the issue summary.
 */
export function parseWithSchema<T>(data: unknown, schema: SchemaLike<T>): T {
  if (typeof schema.parse === "function") {
    return schema.parse(data);
  }
  if (typeof schema.safeParse === "function") {
    const result = schema.safeParse(data);
    if (result.success) return result.data;
    const issues = result.error?.issues ?? [];
    const quoted = issues.slice(0, MAX_QUOTED_ISSUES).map((issue) => {
      const path = issue.path && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    });
    const rest = issues.length - quoted.length;
    const summary = quoted.join("; ") + (rest > 0 ? ` (+${rest} more)` : "");
    throw new Error(
      `Schema validation failed${summary ? ` — ${summary}` : ""}`,
    );
  }
  throw new TypeError(
    "json(schema): schema must implement safeParse() or parse()",
  );
}

/**
 * Decorate a response promise so `.json(schema)` validates the decoded body.
 *
 * Idempotent (a promise is decorated at most once) and defensive: an object
 * without a `json` method — e.g. a bare `Promise<Response>` from a test double —
 * passes through untouched. `.track()` is re-wrapped so the schema form survives
 * `http.get(url).track("GET /users/:id").json(Schema)` even if a runtime ever
 * returns a fresh promise from `track`.
 */
export function attachSchemaJson<P>(promise: P): P {
  const target = promise as unknown as {
    json?: (...args: unknown[]) => Promise<unknown>;
    track?: (pattern: string) => unknown;
    [SCHEMA_JSON_ATTACHED]?: boolean;
  } | null;

  if (target == null || typeof target !== "object") return promise;
  if (target[SCHEMA_JSON_ATTACHED]) return promise;
  if (typeof target.json !== "function") return promise;

  Object.defineProperty(target, SCHEMA_JSON_ATTACHED, {
    value: true,
    enumerable: false,
    configurable: true,
  });

  const originalJson = target.json.bind(target);
  target.json = async (schema?: unknown): Promise<unknown> => {
    const body = await originalJson();
    if (schema === undefined) return body;
    return parseWithSchema(body, schema as SchemaLike<unknown>);
  };

  if (typeof target.track === "function") {
    const originalTrack = target.track.bind(target);
    target.track = (pattern: string) => attachSchemaJson(originalTrack(pattern));
  }

  return promise;
}

/**
 * Wrap an `HttpClient` so every response promise it produces (directly or via
 * `.extend()`) accepts `.json(schema)`.
 *
 * `resolve` is a thunk so the `configure()` client can stay lazy — the
 * underlying client is only materialised when a request is actually made.
 */
export function makeSchemaAwareClient(
  resolve: () => HttpClient,
): ConfiguredHttpClient {
  const client: Record<string, unknown> = function (
    url: string | URL | Request,
    options?: HttpRequestOptions,
  ) {
    return attachSchemaJson(resolve()(url, options));
  } as unknown as Record<string, unknown>;

  for (const method of HTTP_METHODS) {
    client[method] = (url: string | URL | Request, options?: HttpRequestOptions) =>
      attachSchemaJson(resolve()[method](url, options));
  }

  client["extend"] = (options: HttpRequestOptions) => {
    // Resolve + extend eagerly (unchanged from the pre-wrapper behaviour: one
    // `.extend()` call on the underlying client per `.extend()` here), then
    // hand the concrete instance back through the same wrapper.
    const extended = resolve().extend(options);
    return makeSchemaAwareClient(() => extended);
  };

  return client as unknown as ConfiguredHttpClient;
}
