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
/**
 * Shared credential key set for the HTTP trace scopes (headers/body/query/
 * metadata/target/name). One source of truth so a scope can't silently omit a
 * baseline alias (codex GLU-104 R6 P1: `credential`/`credentials`/`ssh_key`/
 * `bearer` were missing from the per-scope lists and leaked). Matching is
 * case-insensitive SUBSTRING (sensitiveKeysPlugin), so compounds are covered.
 *
 * Deliberately EXCLUDES bare `auth`: as a substring it matches — and (in event
 * scopes, which nuke a sensitive key's whole subtree) DESTROYS — common
 * non-secret fields like `author`, `authority`, `authored`, `unauthorized`.
 * Real auth credentials are covered by `authorization` / the `auth_token`
 * compounds / the `bearer` + `jwt` value-patterns instead; a bare field named
 * exactly `auth` holding an opaque value is the accepted residual (documented,
 * same class as the `token`/`tokenCount` tradeoff — a redaction library must
 * not corrupt `author` to catch it).
 */
const CREDENTIAL_KEYS = [
  "authorization",
  "proxy-authorization",
  "bearer",
  "authtoken",
  "auth_token",
  "auth-token",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "session_token",
  "secret",
  "client_secret",
  "client-secret",
  "password",
  "passwd",
  "api_key",
  "api-key",
  "apikey",
  "x-api-key",
  "credential",
  "credentials",
  "private_key",
  "privatekey",
  "private-key",
  "ssh_key",
  "sessionid",
  "session_id",
];

export const BUILTIN_SCOPES: RedactionScopeDeclaration[] = [
  {
    id: "http.request.headers",
    name: "HTTP request headers",
    event: "trace",
    target: "data.requestHeaders",
    handler: "headers",
    rules: {
      // GLU-104: covers standard + non-standard auth/secret headers. Cookie
      // VALUES no longer depend on this list — `headersHandler` masks every
      // `Cookie:` value structurally (a cookie is credential material by
      // default), which fixes opaquely-named session cookies AND let us drop
      // the over-broad `sid`/`session` substrings (R1 P2). `cookie` is kept so
      // a `Cookie` header still routes through the structural cookie branch.
      sensitiveKeys: [...CREDENTIAL_KEYS, "cookie"],
    },
  },
  {
    id: "http.request.query",
    name: "HTTP request query",
    event: "trace",
    target: "data.url",
    handler: "url-query",
    rules: {
      sensitiveKeys: [...CREDENTIAL_KEYS],
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
      sensitiveKeys: [...CREDENTIAL_KEYS],
    },
  },
  {
    id: "http.target",
    name: "Trace target",
    event: "trace",
    // GLU-104 (codex R5 P1): browser network traces set `target`/`name` to
    // `${method} ${shortPath(url)}` where shortPath includes `u.search`
    // (packages/browser/src/network.ts), so a query secret leaks via these
    // fields even though `url` is masked. `url-query` splits on `?`, so the
    // `${method} ${path}` prefix is preserved and only the query is redacted;
    // a non-URL target (`get_weather`, `#submit-btn`) is value-pattern-scanned.
    target: "data.target",
    handler: "url-query",
    rules: {
      sensitiveKeys: [...CREDENTIAL_KEYS],
    },
  },
  {
    id: "http.name",
    name: "Trace name",
    event: "trace",
    target: "data.name",
    handler: "url-query",
    rules: {
      sensitiveKeys: [...CREDENTIAL_KEYS],
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
      sensitiveKeys: [...CREDENTIAL_KEYS],
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
      sensitiveKeys: [...CREDENTIAL_KEYS, "set-cookie", "cookie"],
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
      sensitiveKeys: [...CREDENTIAL_KEYS],
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
      // metadata can carry either shape (gRPC auth headers OR credential-valued
      // fields), so it uses the full shared credential set + `cookie`. codex
      // R4 P2 (`password`/`private_key`/`sessionid` missing) and R6 P1
      // (`credential`/`ssh_key`/`bearer` missing) are both covered now.
      sensitiveKeys: [...CREDENTIAL_KEYS, "cookie"],
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
    // GLU-129 (codex R1 P1): `ctx.log(message, data)` lets a test echo ANY
    // structured value — including a raw credential under an opaque-looking
    // key (`{ token: "opaque-session-id" }`) that matches no global VALUE
    // pattern (jwt/bearer/email/etc). Without a `sensitiveKeys` list this
    // scope only ever ran global pattern plugins (confirmed empirically: a
    // non-JWT-shaped token/password/cookie value passed through untouched),
    // even though the sibling HTTP body scopes have carried a credential-key
    // list since GLU-104. Mirrors `http.metadata` (includes `cookie` — a log
    // can carry an object shaped like headers, not just an HTTP body).
    //
    // GLU-129 (codex R2 P2): `handler: "json"` only key-redacts an already
    // OBJECT `data` — `ctx.log("response", await res.text())` logs the body
    // as a STRING, and the `json` handler treats any string as an opaque
    // scalar (value-pattern scan only, same gap `assertion.*` had). Switched
    // to `handler: "body"` (same handler `http.request/response.body` has
    // used since GLU-104 R2) — it JSON/form-parses a string payload first so
    // KEY rules apply, then falls back to plain pattern scanning for
    // genuinely free-text strings.
    target: "data",
    handler: "body",
    rules: {
      sensitiveKeys: [...CREDENTIAL_KEYS, "cookie"],
    },
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
    // GLU-129 (codex R2 P1): `ctx.expect(body).toEqual(...)` copies a
    // FULL parsed response value (object, or the raw text if the caller
    // asserted on `res.text()`) into `actual`/`expected` — the same shape
    // `http.response.body` already handles. Without `sensitiveKeys` here,
    // an opaque credential under a recognized key (`{ token: "..." }`) that
    // matches no global value pattern passed through in plaintext even
    // after the R1 fix (which only wired `log.data`, not `assertion.*`).
    // `handler: "body"` (not "json") so a string actual/expected value
    // (`res.text()`) is also JSON/form-parsed for key-based masking before
    // falling back to plain pattern scanning — same reasoning as the
    // `log.data` R2 P2 fix above and `http.request/response.body` (GLU-104).
    id: "assertion.actual",
    name: "Assertion actual",
    event: "assertion",
    target: "actual",
    handler: "body",
    rules: {
      sensitiveKeys: [...CREDENTIAL_KEYS, "cookie"],
    },
  },
  {
    id: "assertion.expected",
    name: "Assertion expected",
    event: "assertion",
    target: "expected",
    handler: "body",
    rules: {
      sensitiveKeys: [...CREDENTIAL_KEYS, "cookie"],
    },
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
  {
    // GLU-105: `browser:download` evidence (packages/browser/src/page.ts) is
    // emitted via ctx.event as an ExecutionEvent of type "event" wrapping
    // { type, data:{ url, … } }. A download can start from a signed/
    // credentialed URL (an S3 pre-signed link: `?X-Amz-Signature=…` /
    // `?token=…`), which would otherwise persist to the local result JSON +
    // upload in plaintext. url-query masks only the sensitive query params.
    id: "browser.download.url",
    name: "Browser download URL query",
    event: "event",
    target: "data.data.url",
    handler: "url-query",
    rules: {
      sensitiveKeys: [
        ...CREDENTIAL_KEYS,
        "signature",
        "sig",
        "x-amz-signature",
        "x-amz-credential",
        "x-amz-security-token",
      ],
    },
  },
  {
    // GLU-105: `page.waitForDownload()` (packages/browser/src/page.ts) emits an
    // action whose `detail.url` copies the same download URL as the
    // browser:download event above — redact its query the same way so the
    // action sink doesn't leak what the event sink masks.
    id: "browser.waitForDownload.url",
    name: "Browser waitForDownload action URL query",
    event: "action",
    target: "data.detail.url",
    handler: "url-query",
    rules: {
      sensitiveKeys: [
        ...CREDENTIAL_KEYS,
        "signature",
        "sig",
        "x-amz-signature",
        "x-amz-credential",
        "x-amz-security-token",
      ],
    },
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
