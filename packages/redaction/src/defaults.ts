/**
 * @module defaults
 *
 * Built-in scope declarations, pattern source strings, and default config.
 *
 * v2: HTTP scopes are declared as data, not as a fixed interface.
 * They use the same shape as external plugin declarations.
 */

import type {
  GlobalRules,
  RedactionConfig,
  RedactionScopeDeclaration,
} from "./types.js";

// ── Built-in HTTP scope declarations ─────────────────────────────────────────

/**
 * Built-in scope declarations for HTTP, log, error, assertion, and step events.
 *
 * These are the "http-plugin" built-in contributor — they use the same
 * declaration model as any external plugin.
 */
export const BUILTIN_SCOPES: RedactionScopeDeclaration[] = [
  {
    id: "http.request.headers",
    name: "HTTP request headers",
    event: "trace",
    target: "data.requestHeaders",
    handler: "headers",
    rules: {
      // GLU-104: covers standard + non-standard auth/secret headers
      // (`authorization`, `x-api-key`, `x-access-token`, `x-auth-token`, ...).
      // Cookie VALUES no longer depend on this list — `headersHandler` masks
      // every `Cookie:` value structurally (a cookie is credential material by
      // default), which fixes opaquely-named session cookies AND lets us drop
      // the over-broad `sid`/`session` substrings (codex GLU-104 R1 P2: `sid`
      // matched `president`/`residence`). Matching is case-insensitive
      // substring, so `token`/`secret`/`api-key` cover their compounds.
      sensitiveKeys: [
        "authorization",
        "cookie",
        "x-api-key",
        "proxy-authorization",
        "token",
        "secret",
        "api-key",
        "apikey",
      ],
    },
  },
  {
    id: "http.request.query",
    name: "HTTP request query",
    event: "trace",
    target: "data.url",
    handler: "url-query",
    rules: {
      sensitiveKeys: [
        "token",
        "access_token",
        "refresh_token",
        "api_key",
        "apikey",
        "api-key",
        "secret",
        "password",
      ],
    },
  },
  {
    id: "http.request.requestedUrl",
    name: "HTTP requested (relative) URL",
    event: "trace",
    // GLU-104 (codex R3 P2): a trace can carry `requestedUrl` — the author's
    // ORIGINAL relative URL (`/login?token=…`), captured before resolution.
    // `data.url` only covers the resolved absolute URL, so without this a
    // secret in a relative URL's query leaked. `url-query` now parses relative
    // URLs (synthetic base).
    target: "data.requestedUrl",
    handler: "url-query",
    rules: {
      sensitiveKeys: [
        "token",
        "access_token",
        "refresh_token",
        "api_key",
        "apikey",
        "api-key",
        "secret",
        "password",
      ],
    },
  },
  {
    id: "http.request.body",
    name: "HTTP request body",
    event: "trace",
    // GLU-104: `body` (not `json`) so a NON-JSON request body captured as a
    // raw string — a form-urlencoded login `password=hunter2&client_secret=x`
    // — is redacted by param name, not just value-pattern-scanned.
    target: "data.requestBody",
    handler: "body",
    rules: {
      sensitiveKeys: [
        "password",
        "passwd",
        "secret",
        "token",
        "client_secret",
        "client-secret",
        "private_key",
        "privatekey",
        "private-key",
        // GLU-104: symmetric with the query/response-body lists below —
        // login/session-exchange request bodies carry these too. `sessionid`/
        // `session_id` are specific enough to avoid the `sid` false-positive.
        "sessionid",
        "session_id",
        "api_key",
        "api-key",
        "apikey",
      ],
    },
  },
  {
    id: "http.response.headers",
    name: "HTTP response headers",
    event: "trace",
    target: "data.responseHeaders",
    handler: "headers",
    rules: {
      // GLU-104: `Set-Cookie` VALUES are masked structurally by
      // `headersHandler` (a minted session cookie is credential material, its
      // name arbitrary) — no longer name-list-dependent, so the over-broad
      // `sid`/`session` substrings are gone (codex R1 P2). These keys still
      // cover plain sensitive response headers (`X-Auth-Token`, ...).
      sensitiveKeys: ["set-cookie", "token", "secret", "authorization", "api-key", "apikey"],
    },
  },
  {
    id: "http.response.body",
    name: "HTTP response body",
    event: "trace",
    // GLU-104: `body` handler (see request body) + a real sensitiveKeys list.
    // Previously this scope declared NO sensitiveKeys and used `json`, so only
    // global value-PATTERN plugins ran — a plain-string secret under a
    // recognizably-named key (`{"token":"sk_live_..."}`, `{"access_token":...}`)
    // passed through whenever its value matched no pattern (confirmed
    // empirically). A login/refresh response carries the same secret shapes a
    // request does — this list mirrors `http.request.body` (which has carried
    // `token` since before GLU-104), so request/response redact symmetrically.
    //
    // Note on `token`: sensitive-key matching is substring (sensitiveKeysPlugin),
    // so `token` also masks compound fields like `tokenCount`/`tokensUsed`
    // (codex R4). This is INTENTIONAL and conservative for a redaction library:
    // over-masking a usage counter in a redacted debug/upload view is strictly
    // preferable to leaking an opaque `{"token":"<credential>"}` whose value
    // matches no pattern. A precise (suffix/word-boundary) matcher would be a
    // general redaction-engine change across all consumers, out of scope here.
    target: "data.responseBody",
    handler: "body",
    rules: {
      sensitiveKeys: [
        "password",
        "passwd",
        "secret",
        "token",
        "client_secret",
        "client-secret",
        "private_key",
        "privatekey",
        "private-key",
        "sessionid",
        "session_id",
        "api_key",
        "api-key",
        "apikey",
        "authorization",
      ],
    },
  },
  {
    id: "http.metadata",
    name: "Trace metadata",
    event: "trace",
    // GLU-104 (codex R1 P1): the generic `Trace.metadata` field carries
    // protocol-specific auth material — notably gRPC call metadata under
    // `requestMetadata`/`responseMetadata` (packages/grpc emits
    // `data.metadata.requestMetadata.authorization`). The `@glubean/grpc`
    // plugin declares its own `grpc.metadata` scope, but that's only compiled
    // when a caller passes it as `pluginScopes` — the MCP local-trace path
    // compiles BUILTIN_SCOPES only, so without a baseline metadata scope gRPC
    // auth tokens flowed into `glubean_run_local_file` output. The `json`
    // handler recurses into the nested metadata objects; non-secret siblings
    // (`service`/`method`/`peer`) match no key and are preserved.
    target: "data.metadata",
    handler: "json",
    rules: {
      // Superset of the auth-header keys AND the request/response body keys —
      // metadata can carry either shape (gRPC auth headers OR credential-valued
      // fields). codex R4 P2: `password`/`private_key`/`sessionid` etc. were
      // missing, so a `requestMetadata.password` leaked.
      sensitiveKeys: [
        "authorization",
        "cookie",
        "proxy-authorization",
        "token",
        "secret",
        "password",
        "passwd",
        "client_secret",
        "client-secret",
        "private_key",
        "privatekey",
        "private-key",
        "sessionid",
        "session_id",
        "api_key",
        "api-key",
        "apikey",
        "x-api-key",
      ],
    },
  },
  {
    id: "log.message",
    name: "Log message",
    event: "log",
    target: "message",
    handler: "raw-string",
  },
  {
    id: "log.data",
    name: "Log data",
    event: "log",
    target: "data",
    handler: "json",
  },
  {
    id: "error.message",
    name: "Error message",
    event: "error",
    target: "message",
    handler: "raw-string",
  },
  {
    id: "error.stack",
    name: "Error stack",
    event: "error",
    target: "stack",
    handler: "raw-string",
  },
  {
    id: "status.error",
    name: "Status error",
    event: "status",
    target: "error",
    handler: "raw-string",
  },
  {
    id: "status.stack",
    name: "Status stack",
    event: "status",
    target: "stack",
    handler: "raw-string",
  },
  {
    id: "assertion.message",
    name: "Assertion message",
    event: "assertion",
    target: "message",
    handler: "raw-string",
  },
  {
    id: "assertion.actual",
    name: "Assertion actual",
    event: "assertion",
    target: "actual",
    handler: "json",
  },
  {
    id: "assertion.expected",
    name: "Assertion expected",
    event: "assertion",
    target: "expected",
    handler: "json",
  },
  {
    id: "warning.message",
    name: "Warning message",
    event: "warning",
    target: "message",
    handler: "raw-string",
  },
  {
    id: "schema_validation.message",
    name: "Schema validation message",
    event: "schema_validation",
    target: "message",
    handler: "raw-string",
  },
  {
    id: "step.returnState",
    name: "Step return state",
    event: "step_end",
    target: "returnState",
    handler: "json",
  },
  {
    id: "branch.error",
    name: "Branch decision error",
    event: "branch",
    target: "error",
    handler: "raw-string",
  },
  {
    id: "branch.takenValue",
    name: "Branch matched value",
    event: "branch",
    target: "takenValue",
    // raw-string scans string values for secret patterns; non-string scalars
    // (number/boolean/null) pass through untouched.
    handler: "raw-string",
  },
  {
    // The branch label (author-provided `message`, also copied into `name`)
    // could embed a secret; scan it like other free text. Normal labels are
    // left intact (raw-string only masks matching secret patterns).
    id: "branch.message",
    name: "Branch label",
    event: "branch",
    target: "message",
    handler: "raw-string",
  },
  {
    id: "branch.name",
    name: "Branch name label",
    event: "branch",
    target: "name",
    handler: "raw-string",
  },
  {
    id: "poll.error",
    name: "Poll error",
    event: "poll",
    target: "error",
    handler: "raw-string",
  },
  {
    // The poll step name could embed a secret; scan it like other free text.
    id: "poll.name",
    name: "Poll name label",
    event: "poll",
    target: "name",
    handler: "raw-string",
  },
];

// ── Built-in pattern source strings ──────────────────────────────────────────

/**
 * Regex source strings for built-in value-level patterns.
 * Plugins create new RegExp instances from these on each call.
 */
export const PATTERN_SOURCES: Record<
  string,
  { source: string; flags: string }
> = {
  jwt: {
    source: "\\beyJ[a-zA-Z0-9_-]*\\.eyJ[a-zA-Z0-9_-]*\\.[a-zA-Z0-9_-]*",
    flags: "g",
  },
  bearer: {
    source: "\\bBearer\\s+[a-zA-Z0-9._-]+",
    flags: "gi",
  },
  awsKeys: {
    source: "\\bAKIA[0-9A-Z]{16}\\b",
    flags: "g",
  },
  githubTokens: {
    source: "\\b(ghp_|gho_|ghu_|ghs_|ghr_)[a-zA-Z0-9]{36,}\\b",
    flags: "g",
  },
  email: {
    source: "\\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}\\b",
    flags: "g",
  },
  ipAddress: {
    source: "\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b",
    flags: "g",
  },
  creditCard: {
    source: "\\b\\d{4}[- ]?\\d{4}[- ]?\\d{4}[- ]?\\d{4}\\b",
    flags: "g",
  },
  hexKeys: {
    source: "\\b[a-f0-9]{32,}\\b",
    flags: "gi",
  },
};

// ── Default global rules ─────────────────────────────────────────────────────

/**
 * Default global additive rules.
 *
 * These are intentionally minimal — most sensitive keys now live
 * in scope-specific declarations, not in globals.
 */
export const DEFAULT_GLOBAL_RULES: GlobalRules = {
  sensitiveKeys: [],
  patterns: [
    "jwt",
    "bearer",
    "awsKeys",
    "githubTokens",
    "email",
    "ipAddress",
    "creditCard",
    "hexKeys",
  ],
  customPatterns: [],
};

// ── Default config ───────────────────────────────────────────────────────────

/**
 * Default redaction config v2.
 *
 * All built-in scopes enabled, all patterns enabled globally,
 * scope-specific sensitive keys declared per scope.
 */
export const DEFAULT_CONFIG: RedactionConfig = {
  scopes: BUILTIN_SCOPES.map((s) => ({
    ...s,
    enabled: true,
  })),
  globalRules: DEFAULT_GLOBAL_RULES,
  replacementFormat: "partial",
};
