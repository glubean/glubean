/**
 * @module handlers
 *
 * Built-in redaction handlers. Each handler interprets a specific payload shape.
 *
 * - `json` — recursive object/array walker (delegates to engine.redact)
 * - `raw-string` — value-pattern matching only
 * - `url-query` — parse URL, redact query param names/values, serialize back
 * - `headers` — header map with case-insensitive keys, cookie/set-cookie parsing
 * - `body` — HTTP body: object → json walk; string → form/text/xml redaction
 */

import type { RedactionHandler, RedactionEngineInterface, RedactionResult, HandlerContext } from "./types.js";

// ── json handler ─────────────────────────────────────────────────────────────

/**
 * Default handler: delegates directly to engine.redact() which recursively
 * walks objects/arrays and applies key-level + value-level plugins.
 */
export const jsonHandler: RedactionHandler = {
  name: "json",
  process(value, ctx, engine) {
    return engine.redact(value, { id: ctx.scopeId, name: ctx.scopeName });
  },
};

// ── raw-string handler ───────────────────────────────────────────────────────

/**
 * Handles plain string values. Wraps the string in an object so the engine
 * can apply value-level pattern plugins, then extracts the result.
 */
export const rawStringHandler: RedactionHandler = {
  name: "raw-string",
  process(value, ctx, engine) {
    if (typeof value !== "string") {
      return { value, redacted: false, details: [] };
    }
    // Wrap in object so the engine walks it as a string value
    const result = engine.redact({ __raw: value }, { id: ctx.scopeId, name: ctx.scopeName });
    const redacted = result.value as Record<string, unknown>;
    return {
      value: redacted.__raw,
      redacted: result.redacted,
      details: result.details,
    };
  },
};

// ── url-query handler ────────────────────────────────────────────────────────

/**
 * Redact the values of sensitive-named params in a `k=v&k2=v2` param string
 * (a URL query OR an OAuth-implicit fragment). Empty values are left as-is
 * (nothing to hide — avoids `?token=` → `?token=****`, codex R5). Returns the
 * re-encoded param string and whether anything changed.
 */
function redactParamString(
  paramStr: string,
  ctx: HandlerContext,
  engine: RedactionEngineInterface,
): { value: string; redacted: boolean; details: RedactionResult["details"] } {
  const entries = [...new URLSearchParams(paramStr).entries()];
  if (entries.length === 0) {
    return { value: paramStr, redacted: false, details: [] };
  }
  let didRedact = false;
  const details: RedactionResult["details"] = [];
  const out = new URLSearchParams();
  for (const [key, raw] of entries) {
    if (raw === "") {
      out.append(key, ""); // empty value — no secret to mask
      continue;
    }
    const r = engine.redact({ [key]: raw }, { id: ctx.scopeId, name: ctx.scopeName });
    if (r.redacted) {
      out.append(key, String((r.value as Record<string, unknown>)[key] ?? raw));
      didRedact = true;
      details.push(...r.details);
    } else {
      out.append(key, raw);
    }
  }
  return { value: out.toString(), redacted: didRedact, details };
}

/**
 * Redacts sensitive params in a URL string — in BOTH the `?query` AND a
 * `#fragment` when the fragment is `k=v`-shaped (OAuth implicit-grant tokens
 * live in the fragment: `#access_token=…`, codex R5 P2).
 *
 * GLU-104 (codex R3/R4/R5): works for ANY URL shape — absolute, relative
 * (`/login?token=…`), query-only (`?token=…`), bare-relative
 * (`todos/1?token=…`), or protocol-relative (`//host/p?token=…`) — WITHOUT a
 * URL parser (which throws on relative shapes and mangled query-only /
 * protocol-relative forms). We operate purely on the ORIGINAL string: split off
 * the `?query` and `#fragment` segments, redact each by key, and splice back so
 * the prefix and non-param structure are preserved. Values are re-encoded only
 * when something was actually redacted; a URL with no sensitive param is
 * returned untouched (path/token-shaped secrets are still value-pattern-scanned
 * via the raw-string fallback).
 */
export const urlQueryHandler: RedactionHandler = {
  name: "url-query",
  process(value, ctx, engine) {
    if (typeof value !== "string") {
      return { value, redacted: false, details: [] };
    }

    const qIndex = value.indexOf("?");
    const hashIndex = value.indexOf("#");
    const hasQuery = qIndex !== -1 && (hashIndex === -1 || qIndex < hashIndex);

    let prefix = value;
    let queryStr: string | null = null;
    let fragStr: string | null = null;
    if (hasQuery) {
      prefix = value.slice(0, qIndex);
      const afterQ = value.slice(qIndex + 1);
      const h = afterQ.indexOf("#");
      queryStr = h === -1 ? afterQ : afterQ.slice(0, h);
      if (h !== -1) fragStr = afterQ.slice(h + 1);
    } else if (hashIndex !== -1) {
      prefix = value.slice(0, hashIndex);
      fragStr = value.slice(hashIndex + 1);
    }

    // Only a `k=v`-shaped fragment carries params worth key-redaction
    // (`#access_token=…`); a plain anchor (`#section`) is left alone.
    const fragIsParams = fragStr !== null && fragStr.includes("=");

    // Nothing structured to redact by key → value-pattern-scan the whole
    // string (catches a token embedded in the path or a non-param fragment).
    if (!hasQuery && !fragIsParams) {
      return engine.redact(value, { id: ctx.scopeId, name: ctx.scopeName });
    }

    let didRedact = false;
    const details: RedactionResult["details"] = [];

    let outQuery = queryStr;
    if (hasQuery && queryStr !== null) {
      const rq = redactParamString(queryStr, ctx, engine);
      outQuery = rq.value;
      if (rq.redacted) {
        didRedact = true;
        details.push(...rq.details);
      }
    }

    let outFrag = fragStr;
    if (fragIsParams && fragStr !== null) {
      const rf = redactParamString(fragStr, ctx, engine);
      outFrag = rf.value;
      if (rf.redacted) {
        didRedact = true;
        details.push(...rf.details);
      }
    }

    if (!didRedact) {
      // Nothing sensitive — return the ORIGINAL string untouched.
      return { value, redacted: false, details };
    }

    let result = prefix;
    if (hasQuery) result += `?${outQuery ?? ""}`;
    if (fragStr !== null) result += `#${outFrag ?? ""}`;
    return { value: result, redacted: true, details };
  },
};

// ── body handler ─────────────────────────────────────────────────────────────

/**
 * Does this string look like an `application/x-www-form-urlencoded` body —
 * `k=v` or `k=v&k2=v2` with URL-safe-ish keys and no obvious JSON/XML lead-in?
 * Strict on purpose: a false positive would round-trip an arbitrary text body
 * through URLSearchParams and could normalize its encoding. Free-text that
 * merely contains an `=` (`note = 3`, prose, a stack trace) must NOT match.
 */
const FORM_URLENCODED_RE = /^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/;

function looksLikeFormUrlEncoded(str: string): boolean {
  const s = str.trim();
  if (!s || s[0] === "{" || s[0] === "[" || s[0] === "<") return false;
  return FORM_URLENCODED_RE.test(s);
}

/**
 * Redact a NON-object (string) HTTP body captured as raw text by the runner —
 * a form-urlencoded request body, or a `text/*` / `xml` / mislabelled body (the
 * harness only parses `application/json` content-types into objects; everything
 * else stays a string). GLU-104: the plain `json` handler value-pattern-scans a
 * string but never applies KEY-based rules to it, so a form body
 * `password=hunter2` or a JSON body served as `text/plain`
 * (`{"token":"plain"}`) leaked. Here we:
 *   0. if the string parses as a JSON object/array (a body mislabelled as text,
 *      or any `content-type` the harness didn't treat as json — codex R2 P2),
 *      redact it STRUCTURALLY like a real object body, then re-serialize;
 *   1. otherwise run the value-pattern scan (jwt/bearer/aws/etc) over the whole
 *      string;
 *   2. and if it's clearly form-urlencoded, additionally mask the values of
 *      sensitive-NAMED params via the same key rules objects get.
 *
 * Residual (documented): a secret under a sensitive element name inside an
 * XML/text body that is neither JSON nor form-urlencoded
 * (`<password>plain</password>`) is only caught if its value matches a
 * value-pattern — generic markup parsing is out of scope.
 */
function redactStringBody(
  raw: string,
  ctx: HandlerContext,
  engine: RedactionEngineInterface,
): RedactionResult {
  // 0. JSON-as-string: a body captured as text that is actually JSON
  //    (mislabelled content-type). Parse and redact structurally so KEY rules
  //    apply, not just value patterns. Only attempt for `{`/`[`-led strings so
  //    a bare number/quoted-string isn't needlessly reserialized.
  const trimmed = raw.trim();
  if (trimmed && (trimmed[0] === "{" || trimmed[0] === "[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") {
        const r = engine.redact(parsed, { id: ctx.scopeId, name: ctx.scopeName });
        // Only re-serialize when something was actually masked — otherwise
        // return the ORIGINAL raw string so a clean body isn't silently
        // reformatted (whitespace normalized) (codex R3 P3).
        if (!r.redacted) {
          return { value: raw, redacted: false, details: [] };
        }
        return {
          value: JSON.stringify(r.value),
          redacted: true,
          details: r.details,
        };
      }
    } catch {
      // Not valid JSON — fall through to string scanning below.
    }
  }

  // 1. Value-pattern scan over the raw string (walkString path).
  const scanned = engine.redact(raw, { id: ctx.scopeId, name: ctx.scopeName });
  let working = typeof scanned.value === "string" ? scanned.value : raw;
  let didRedact = scanned.redacted;
  const details: RedactionResult["details"] = [...scanned.details];

  // 2. Form-urlencoded: mask sensitive-named param values by key.
  if (looksLikeFormUrlEncoded(working)) {
    const params = new URLSearchParams(working);
    const out = new URLSearchParams();
    let changed = false;
    for (const [key, val] of params.entries()) {
      const r = engine.redact(
        { [key]: val },
        { id: ctx.scopeId, name: ctx.scopeName },
      );
      if (r.redacted) {
        const rv = (r.value as Record<string, unknown>)[key];
        out.append(key, String(rv ?? val));
        changed = true;
        details.push(...r.details);
      } else {
        out.append(key, val);
      }
    }
    if (changed) {
      working = out.toString();
      didRedact = true;
    }
  }

  return { value: working, redacted: didRedact, details };
}

/**
 * HTTP body handler. Objects/arrays walk like the `json` handler (key + value
 * plugins); raw strings go through `redactStringBody` (form/text/xml). Use for
 * `data.requestBody` / `data.responseBody`, which the runner captures as EITHER
 * a parsed object (JSON) or a raw string (everything else).
 */
export const bodyHandler: RedactionHandler = {
  name: "body",
  process(value, ctx, engine) {
    if (value !== null && typeof value === "object") {
      return engine.redact(value, { id: ctx.scopeId, name: ctx.scopeName });
    }
    if (typeof value === "string") {
      return redactStringBody(value, ctx, engine);
    }
    return { value, redacted: false, details: [] };
  },
};

// ── headers handler ──────────────────────────────────────────────────────────

/**
 * Parse a Cookie header string into key/value pairs.
 */
function parseCookieHeader(str: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of str.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return result;
}

/**
 * Serialize a cookie key/value map back to a Cookie header string.
 */
function serializeCookieHeader(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("; ");
}

/**
 * Handles HTTP header maps with special treatment for cookie headers.
 *
 * - Normal headers: redact as key/value pairs
 * - `cookie`: parse into name/value pairs, redact, serialize back
 * - `set-cookie`: parse value portion, preserve attributes (Path, Domain, etc.)
 */
export const headersHandler: RedactionHandler = {
  name: "headers",
  process(value, ctx, engine) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { value, redacted: false, details: [] };
    }

    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    let didRedact = false;
    const details: RedactionResult["details"] = [];

    for (const [headerName, headerValue] of Object.entries(input)) {
      const lower = headerName.toLowerCase();

      // Cookie header: parse into key/value pairs, mask EVERY value.
      // GLU-104: a Cookie header value is credential material by default
      // (session ids, CSRF tokens, auth cookies) and cookie NAMES are
      // arbitrary/opaque — masking selectively by name leaked opaquely-named
      // session cookies (`Cookie: auth=<opaque>` when "auth" wasn't a listed
      // key). Cookie NAMES (structure) are preserved; only values are masked.
      if (lower === "cookie" && typeof headerValue === "string") {
        const parsed = parseCookieHeader(headerValue);
        const cookieNames = Object.keys(parsed);
        if (cookieNames.length > 0) {
          const masked: Record<string, string> = {};
          for (const [ck, cv] of Object.entries(parsed)) {
            masked[ck] = maskCookieValue(cv, engine);
          }
          output[headerName] = serializeCookieHeader(masked);
          didRedact = true;
          details.push({
            path: headerName,
            plugin: "cookie",
            original: headerValue,
          });
        } else if (headerValue.trim() !== "") {
          // Non-empty but UNPARSEABLE (no `name=value` pair, e.g. a bare
          // opaque token `Cookie: <session-token>`). Structural masking found
          // nothing to key on, so mask the whole value — a Cookie header is a
          // sensitive header by definition and this fails closed (codex R2 P2).
          output[headerName] = maskCookieValue(headerValue, engine);
          didRedact = true;
          details.push({
            path: headerName,
            plugin: "cookie",
            original: headerValue,
          });
        } else {
          output[headerName] = headerValue;
        }
        continue;
      }

      // Set-Cookie header: redact the value portion, preserve attributes
      // Supports both single string and string[] (common in HTTP client shapes)
      if (lower === "set-cookie") {
        if (typeof headerValue === "string") {
          const redacted = redactSetCookie(headerValue, ctx, engine);
          output[headerName] = redacted.value;
          if (redacted.redacted) {
            didRedact = true;
            details.push(...redacted.details);
          }
          continue;
        }
        if (Array.isArray(headerValue)) {
          const redactedCookies: unknown[] = [];
          for (const cookie of headerValue) {
            if (typeof cookie !== "string") {
              // Defensive (codex R5): a malformed/manual trace could put a
              // non-string (e.g. an object carrying a secret) in a set-cookie
              // array. Don't pass it through raw — deep-redact it.
              const r = engine.redact(cookie, {
                id: ctx.scopeId,
                name: ctx.scopeName,
              });
              redactedCookies.push(r.value);
              if (r.redacted) {
                didRedact = true;
                details.push(...r.details);
              }
              continue;
            }
            const redacted = redactSetCookie(cookie, ctx, engine);
            redactedCookies.push(redacted.value as string);
            if (redacted.redacted) {
              didRedact = true;
              details.push(...redacted.details);
            }
          }
          output[headerName] = redactedCookies;
          continue;
        }
      }

      // Normal header: redact as { headerName: value }
      const result = engine.redact(
        { [headerName]: headerValue },
        { id: ctx.scopeId, name: ctx.scopeName },
      );
      output[headerName] = (result.value as Record<string, unknown>)[
        headerName
      ];
      if (result.redacted) {
        didRedact = true;
        details.push(...result.details);
      }
    }

    return { value: didRedact ? output : value, redacted: didRedact, details };
  },
};

/**
 * Mask a cookie VALUE as sensitive, honoring the engine's replacement format.
 * Falls back to "[REDACTED]" for third-party engines that don't implement the
 * optional `maskValue`.
 */
function maskCookieValue(value: string, engine: RedactionEngineInterface): string {
  return engine.maskValue ? engine.maskValue(value) : "[REDACTED]";
}

/**
 * Standard Set-Cookie attribute names (lower-cased). Anything in attribute
 * position that is NOT one of these is treated as a leaked fragment of a
 * quoted/`;`-bearing cookie value and masked (codex R2 P2 edge).
 */
const KNOWN_COOKIE_ATTRS = new Set([
  "path",
  "domain",
  "expires",
  "max-age",
  "samesite",
  "secure",
  "httponly",
  "priority",
  "partitioned",
]);

/**
 * Redact a Set-Cookie header value.
 *
 * GLU-104: masks the cookie value UNCONDITIONALLY (a Set-Cookie value is a
 * credential being minted — session id / auth token — and the cookie name is
 * arbitrary, so name-based selectivity leaked opaquely-named session cookies).
 * Standard cookie attributes (Path, Domain, HttpOnly, Secure, SameSite,
 * Max-Age, Expires, Priority, Partitioned) are structural, not secret, and are
 * preserved verbatim; a NON-standard token in attribute position (which a
 * naive `;` split of a quoted value can produce) is masked, not leaked.
 */
function redactSetCookie(
  raw: string,
  ctx: HandlerContext,
  engine: RedactionEngineInterface,
): RedactionResult {
  const parts = raw.split(";").map((p) => p.trim());

  // First part is name=value
  const first = parts[0] ?? "";
  const eq = first.indexOf("=");
  if (eq === -1) {
    // No `name=value` structure (malformed / bare opaque token). A Set-Cookie
    // header is a minted credential by definition — fail closed and mask the
    // whole value rather than return it verbatim (codex R2 P2).
    if (raw.trim() === "") {
      return { value: raw, redacted: false, details: [] };
    }
    return {
      value: maskCookieValue(raw, engine),
      redacted: true,
      details: [{ path: "set-cookie", plugin: "set-cookie", original: raw }],
    };
  }

  const cookieName = first.slice(0, eq).trim();
  const cookieValue = first.slice(eq + 1).trim();
  const redactedValue = maskCookieValue(cookieValue, engine);

  // Attributes: keep standard ones verbatim; mask any non-standard token,
  // which is most likely a leaked fragment of a `;`-bearing/quoted value.
  // Drop EMPTY fragments (a trailing `;` — `sid=x; Path=/;` — would otherwise
  // become a masked pseudo-attribute) (codex R3 P3).
  const attributes = parts
    .slice(1)
    .filter((attr) => attr !== "")
    .map((attr) => {
      const attrName = attr.split("=")[0].trim().toLowerCase();
      return KNOWN_COOKIE_ATTRS.has(attrName) ? attr : maskCookieValue(attr, engine);
    });

  const reconstructed =
    attributes.length > 0
      ? `${cookieName}=${redactedValue}; ${attributes.join("; ")}`
      : `${cookieName}=${redactedValue}`;

  return {
    value: reconstructed,
    redacted: true,
    details: [{ path: cookieName, plugin: "set-cookie", original: cookieValue }],
  };
}

// ── Handler registry ─────────────────────────────────────────────────────────

/** All built-in handlers indexed by name. */
export const BUILTIN_HANDLERS: Record<string, RedactionHandler> = {
  json: jsonHandler,
  "raw-string": rawStringHandler,
  "url-query": urlQueryHandler,
  headers: headersHandler,
  body: bodyHandler,
};
