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
      // GLU-104: also covers non-standard auth headers (`x-access-token`,
      // `x-session-id`, ...) AND — via `headersHandler`'s cookie-name-keyed
      // nested redact call — common session cookie NAMES ("connect.sid",
      // "JSESSIONID" [contains "session"], "PHPSESSID" [contains "sid"],
      // "csrf-secret", ...). Sensitive-key matching is case-insensitive
      // substring (sensitiveKeysPlugin), so "token"/"session"/"secret"/"sid"
      // alone cover their common compounds without enumerating every variant.
      sensitiveKeys: [
        "authorization",
        "cookie",
        "x-api-key",
        "proxy-authorization",
        "token",
        "session",
        "secret",
        "sid",
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
    id: "http.request.body",
    name: "HTTP request body",
    event: "trace",
    target: "data.requestBody",
    handler: "json",
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
        // login/session-exchange request bodies carry these too.
        "session",
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
      // GLU-104: `set-cookie` alone only flags the OUTER header key — the
      // `headersHandler` cookie branch redacts by inner COOKIE NAME, so
      // without these, an arbitrarily-named session cookie value
      // (`sid=...`, `connect.sid=...`) passed straight through unmasked
      // (confirmed empirically: a Set-Cookie header with a cookie named
      // "sid" was NOT redacted before this change). Same substring-match
      // rationale as the request-headers scope above.
      sensitiveKeys: ["set-cookie", "token", "session", "secret", "sid", "authorization", "api-key", "apikey"],
    },
  },
  {
    id: "http.response.body",
    name: "HTTP response body",
    event: "trace",
    target: "data.responseBody",
    handler: "json",
    rules: {
      // GLU-104: this scope previously declared NO sensitiveKeys at all —
      // only the global value-PATTERN plugins (jwt/bearer/awsKeys/...) ran
      // against response bodies, so a plain-string secret under a
      // recognizably-named key (`{"token": "sk_live_..."}`,
      // `{"access_token": "..."}`) passed through unmasked whenever its
      // value didn't happen to match one of those patterns (confirmed
      // empirically). Mirrors `http.request.body` — a login/refresh
      // response carries the same secret shapes a request does.
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
        "session",
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
