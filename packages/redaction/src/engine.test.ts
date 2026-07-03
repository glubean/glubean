/**
 * Tests for @glubean/redaction v2.
 *
 * Covers: engine, handlers, compiler, adapter, and end-to-end flows.
 */

import { test, expect, describe } from "vitest";
import { RedactionEngine, genericPartialMask } from "./engine.js";
import { compileScopes, redactValue } from "./compiler.js";
import { redactEvent } from "./adapter.js";
import {
  jsonHandler,
  rawStringHandler,
  urlQueryHandler,
  headersHandler,
  bodyHandler,
} from "./handlers.js";
import { sensitiveKeysPlugin } from "./plugins/sensitive-keys.js";
import { jwtPlugin } from "./plugins/jwt.js";
import { bearerPlugin } from "./plugins/bearer.js";
import { emailPlugin } from "./plugins/email.js";
import { ipAddressPlugin } from "./plugins/ip-address.js";
import { creditCardPlugin } from "./plugins/credit-card.js";
import { BUILTIN_SCOPES, DEFAULT_GLOBAL_RULES } from "./defaults.js";
import type { RedactionScopeDeclaration } from "./types.js";

// =============================================================================
// Engine — core walker
// =============================================================================

describe("RedactionEngine", () => {
  test("redacts sensitive keys", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["password"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });

    const result = engine.redact({ password: "secret123", username: "alice" });
    const val = result.value as Record<string, unknown>;
    expect(val.password).toBe("[REDACTED]");
    expect(val.username).toBe("alice");
    expect(result.redacted).toBe(true);
  });

  test("substring key matching", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["token"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });

    const result = engine.redact({ "x-auth-token": "abc", "access_token": "def" });
    const val = result.value as Record<string, unknown>;
    expect(val["x-auth-token"]).toBe("[REDACTED]");
    expect(val["access_token"]).toBe("[REDACTED]");
  });

  // GLU-129 codex R11 P1: entries-shaped 2-tuple arrays (`Object.entries()`,
  // `Map` entries, header-pair arrays: `["token", "secret"]`) carry their key
  // as element 0, not as an object property, so the object-key sensitivity
  // check in walkObject() never sees them. Fails against pre-fix engine.ts,
  // which walked each array element independently by numeric index and
  // treated "token" and "secret" as two unrelated, non-sensitive strings.
  test("redacts sensitive values inside entries-shaped 2-tuple arrays", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["token"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });

    const result = engine.redact([["token", "opaque-kv-pair-secret"], ["name", "alice"]]);
    const val = result.value as unknown[];
    expect(val[0]).toEqual(["token", "[REDACTED]"]);
    expect(val[1]).toEqual(["name", "alice"]);
    expect(result.redacted).toBe(true);
    expect(JSON.stringify(result.value)).not.toContain("opaque-kv-pair-secret");
  });

  test("entries-shaped tuple with object value is recursed, not wholesale-masked", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["headers"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });

    const result = engine.redact([["headers", { authorization: "keep-me-if-not-sensitive" }]]);
    const val = result.value as unknown[];
    // "headers" is sensitive and its value is an object — recursed (not
    // wholesale-masked), same rule as a real object key would apply.
    expect(Array.isArray(val[0])).toBe(true);
  });

  test("non-entries 2-element arrays are unaffected", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["token"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });

    // First element is a number, not a string key — must not be treated as
    // an entries tuple.
    const result = engine.redact([[1, "token"]]);
    const val = result.value as unknown[];
    expect(val[0]).toEqual([1, "token"]);
    expect(result.redacted).toBe(false);
  });

  // GLU-129 codex R12 P1: an earlier version of the entries-tuple fix always
  // RECURSED into an object/array value under a sensitive tuple key,
  // regardless of `sensitiveKeyRecurse` — in event mode (the default, no
  // recurse) this skipped the wholesale mask `walkObject()` applies to a
  // real sensitive object key, so a non-key-matched scalar INSIDE the
  // container (visited by plain numeric-index walk) still leaked. Fails
  // against that earlier version, passes once the tuple case shares
  // `maskSensitiveKeyedValue()` with `walkObject()`.
  test("event mode wholesale-masks a container value under a sensitive tuple key", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["token"], excluded: [] }),
      ],
      replacementFormat: "simple",
      // sensitiveKeyRecurse defaults to false — this IS event mode.
    });

    const result = engine.redact([["token", ["opaque-kv-array-secret"]]]);
    expect(JSON.stringify(result.value)).not.toContain("opaque-kv-array-secret");
    expect(result.value).toEqual([["token", "[REDACTED]"]]);
    expect(result.redacted).toBe(true);
  });

  test("recurse mode masks array elements under a sensitive tuple key like a real object key", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["token"], excluded: [] }),
      ],
      replacementFormat: "simple",
      sensitiveKeyRecurse: true,
    });

    const viaObjectKey = engine.redact({ token: ["opaque-array-secret"] });
    const viaTuple = engine.redact([["token", ["opaque-array-secret"]]]);
    // Same recurse-mode decision (mask array elements, preserve array shape)
    // whether the sensitive key is a real object property or a tuple's
    // element 0.
    expect((viaObjectKey.value as { token: unknown }).token).toEqual(["[REDACTED]"]);
    expect((viaTuple.value as unknown[])[0]).toEqual(["token", ["[REDACTED]"]]);
  });

  test("partial replacement format", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["secret"], excluded: [] }),
      ],
      replacementFormat: "partial",
    });

    const result = engine.redact({ secret: "my-long-secret-value" });
    const val = result.value as Record<string, unknown>;
    expect(val.secret).not.toBe("my-long-secret-value");
    expect(val.secret).toContain("***");
  });

  test("labeled replacement format", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["key"], excluded: [] }),
      ],
      replacementFormat: "labeled",
    });

    const result = engine.redact({ key: "value" });
    const val = result.value as Record<string, unknown>;
    expect(val.key).toBe("[REDACTED]");
  });

  test("recursively walks nested objects", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["password"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });

    const result = engine.redact({
      user: { profile: { password: "secret" }, name: "alice" },
    });
    const val = result.value as any;
    expect(val.user.profile.password).toBe("[REDACTED]");
    expect(val.user.name).toBe("alice");
  });

  test("recursively walks arrays", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["token"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });

    const result = engine.redact([{ token: "a" }, { token: "b" }, { name: "c" }]);
    const val = result.value as any[];
    expect(val[0].token).toBe("[REDACTED]");
    expect(val[1].token).toBe("[REDACTED]");
    expect(val[2].name).toBe("c");
  });

  test("applies value-level pattern plugins", () => {
    const engine = new RedactionEngine({
      plugins: [emailPlugin],
      replacementFormat: "partial",
    });

    const result = engine.redact({ message: "Contact user@example.com for help" });
    const val = result.value as Record<string, unknown>;
    expect(val.message).not.toContain("user@example.com");
    expect(result.redacted).toBe(true);
  });

  test("JWT pattern detection", () => {
    const engine = new RedactionEngine({
      plugins: [jwtPlugin],
      replacementFormat: "simple",
    });

    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = engine.redact({ data: jwt });
    const val = result.value as Record<string, unknown>;
    expect(val.data).toBe("[REDACTED]");
  });

  test("bearer pattern detection", () => {
    const engine = new RedactionEngine({
      plugins: [bearerPlugin],
      replacementFormat: "simple",
    });

    const result = engine.redact({ header: "Bearer my-secret-token-123" });
    const val = result.value as Record<string, unknown>;
    expect(val.header).toBe("[REDACTED]");
  });

  test("depth guard prevents infinite recursion", () => {
    const engine = new RedactionEngine({
      plugins: [],
      replacementFormat: "simple",
      maxDepth: 2,
    });

    const deep = { a: { b: { c: { d: "value" } } } };
    const result = engine.redact(deep);
    const val = result.value as any;
    expect(val.a.b.c).toBe("[REDACTED: too deep]");
  });

  test("null and undefined pass through", () => {
    const engine = new RedactionEngine({ plugins: [], replacementFormat: "simple" });
    expect(engine.redact(null).value).toBe(null);
    expect(engine.redact(undefined).value).toBe(undefined);
  });

  test("numbers and booleans pass through", () => {
    const engine = new RedactionEngine({ plugins: [], replacementFormat: "simple" });
    const result = engine.redact({ count: 42, active: true });
    const val = result.value as Record<string, unknown>;
    expect(val.count).toBe(42);
    expect(val.active).toBe(true);
    expect(result.redacted).toBe(false);
  });

  test("records details with path and plugin name", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["secret"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });

    const result = engine.redact({ user: { secret: "abc" } });
    expect(result.details.length).toBe(1);
    expect(result.details[0].path).toBe("user.secret");
    expect(result.details[0].plugin).toBe("sensitive-keys");
    expect(result.details[0].original).toBe("abc");
  });
});

// =============================================================================
// genericPartialMask
// =============================================================================

describe("genericPartialMask", () => {
  test("short values get full mask", () => {
    expect(genericPartialMask("ab")).toBe("****");
    expect(genericPartialMask("abcd")).toBe("****");
  });

  test("medium values show first 2 and last 1", () => {
    expect(genericPartialMask("abcde")).toBe("ab***e");
    expect(genericPartialMask("abcdefgh")).toBe("ab***h");
  });

  test("long values show first 3 and last 3", () => {
    expect(genericPartialMask("abcdefghijk")).toBe("abc***ijk");
  });
});

// =============================================================================
// Handlers
// =============================================================================

describe("jsonHandler", () => {
  test("delegates to engine.redact", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["secret"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });

    const result = jsonHandler.process(
      { secret: "abc", name: "test" },
      { scopeId: "test", scopeName: "Test" },
      engine,
    );
    const val = result.value as Record<string, unknown>;
    expect(val.secret).toBe("[REDACTED]");
    expect(val.name).toBe("test");
  });
});

describe("rawStringHandler", () => {
  test("applies pattern matching to raw strings", () => {
    const engine = new RedactionEngine({
      plugins: [emailPlugin],
      replacementFormat: "simple",
    });

    const result = rawStringHandler.process(
      "Contact user@example.com",
      { scopeId: "test", scopeName: "Test" },
      engine,
    );
    expect(result.value).not.toContain("user@example.com");
    expect(result.redacted).toBe(true);
  });

  test("passes through non-strings", () => {
    const engine = new RedactionEngine({ plugins: [], replacementFormat: "simple" });
    const result = rawStringHandler.process(
      42,
      { scopeId: "test", scopeName: "Test" },
      engine,
    );
    expect(result.value).toBe(42);
    expect(result.redacted).toBe(false);
  });
});

describe("urlQueryHandler", () => {
  test("redacts sensitive query parameters", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["token", "api_key"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });

    const result = urlQueryHandler.process(
      "https://api.example.com/data?token=secret123&page=1&api_key=mykey",
      { scopeId: "test", scopeName: "Test" },
      engine,
    );

    const url = new URL(result.value as string);
    expect(url.searchParams.get("token")).toBe("[REDACTED]");
    expect(url.searchParams.get("api_key")).toBe("[REDACTED]");
    expect(url.searchParams.get("page")).toBe("1");
    expect(result.redacted).toBe(true);
  });

  test("passes through URLs without query params", () => {
    const engine = new RedactionEngine({ plugins: [], replacementFormat: "simple" });
    const result = urlQueryHandler.process(
      "https://api.example.com/data",
      { scopeId: "test", scopeName: "Test" },
      engine,
    );
    expect(result.value).toBe("https://api.example.com/data");
    expect(result.redacted).toBe(false);
  });

  // codex R3 P2: relative / query-only URLs (a trace `requestedUrl`) must
  // redact query secrets too — `new URL()` throws on them, so key-based
  // redaction was previously skipped.
  test("redacts query secrets in a RELATIVE url, preserving the relative form", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["token"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });
    const result = urlQueryHandler.process(
      "/login?token=secret123&page=2",
      { scopeId: "test", scopeName: "Test" },
      engine,
    );
    const out = result.value as string;
    expect(out.startsWith("/login?")).toBe(true); // stayed relative
    expect(out).not.toContain("secret123");
    expect(out).toContain("page=2");
    expect(result.redacted).toBe(true);
  });

  test("redacts a query-only relative url (?token=…)", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["token"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });
    const result = urlQueryHandler.process(
      "?token=secret456",
      { scopeId: "test", scopeName: "Test" },
      engine,
    );
    const out = result.value as string;
    expect(out).not.toContain("secret456");
    expect(out.startsWith("?")).toBe(true); // no spurious leading "/"
    expect(result.redacted).toBe(true);
  });

  // codex R4 P3: URL SHAPE must be preserved exactly across relative forms.
  test("preserves URL shape (bare-relative, protocol-relative, fragment)", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["token"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });
    const run = (v: string) =>
      urlQueryHandler.process(v, { scopeId: "t", scopeName: "T" }, engine).value as string;

    // Bare-relative path kept; fragment kept; page kept; token gone.
    const bare = run("todos/1?token=secret&page=2#frag");
    expect(bare.startsWith("todos/1?")).toBe(true);
    expect(bare).toContain("page=2");
    expect(bare).toContain("#frag");
    expect(bare).not.toContain("secret");

    // Protocol-relative //host preserved (not dropped).
    const protoRel = run("//api.example.com/p?token=secret");
    expect(protoRel.startsWith("//api.example.com/p?")).toBe(true);
    expect(protoRel).not.toContain("secret");

    // A `?` inside the fragment is NOT a query — string is scanned, not spliced.
    const fragQ = run("/path#section?notaquery");
    expect(fragQ).toBe("/path#section?notaquery");
  });

  // codex R5 P2: OAuth implicit-grant tokens live in the fragment.
  test("redacts credentials in a k=v URL fragment, preserving non-secret params", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["access_token", "token"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });
    const out = urlQueryHandler.process(
      "https://app/callback#access_token=SECRETA&token=SECRETB&expires_in=3600",
      { scopeId: "t", scopeName: "T" },
      engine,
    ).value as string;
    expect(out).not.toContain("SECRETA");
    expect(out).not.toContain("SECRETB");
    expect(out).toContain("expires_in=3600");
    expect(out.startsWith("https://app/callback#")).toBe(true);
  });

  // codex R5 P3: an empty sensitive query value must stay empty, not `****`.
  test("does not over-mask an empty query value (?token=)", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["token"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });
    const out = urlQueryHandler.process(
      "/x?token=&page=2",
      { scopeId: "t", scopeName: "T" },
      engine,
    );
    expect(out.value).toBe("/x?token=&page=2");
    expect(out.redacted).toBe(false);
  });

  test("falls back to engine for non-URL strings", () => {
    const engine = new RedactionEngine({
      plugins: [emailPlugin],
      replacementFormat: "simple",
    });
    const result = urlQueryHandler.process(
      "not a url user@example.com",
      { scopeId: "test", scopeName: "Test" },
      engine,
    );
    expect(result.redacted).toBe(true);
  });

  test("passes through non-strings", () => {
    const engine = new RedactionEngine({ plugins: [], replacementFormat: "simple" });
    const result = urlQueryHandler.process(
      42,
      { scopeId: "test", scopeName: "Test" },
      engine,
    );
    expect(result.value).toBe(42);
    expect(result.redacted).toBe(false);
  });
});

describe("headersHandler", () => {
  test("redacts sensitive header values", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["authorization"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });

    const result = headersHandler.process(
      { authorization: "Bearer secret", "content-type": "application/json" },
      { scopeId: "test", scopeName: "Test" },
      engine,
    );
    const val = result.value as Record<string, unknown>;
    expect(val.authorization).toBe("[REDACTED]");
    expect(val["content-type"]).toBe("application/json");
  });

  // GLU-104: a Cookie header value is credential material by default and
  // cookie names are arbitrary/opaque, so EVERY cookie value is masked
  // (names preserved). Previously this masked only name-matched cookies,
  // leaking opaquely-named session cookies.
  test("masks every cookie value in a Cookie header, preserving names", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["session"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });

    const result = headersHandler.process(
      { cookie: "session=abc123; theme=dark; auth=opaqueOtherValue" },
      { scopeId: "test", scopeName: "Test" },
      engine,
    );
    const val = result.value as Record<string, unknown>;
    const cookie = val.cookie as string;
    // Names preserved (structure), values masked — including "theme" and the
    // opaquely-named "auth" cookie that no sensitive-key would have matched.
    expect(cookie).toContain("session=");
    expect(cookie).toContain("theme=");
    expect(cookie).toContain("auth=");
    expect(cookie).not.toContain("abc123");
    expect(cookie).not.toContain("dark");
    expect(cookie).not.toContain("opaqueOtherValue");
    expect(result.redacted).toBe(true);
  });

  test("parses and redacts set-cookie header preserving attributes", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["session"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });

    const result = headersHandler.process(
      { "set-cookie": "session=secret-value; Path=/; HttpOnly; Secure" },
      { scopeId: "test", scopeName: "Test" },
      engine,
    );
    const val = result.value as Record<string, unknown>;
    const setCookie = val["set-cookie"] as string;
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).not.toContain("secret-value");
  });

  // codex R2 P2: a Cookie / Set-Cookie value with no parseable `name=value`
  // (a bare opaque token) used to be returned verbatim — fail closed instead.
  test("masks a malformed Cookie header with no '=' (bare opaque token)", () => {
    const engine = new RedactionEngine({ plugins: [], replacementFormat: "simple" });
    const result = headersHandler.process(
      { cookie: "opaque-session-token-no-delim" },
      { scopeId: "test", scopeName: "Test" },
      engine,
    );
    const val = result.value as Record<string, unknown>;
    expect(val.cookie).not.toContain("opaque-session-token-no-delim");
    expect(result.redacted).toBe(true);
  });

  test("masks a malformed Set-Cookie header with no '='", () => {
    const engine = new RedactionEngine({ plugins: [], replacementFormat: "simple" });
    const result = headersHandler.process(
      { "set-cookie": "opaque-setcookie-no-delim" },
      { scopeId: "test", scopeName: "Test" },
      engine,
    );
    const val = result.value as Record<string, unknown>;
    expect(val["set-cookie"]).not.toContain("opaque-setcookie-no-delim");
    expect(result.redacted).toBe(true);
  });

  test("masks a non-standard Set-Cookie attribute fragment (quoted ';' value)", () => {
    const engine = new RedactionEngine({ plugins: [], replacementFormat: "simple" });
    // A naive `;` split of `sid="AAA;BBB"` puts `BBB"` in attribute position;
    // it must be masked, not preserved as an attribute — while standard
    // attributes (Path/HttpOnly) survive.
    const result = headersHandler.process(
      { "set-cookie": 'sid="AAA;BBB-leak-fragment"; Path=/; HttpOnly' },
      { scopeId: "test", scopeName: "Test" },
      engine,
    );
    const val = result.value as Record<string, unknown>;
    const setCookie = val["set-cookie"] as string;
    expect(setCookie).not.toContain("BBB-leak-fragment");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
  });

  // codex R5 defensive: a non-string element in a set-cookie array (malformed
  // trace) must be deep-redacted, not passed through.
  test("deep-redacts a non-string element in a set-cookie array", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["authorization"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });
    const result = headersHandler.process(
      { "set-cookie": ["sid=x; Path=/", { authorization: "OBJ-SECRET" } as unknown as string] },
      { scopeId: "test", scopeName: "Test" },
      engine,
    );
    const arr = (result.value as Record<string, unknown>)["set-cookie"] as unknown[];
    expect(JSON.stringify(arr)).not.toContain("OBJ-SECRET");
  });

  // codex confirmation review: a cyclic object in a set-cookie array must not
  // stack-overflow — the depth guard drops the subtree instead.
  test("does not crash on a cyclic non-string set-cookie element", () => {
    const engine = new RedactionEngine({ plugins: [], replacementFormat: "simple" });
    const cyclic: Record<string, unknown> = { value: "DEEP-SECRET" };
    cyclic.self = cyclic; // cycle
    expect(() =>
      headersHandler.process(
        { "set-cookie": [cyclic as unknown as string] },
        { scopeId: "test", scopeName: "Test" },
        engine,
      ),
    ).not.toThrow();
  });

  // codex R3 P3: a trailing `;` must not become a masked pseudo-attribute.
  test("drops a trailing empty Set-Cookie fragment", () => {
    const engine = new RedactionEngine({ plugins: [], replacementFormat: "simple" });
    const result = headersHandler.process(
      { "set-cookie": "sid=secret-x; Path=/; HttpOnly;" },
      { scopeId: "test", scopeName: "Test" },
      engine,
    );
    const setCookie = (result.value as Record<string, unknown>)["set-cookie"] as string;
    expect(setCookie).not.toContain("secret-x");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    // No stray masked attribute appended after HttpOnly.
    expect(setCookie.trimEnd().endsWith("HttpOnly")).toBe(true);
  });

  test("passes through non-objects", () => {
    const engine = new RedactionEngine({ plugins: [], replacementFormat: "simple" });
    const result = headersHandler.process(
      "not-an-object",
      { scopeId: "test", scopeName: "Test" },
      engine,
    );
    expect(result.value).toBe("not-an-object");
    expect(result.redacted).toBe(false);
  });
});

describe("bodyHandler", () => {
  const ctx = { scopeId: "http.request.body", scopeName: "HTTP request body" };

  test("redacts an object body like the json handler", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["password"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });
    const result = bodyHandler.process(
      { username: "alice", password: "hunter2" },
      ctx,
      engine,
    );
    const val = result.value as Record<string, unknown>;
    expect(val.username).toBe("alice");
    expect(val.password).toBe("[REDACTED]");
    expect(result.redacted).toBe(true);
  });

  test("redacts sensitive params in a form-urlencoded string body by name", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({
          useBuiltIn: false,
          additional: ["password", "client_secret"],
          excluded: [],
        }),
      ],
      replacementFormat: "simple",
    });
    const result = bodyHandler.process(
      "username=alice&password=hunter2&client_secret=plain",
      ctx,
      engine,
    );
    const body = result.value as string;
    expect(body).toContain("username=alice");
    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("plain");
    expect(result.redacted).toBe(true);
  });

  test("value-pattern-scans a non-form string body (bearer token)", () => {
    const engine = new RedactionEngine({
      plugins: [
        {
          name: "bearer",
          matchValue: () => /Bearer\s+[a-zA-Z0-9._-]+/gi,
        },
      ],
      replacementFormat: "labeled",
    });
    const result = bodyHandler.process(
      "denied: Bearer abc123def456 is invalid",
      ctx,
      engine,
    );
    const body = result.value as string;
    expect(body).not.toContain("Bearer abc123def456");
    expect(body).toContain("[REDACTED:bearer]");
  });

  test("does NOT reserialize arbitrary text that merely contains '='", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["password"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });
    // Prose with spaces around '=' must not be treated as urlencoded.
    const text = "note: total = 3 items and password mentioned in passing";
    const result = bodyHandler.process(text, ctx, engine);
    expect(result.value).toBe(text);
    expect(result.redacted).toBe(false);
  });

  test("passes through non-string, non-object bodies", () => {
    const engine = new RedactionEngine({ plugins: [], replacementFormat: "simple" });
    expect(bodyHandler.process(42, ctx, engine).value).toBe(42);
    expect(bodyHandler.process(null, ctx, engine).value).toBeNull();
  });

  // codex R2 P2: a JSON body captured as a raw string (mislabelled
  // content-type) must be parsed and redacted by KEY, not only value-scanned.
  test("redacts a JSON-as-string body structurally by key", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["token"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });
    const result = bodyHandler.process(
      '{"token":"plain-session-value","user":{"name":"alice"}}',
      ctx,
      engine,
    );
    const body = result.value as string;
    expect(body).not.toContain("plain-session-value");
    expect(body).toContain("alice");
    expect(result.redacted).toBe(true);
    // Still valid JSON after redaction.
    expect(() => JSON.parse(body)).not.toThrow();
  });

  // codex R3 P3: a clean JSON-as-string body must be returned VERBATIM (not
  // re-serialized / whitespace-normalized) when nothing was redacted.
  test("returns a clean JSON-as-string body verbatim (no normalization)", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["token"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });
    const original = '  { "status" : "ok" }  ';
    const result = bodyHandler.process(original, ctx, engine);
    expect(result.value).toBe(original);
    expect(result.redacted).toBe(false);
  });

  test("falls back to string scanning for an invalid-JSON '{'-led body", () => {
    const engine = new RedactionEngine({
      plugins: [{ name: "bearer", matchValue: () => /Bearer\s+\S+/gi }],
      replacementFormat: "labeled",
    });
    // Looks JSON-ish but is not parseable — must not throw, falls through to
    // the value-pattern scan.
    const result = bodyHandler.process(
      "{not json, Bearer abc123 here}",
      ctx,
      engine,
    );
    const body = result.value as string;
    expect(body).not.toContain("Bearer abc123");
    expect(body).toContain("[REDACTED:bearer]");
  });
});

// =============================================================================
// Compiler
// =============================================================================

describe("compileScopes", () => {
  const minimalScope: RedactionScopeDeclaration = {
    id: "test.scope",
    name: "Test scope",
    event: "trace",
    target: "data.field",
    handler: "json",
    rules: { sensitiveKeys: ["secret"] },
  };

  test("compiles a minimal scope declaration", () => {
    const compiled = compileScopes({
      builtinScopes: [minimalScope],
      globalRules: { sensitiveKeys: [], patterns: [], customPatterns: [] },
      replacementFormat: "simple",
    });

    expect(compiled.length).toBe(1);
    expect(compiled[0].id).toBe("test.scope");
    expect(compiled[0].event).toBe("trace");
    expect(compiled[0].enabled).toBe(true);
    expect(compiled[0].handler.name).toBe("json");
  });

  test("applies user override to disable scope", () => {
    const compiled = compileScopes({
      builtinScopes: [minimalScope],
      globalRules: { sensitiveKeys: [], patterns: [], customPatterns: [] },
      replacementFormat: "simple",
      userOverrides: { "test.scope": { enabled: false } },
    });

    expect(compiled[0].enabled).toBe(false);
  });

  test("merges user override rules with scope rules", () => {
    const compiled = compileScopes({
      builtinScopes: [minimalScope],
      globalRules: { sensitiveKeys: [], patterns: [], customPatterns: [] },
      replacementFormat: "simple",
      userOverrides: {
        "test.scope": { rules: { sensitiveKeys: ["extra-key"] } },
      },
    });

    const engine = new RedactionEngine({
      plugins: compiled[0].plugins,
      replacementFormat: "simple",
    });

    const r1 = engine.redact({ secret: "a", "extra-key": "b", normal: "c" });
    const val = r1.value as Record<string, unknown>;
    expect(val.secret).toBe("[REDACTED]");
    expect(val["extra-key"]).toBe("[REDACTED]");
    expect(val.normal).toBe("c");
  });

  test("merges global rules with scope rules", () => {
    const compiled = compileScopes({
      builtinScopes: [minimalScope],
      globalRules: { sensitiveKeys: ["global-secret"], patterns: [], customPatterns: [] },
      replacementFormat: "simple",
    });

    const engine = new RedactionEngine({
      plugins: compiled[0].plugins,
      replacementFormat: "simple",
    });

    const result = engine.redact({ "global-secret": "a", secret: "b" });
    const val = result.value as Record<string, unknown>;
    expect(val["global-secret"]).toBe("[REDACTED]");
    expect(val.secret).toBe("[REDACTED]");
  });

  test("includes plugin scopes", () => {
    const pluginScope: RedactionScopeDeclaration = {
      id: "grpc.metadata",
      name: "gRPC metadata",
      event: "trace",
      target: "data.metadata",
      handler: "headers",
      rules: { sensitiveKeys: ["authorization"] },
    };

    const compiled = compileScopes({
      builtinScopes: [minimalScope],
      pluginScopes: [pluginScope],
      globalRules: { sensitiveKeys: [], patterns: [], customPatterns: [] },
      replacementFormat: "simple",
    });

    expect(compiled.length).toBe(2);
    expect(compiled[1].id).toBe("grpc.metadata");
    expect(compiled[1].handler.name).toBe("headers");
  });

  test("throws on unknown handler", () => {
    expect(() =>
      compileScopes({
        builtinScopes: [{ ...minimalScope, handler: "nonexistent" }],
        globalRules: { sensitiveKeys: [], patterns: [], customPatterns: [] },
        replacementFormat: "simple",
      }),
    ).toThrow('unknown handler "nonexistent"');
  });

  test("includes global pattern plugins", () => {
    const compiled = compileScopes({
      builtinScopes: [minimalScope],
      globalRules: { sensitiveKeys: [], patterns: ["email"], customPatterns: [] },
      replacementFormat: "simple",
    });

    const engine = new RedactionEngine({
      plugins: compiled[0].plugins,
      replacementFormat: "simple",
    });

    const result = engine.redact({ note: "Contact user@example.com" });
    const val = result.value as Record<string, unknown>;
    expect(val.note).not.toContain("user@example.com");
  });

  test("field path accessor works", () => {
    const compiled = compileScopes({
      builtinScopes: [{
        ...minimalScope,
        target: "data.nested.field",
      }],
      globalRules: { sensitiveKeys: [], patterns: [], customPatterns: [] },
      replacementFormat: "simple",
    });

    const event = { type: "trace", data: { nested: { field: { secret: "abc" } } } };
    const val = compiled[0].get(event);
    expect(val).toEqual({ secret: "abc" });

    compiled[0].set(event, { secret: "[REDACTED]" });
    expect((event.data.nested as any).field).toEqual({ secret: "[REDACTED]" });
  });
});

// =============================================================================
// Adapter — redactEvent
// =============================================================================

describe("redactEvent", () => {
  function compileDefaults() {
    return compileScopes({
      builtinScopes: BUILTIN_SCOPES,
      globalRules: DEFAULT_GLOBAL_RULES,
      replacementFormat: "partial",
    });
  }

  test("redacts trace requestHeaders", () => {
    const scopes = compileDefaults();
    const event = {
      type: "trace",
      data: {
        requestHeaders: { authorization: "Bearer secret-token-12345" },
      },
    };

    const result = redactEvent(event, scopes, "simple");
    const data = result.data as Record<string, unknown>;
    const headers = data.requestHeaders as Record<string, unknown>;
    expect(headers.authorization).toBe("[REDACTED]");
  });

  // GLU-105: `browser:download` evidence is emitted as an ExecutionEvent of
  // type "event" wrapping { type, data:{ url } }; a signed/credentialed
  // download URL must not persist to disk/upload in plaintext.
  test("redacts secret query params in a browser:download event url", () => {
    const scopes = compileDefaults();
    const result = redactEvent(
      {
        type: "event",
        data: {
          type: "browser:download",
          data: {
            guid: "d1",
            url: "https://files.example.com/r.pdf?X-Amz-Signature=abc&token=zzz",
            filename: "r.pdf",
            state: "completed",
          },
        },
      },
      scopes,
      "simple",
    );
    const inner = (result.data as Record<string, unknown>).data as Record<string, unknown>;
    const url = String(inner.url);
    expect(url).not.toContain("zzz");
    const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(params.get("token")).toBe("[REDACTED]");
    expect(params.get("X-Amz-Signature")).toBe("[REDACTED]");
    // Non-secret parts of the URL preserved.
    expect(url.startsWith("https://files.example.com/r.pdf?")).toBe(true);
  });

  // GLU-105: `page.waitForDownload()` emits an action whose detail.url copies
  // the same download URL — the action sink must mask what the event sink does.
  test("redacts secret query params in a waitForDownload action detail.url", () => {
    const scopes = compileDefaults();
    const result = redactEvent(
      {
        type: "action",
        data: {
          category: "browser:waitForDownload",
          target: "r.pdf",
          duration: 5,
          status: "ok",
          detail: { url: "https://files.example.com/r.pdf?token=zzz", path: "/tmp/r.pdf" },
        },
      },
      scopes,
      "simple",
    );
    const detail = (result.data as Record<string, unknown>).detail as Record<string, unknown>;
    expect(String(detail.url)).not.toContain("zzz");
    // A non-download action with no detail.url is a no-op (get returns undefined).
    const passthrough = redactEvent(
      { type: "action", data: { category: "http:request", target: "GET /x", duration: 1, status: "ok", detail: { status: 200 } } },
      scopes,
      "simple",
    );
    const pd = (passthrough.data as Record<string, unknown>).detail as Record<string, unknown>;
    expect(pd.status).toBe(200);
  });

  test("redacts secrets in branch decision error (mirrors status.error)", () => {
    const scopes = compileDefaults();
    const errStr = "predicate threw: Authorization Bearer abc123secretToken";
    const branchOut = redactEvent(
      { type: "branch", index: 0, name: "<predicate-branch>", takenIndex: "default", total: 1, error: errStr },
      scopes,
      "simple",
    );
    // The bearer token must be masked, just like status.error.
    expect(branchOut.error).not.toContain("abc123secretToken");
    // And branch.error is now wired identically to status.error.
    const statusOut = redactEvent({ type: "status", status: "failed", error: errStr }, scopes, "simple");
    expect(branchOut.error).toBe(statusOut.error);
  });

  test("redacts secrets in status.reason (GLU-142 — runtime ctx.skip(reason))", () => {
    const scopes = compileDefaults();
    const reasonStr = "disabled: Authorization Bearer abc123secretToken required";
    const skippedOut = redactEvent(
      { type: "status", status: "skipped", reason: reasonStr },
      scopes,
      "simple",
    );
    // The bearer token embedded in a runtime-computed ctx.skip(reason) string
    // must be masked before it reaches disk (last-run.result.json) or the
    // cloud upload (test_result row) — same scrub as status.error/status.stack.
    expect(skippedOut.reason).not.toContain("abc123secretToken");
    expect(skippedOut.reason).toBe(
      redactEvent({ type: "status", status: "failed", error: reasonStr }, scopes, "simple").error,
    );
  });

  test("redacts secrets in branch takenValue; passes non-string scalars through", () => {
    const scopes = compileDefaults();
    // String value-switch key carrying a secret → masked.
    const strOut = redactEvent(
      { type: "branch", index: 0, name: "x", takenIndex: 0, takenValue: "Bearer abc123secretToken", total: 1 },
      scopes,
      "simple",
    );
    expect(strOut.takenValue).not.toContain("abc123secretToken");
    // Numeric value-switch key (e.g. HTTP status) is untouched.
    const numOut = redactEvent(
      { type: "branch", index: 0, name: "x", takenIndex: 0, takenValue: 404, total: 1 },
      scopes,
      "simple",
    );
    expect(numOut.takenValue).toBe(404);
  });

  test("redacts secrets in branch label (message + name), leaves normal labels", () => {
    const scopes = compileDefaults();
    const out = redactEvent(
      {
        type: "branch",
        index: 0,
        name: "gate Bearer abc123secretToken",
        takenIndex: "default",
        message: "gate Bearer abc123secretToken",
        total: 1,
      },
      scopes,
      "simple",
    );
    expect(out.message).not.toContain("abc123secretToken");
    expect(out.name).not.toContain("abc123secretToken");
    // A normal label with no secret pattern is left intact.
    const plain = redactEvent(
      { type: "branch", index: 0, name: "is admin", takenIndex: 0, message: "is admin", total: 1 },
      scopes,
      "simple",
    );
    expect(plain.message).toBe("is admin");
  });

  test("redacts trace URL query params", () => {
    const scopes = compileDefaults();
    const event = {
      type: "trace",
      data: {
        url: "https://api.example.com/data?token=secret&page=1",
      },
    };

    const result = redactEvent(event, scopes, "simple");
    const data = result.data as Record<string, unknown>;
    const url = new URL(data.url as string);
    expect(url.searchParams.get("token")).toBe("[REDACTED]");
    expect(url.searchParams.get("page")).toBe("1");
  });

  test("redacts trace requestBody sensitive keys", () => {
    const scopes = compileDefaults();
    const event = {
      type: "trace",
      data: {
        requestBody: { password: "secret123", username: "alice" },
      },
    };

    const result = redactEvent(event, scopes, "simple");
    const data = result.data as Record<string, unknown>;
    const body = data.requestBody as Record<string, unknown>;
    expect(body.password).toBe("[REDACTED]");
    expect(body.username).toBe("alice");
  });

  test("redacts trace responseHeaders set-cookie", () => {
    // Use a scope with "session" as a sensitive key
    const scopes = compileScopes({
      builtinScopes: [{
        id: "http.response.headers",
        name: "HTTP response headers",
        event: "trace",
        target: "data.responseHeaders",
        handler: "headers",
        rules: { sensitiveKeys: ["set-cookie", "session"] },
      }],
      globalRules: DEFAULT_GLOBAL_RULES,
      replacementFormat: "simple",
    });

    const event = {
      type: "trace",
      data: {
        responseHeaders: {
          "set-cookie": "session=secret-value; Path=/; HttpOnly",
          "content-type": "text/html",
        },
      },
    };

    const result = redactEvent(event, scopes, "simple");
    const data = result.data as Record<string, unknown>;
    const headers = data.responseHeaders as Record<string, unknown>;
    expect(headers["content-type"]).toBe("text/html");
    const setCookie = headers["set-cookie"] as string;
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).not.toContain("secret-value");
  });

  test("redacts log message patterns", () => {
    const scopes = compileDefaults();
    const event = {
      type: "log",
      message: "User email is user@example.com",
    };

    const result = redactEvent(event, scopes, "simple");
    expect(result.message).not.toContain("user@example.com");
  });

  test("redacts error message patterns", () => {
    const scopes = compileDefaults();
    const event = {
      type: "error",
      message: "Failed for user@example.com",
    };

    const result = redactEvent(event, scopes, "simple");
    expect(result.message).not.toContain("user@example.com");
  });

  test("does not mutate original event", () => {
    const scopes = compileDefaults();
    const event = {
      type: "trace",
      data: {
        requestHeaders: { authorization: "Bearer secret" },
      },
    };

    redactEvent(event, scopes, "simple");
    expect((event.data.requestHeaders as any).authorization).toBe("Bearer secret");
  });

  test("passes through unmatched event types", () => {
    const scopes = compileDefaults();
    const event = { type: "metric", name: "duration", value: 100 };
    const result = redactEvent(event, scopes, "simple");
    expect(result).toBe(event);
  });

  test("disabled scope skips redaction", () => {
    const scopes = compileScopes({
      builtinScopes: BUILTIN_SCOPES,
      globalRules: DEFAULT_GLOBAL_RULES,
      replacementFormat: "simple",
      userOverrides: { "http.request.headers": { enabled: false } },
    });

    const event = {
      type: "trace",
      data: {
        requestHeaders: { authorization: "Bearer secret" },
      },
    };

    const result = redactEvent(event, scopes, "simple");
    const data = result.data as Record<string, unknown>;
    const headers = data.requestHeaders as Record<string, unknown>;
    expect(headers.authorization).toBe("Bearer secret");
  });
});

// =============================================================================
// End-to-end: plugin scope declarations
// =============================================================================

describe("plugin scope declarations", () => {
  test("gRPC plugin scopes work alongside HTTP scopes", () => {
    const grpcScopes: RedactionScopeDeclaration[] = [
      {
        id: "grpc.metadata",
        name: "gRPC metadata",
        event: "trace",
        target: "data.metadata",
        handler: "headers",
        rules: { sensitiveKeys: ["authorization", "cookie"] },
      },
      {
        id: "grpc.request",
        name: "gRPC request",
        event: "trace",
        target: "data.request",
        handler: "json",
      },
      {
        id: "grpc.response",
        name: "gRPC response",
        event: "trace",
        target: "data.response",
        handler: "json",
      },
    ];

    const compiled = compileScopes({
      builtinScopes: BUILTIN_SCOPES,
      pluginScopes: grpcScopes,
      globalRules: DEFAULT_GLOBAL_RULES,
      replacementFormat: "simple",
    });

    const event = {
      type: "trace",
      data: {
        protocol: "grpc",
        metadata: { authorization: "Bearer grpc-token", "x-request-id": "123" },
        request: { user_id: "u_123" },
        response: { name: "Alice", email: "alice@example.com" },
      },
    };

    const result = redactEvent(event, compiled, "simple");
    const data = result.data as Record<string, unknown>;

    const metadata = data.metadata as Record<string, unknown>;
    expect(metadata.authorization).toBe("[REDACTED]");
    expect(metadata["x-request-id"]).toBe("123");

    const response = data.response as Record<string, unknown>;
    expect(response.name).toBe("Alice");
    expect(response.email).not.toContain("alice@example.com");
  });

  test("scope-specific keys don't leak across scopes", () => {
    const scopeA: RedactionScopeDeclaration = {
      id: "scope.a",
      name: "Scope A",
      event: "trace",
      target: "data.a",
      handler: "json",
      rules: { sensitiveKeys: ["secret-a"] },
    };

    const scopeB: RedactionScopeDeclaration = {
      id: "scope.b",
      name: "Scope B",
      event: "trace",
      target: "data.b",
      handler: "json",
      rules: { sensitiveKeys: ["secret-b"] },
    };

    const compiled = compileScopes({
      builtinScopes: [scopeA, scopeB],
      globalRules: { sensitiveKeys: [], patterns: [], customPatterns: [] },
      replacementFormat: "simple",
    });

    const event = {
      type: "trace",
      data: {
        a: { "secret-a": "val-a", "secret-b": "val-b-in-a" },
        b: { "secret-a": "val-a-in-b", "secret-b": "val-b" },
      },
    };

    const result = redactEvent(event, compiled, "simple");
    const data = result.data as Record<string, unknown>;

    const a = data.a as Record<string, unknown>;
    expect(a["secret-a"]).toBe("[REDACTED]");
    expect(a["secret-b"]).toBe("val-b-in-a");

    const b = data.b as Record<string, unknown>;
    expect(b["secret-a"]).toBe("val-a-in-b");
    expect(b["secret-b"]).toBe("[REDACTED]");
  });
});

// =============================================================================
// Pattern plugins (individual)
// =============================================================================

describe("pattern plugins", () => {
  test("credit card with separators", () => {
    const engine = new RedactionEngine({
      plugins: [creditCardPlugin],
      replacementFormat: "partial",
    });

    const result = engine.redact({ card: "4111-1111-1111-1111" });
    const val = result.value as Record<string, unknown>;
    const masked = val.card as string;
    expect(masked).toContain("1111");
    expect(masked).not.toBe("4111-1111-1111-1111");
  });

  test("IP address masking", () => {
    const engine = new RedactionEngine({
      plugins: [ipAddressPlugin],
      replacementFormat: "partial",
    });

    const result = engine.redact({ ip: "Server at 192.168.1.100" });
    const val = result.value as Record<string, unknown>;
    expect(val.ip).toContain("192.168");
    expect(val.ip).not.toContain("1.100");
  });
});

// =============================================================================
// Regression tests
// =============================================================================

describe("regressions", () => {
  test("urlQueryHandler preserves repeated query params", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["token"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });

    const result = urlQueryHandler.process(
      "https://api.example.com/data?token=a&token=b&page=1",
      { scopeId: "test", scopeName: "Test" },
      engine,
    );

    const url = new URL(result.value as string);
    const tokens = url.searchParams.getAll("token");
    expect(tokens.length).toBe(2);
    expect(tokens[0]).toBe("[REDACTED]");
    expect(tokens[1]).toBe("[REDACTED]");
    expect(url.searchParams.get("page")).toBe("1");
  });

  test("headersHandler handles set-cookie as string[]", () => {
    const engine = new RedactionEngine({
      plugins: [
        sensitiveKeysPlugin({ useBuiltIn: false, additional: ["session", "auth"], excluded: [] }),
      ],
      replacementFormat: "simple",
    });

    const result = headersHandler.process(
      {
        "set-cookie": [
          "session=secret1; Path=/; HttpOnly",
          "auth=secret2; Path=/api; Secure",
          "theme=dark; Path=/",
        ],
      },
      { scopeId: "test", scopeName: "Test" },
      engine,
    );

    const val = result.value as Record<string, unknown>;
    const cookies = val["set-cookie"] as string[];
    expect(cookies.length).toBe(3);

    // All three Set-Cookie values masked, attributes preserved (GLU-104:
    // a minted cookie is credential material regardless of its name).
    expect(cookies[0]).toContain("Path=/");
    expect(cookies[0]).toContain("HttpOnly");
    expect(cookies[0]).not.toContain("secret1");

    expect(cookies[1]).toContain("Path=/api");
    expect(cookies[1]).toContain("Secure");
    expect(cookies[1]).not.toContain("secret2");

    // Even the opaquely-named "theme" cookie value is masked now; the name
    // and attributes are preserved.
    expect(cookies[2]).toContain("theme=");
    expect(cookies[2]).toContain("Path=/");
    expect(cookies[2]).not.toContain("dark");
  });

  test("$self accessor writes back to event", () => {
    const compiled = compileScopes({
      builtinScopes: [{
        id: "assertion.self",
        name: "Assertion self",
        event: "assertion",
        target: "$self",
        handler: "json",
        rules: { sensitiveKeys: ["secret"] },
      }],
      globalRules: { sensitiveKeys: [], patterns: [], customPatterns: [] },
      replacementFormat: "simple",
    });

    const event = {
      type: "assertion",
      message: "check passed",
      secret: "hidden-value",
      expected: "foo",
    };

    const result = redactEvent(event, compiled, "simple");
    expect(result.secret).toBe("[REDACTED]");
    expect(result.message).toBe("check passed");
    expect(result.expected).toBe("foo");
  });
});

// =============================================================================
// redactValue — deep redaction of non-event payloads (metadata projection)
// =============================================================================

describe("redactValue", () => {
  test("redacts nested sensitive keys anywhere in the tree", () => {
    const projection = {
      id: "POST /login",
      cases: {
        success: {
          schemas: {
            request: { headers: { authorization: "Bearer super-secret-token" } },
          },
        },
      },
    };

    const result = redactValue(projection, {
      globalRules: { sensitiveKeys: ["authorization"], patterns: [], customPatterns: [] },
      replacementFormat: "simple",
    }) as typeof projection;

    expect(result.cases.success.schemas.request.headers.authorization).toBe("[REDACTED]");
    // Structural / non-sensitive fields survive verbatim.
    expect(result.id).toBe("POST /login");
  });

  test("preserves JSON-Schema structure under sensitive property names", () => {
    // A request-body schema whose properties are named like secrets
    // (`password`, `token`, `authorization`) must keep its shape — the
    // property name is structural, not a secret value. Whereas a real scalar
    // secret under a sensitive key (a default header) IS masked.
    const projection = {
      schemas: {
        request: {
          body: {
            type: "object",
            properties: {
              password: { type: "string", minLength: 8 },
              token: { type: "string" },
            },
            required: ["password"],
          },
          headers: { authorization: "Bearer real-default-token" },
        },
      },
    };

    const result = redactValue(projection, {
      globalRules: { sensitiveKeys: [], patterns: ["bearer"], customPatterns: [] },
      replacementFormat: "simple",
    }) as typeof projection;

    // Schema nodes survive intact (not flattened to "[REDACTED]").
    expect(result.schemas.request.body.properties.password).toEqual({
      type: "string",
      minLength: 8,
    });
    expect(result.schemas.request.body.properties.token).toEqual({ type: "string" });
    expect(result.schemas.request.body.required).toEqual(["password"]);
    // The real scalar default header secret IS masked.
    expect(result.schemas.request.headers.authorization).toBe("[REDACTED]");
  });

  // GLU-123 codex round: a JSON-Schema BOOLEAN node (`properties.password:
  // true` — valid JSON Schema meaning "any value accepted") under a
  // sensitive property name must survive as a boolean, not get flattened to
  // a redaction STRING. Same "preserve schema shape" contract as the object
  // case above, just for the boolean-schema shorthand. A boolean also
  // carries no real secret entropy, so leaving it alone costs nothing
  // security-wise.
  test("preserves boolean JSON-Schema nodes under sensitive property names", () => {
    const projection = {
      schemas: {
        request: {
          body: {
            type: "object",
            properties: {
              password: true, // "any value accepted" — a valid schema node
              cookie: false, // "no value accepted"
              name: { type: "string" },
            },
          },
        },
      },
    };

    const result = redactValue(projection, {
      globalRules: { sensitiveKeys: [], patterns: [], customPatterns: [] },
      replacementFormat: "partial",
    }) as typeof projection;

    expect(result.schemas.request.body.properties.password).toBe(true);
    expect(result.schemas.request.body.properties.cookie).toBe(false);
    expect(result.schemas.request.body.properties.name).toEqual({ type: "string" });
  });

  // GLU-123: the direct leak this fix closes — a scalar SECRET VALUE (not a
  // schema node) directly under a sensitive key must still be masked, string
  // or otherwise. Guards the boolean exemption above from over-reaching.
  test("still masks a real scalar secret directly under a sensitive key (not a schema context)", () => {
    const projection = {
      extensions: {
        cookie: "sessid=REAL_SECRET_VALUE_abc123",
        "set-cookie": "sessid=REAL_SECRET_VALUE_abc123; HttpOnly",
      },
    };

    const result = redactValue(projection, {
      globalRules: { sensitiveKeys: ["cookie", "set-cookie"], patterns: [], customPatterns: [] },
      replacementFormat: "partial",
    }) as typeof projection;

    expect(result.extensions.cookie).not.toBe("sessid=REAL_SECRET_VALUE_abc123");
    expect(result.extensions["set-cookie"]).not.toContain("REAL_SECRET_VALUE_abc123");
  });

  test("masks array-valued sensitive keys element-wise (codex 0.6 P1)", () => {
    // Multi-value headers/cookies arrive as ARRAYS under a sensitive key. Each
    // element is values-of-the-secret and must be masked, even when it matches
    // no value pattern — array elements are visited under "0"/"1", which no
    // plugin sees as sensitive, so a naive recurse would leak them.
    const projection = {
      schemas: {
        request: {
          headers: {
            // pattern-miss scalar values — only key-sensitivity can catch them
            authorization: ["dev-token", "ci-token"],
            "set-cookie": ["sid=abc", "csrf=xyz"],
          },
        },
      },
      // A non-sensitive structural array must NOT be masked (regression guard).
      required: ["password", "token"],
    };

    const result = redactValue(projection, {
      globalRules: {
        sensitiveKeys: ["authorization", "set-cookie"],
        patterns: [],
        customPatterns: [],
      },
      replacementFormat: "simple",
    }) as any;

    // Every element of the sensitive arrays is masked, array shape preserved.
    expect(result.schemas.request.headers.authorization).toEqual(["[REDACTED]", "[REDACTED]"]);
    expect(result.schemas.request.headers["set-cookie"]).toEqual(["[REDACTED]", "[REDACTED]"]);
    // Structural field-name array (under non-sensitive `required`) survives.
    expect(result.required).toEqual(["password", "token"]);
  });

  test("masks nested array-of-arrays under a sensitive key (codex 0.6 P1)", () => {
    const projection = { authorization: [["a", "b"], ["c"]] };
    const result = redactValue(projection, {
      globalRules: { sensitiveKeys: ["authorization"], patterns: [], customPatterns: [] },
      replacementFormat: "simple",
    }) as any;
    expect(result.authorization).toEqual([["[REDACTED]", "[REDACTED]"], ["[REDACTED]"]]);
  });

  test("masks array-valued secrets under ANY sensitive key, not just a header list (codex 0.6 P1)", () => {
    // The allow-list approach leaked sensitive headers it didn't enumerate
    // (e.g. `x-api-key`). Masking is now the secure default for any sensitive
    // key's array — built-in header keys included — so nothing slips through.
    const projection = {
      headers: { "x-api-key": ["dev-key", "ci-key"] }, // built-in sensitive header
      creds: { token: ["t1", "t2"] }, // non-header sensitive key, still masked
    };
    const result = redactValue(projection, {
      // empty globalRules.sensitiveKeys → rely on the built-in baseline, which
      // includes x-api-key + token.
      globalRules: { sensitiveKeys: [], patterns: [], customPatterns: [] },
      replacementFormat: "simple",
    }) as any;
    expect(result.headers["x-api-key"]).toEqual(["[REDACTED]", "[REDACTED]"]);
    expect(result.creds.token).toEqual(["[REDACTED]", "[REDACTED]"]);
  });

  test("preserves schema keyword arrays under sensitive property names (codex 0.6 P2)", () => {
    // `dependentRequired: { password: ["mfaCode"] }` — `password` is a
    // sensitive NAME, but the array is a structural list of property names,
    // NOT secret values. Arrays under a sensitive key are masked by default;
    // a `dependentRequired` parent exempts this structural array so it survives.
    const projection = {
      schemas: {
        request: {
          body: {
            type: "object",
            properties: { password: { type: "string" }, mfaCode: { type: "string" } },
            dependentRequired: { password: ["mfaCode"] },
          },
        },
      },
    };
    const result = redactValue(projection, {
      globalRules: { sensitiveKeys: ["password"], patterns: [], customPatterns: [] },
      replacementFormat: "simple",
    }) as any;
    // The structural array under the sensitive-named `password` key is intact.
    expect(result.schemas.request.body.dependentRequired.password).toEqual(["mfaCode"]);
    // And the schema node under `properties.password` keeps its shape.
    expect(result.schemas.request.body.properties.password).toEqual({ type: "string" });
  });

  test("redacts pattern matches deep inside arrays (examples)", () => {
    const projection = {
      examples: [
        { value: { email: "alice@example.com" }, summary: "happy path" },
      ],
    };

    const result = redactValue(projection, {
      globalRules: { sensitiveKeys: [], patterns: ["email"], customPatterns: [] },
      replacementFormat: "simple",
    }) as { examples: Array<{ value: { email: string }; summary: string }> };

    expect(result.examples[0].value.email).not.toContain("alice@example.com");
    expect(result.examples[0].summary).toBe("happy path");
  });

  test("preserves array order (canonical-hash relies on example/tuple order)", () => {
    const projection = { prefixItems: ["a", "b", "c"], required: ["x", "y"] };

    const result = redactValue(projection, {
      globalRules: { sensitiveKeys: [], patterns: ["email"], customPatterns: [] },
      replacementFormat: "simple",
    }) as { prefixItems: string[]; required: string[] };

    expect(result.prefixItems).toEqual(["a", "b", "c"]);
    expect(result.required).toEqual(["x", "y"]);
  });

  test("applies the built-in sensitive-key baseline by default (no global keys needed)", () => {
    // Default config: globalRules.sensitiveKeys is empty — built-in keys live
    // in event scopes, which this non-event path can't see. redactValue opts
    // into the built-in baseline so key-based secrets are still masked even
    // when the value matches no value-pattern.
    const projection = {
      request: { headers: { authorization: "sk_live_no_pattern_match" } },
      body: { password: "hunter2" },
    };
    const result = redactValue(projection, {
      globalRules: { sensitiveKeys: [], patterns: [], customPatterns: [] },
      replacementFormat: "simple",
    }) as { request: { headers: { authorization: string } }; body: { password: string } };
    expect(result.request.headers.authorization).toBe("[REDACTED]");
    expect(result.body.password).toBe("[REDACTED]");
  });

  test("useBuiltInSensitiveKeys:false with empty rules is a no-op", () => {
    const projection = { token: "still-here", note: "alice@example.com" };
    const result = redactValue(projection, {
      globalRules: { sensitiveKeys: [], patterns: [], customPatterns: [] },
      useBuiltInSensitiveKeys: false,
    });
    // No plugins → identical reference (cheap no-op).
    expect(result).toBe(projection);
  });

  test("does not mutate the input", () => {
    const projection = { auth: { token: "secret-value" } };
    const snapshot = JSON.parse(JSON.stringify(projection));
    redactValue(projection, {
      globalRules: { sensitiveKeys: ["token"], patterns: [], customPatterns: [] },
      replacementFormat: "simple",
    });
    expect(projection).toEqual(snapshot);
  });

  test("high maxDepth preserves deeply-nested structure (no too-deep sentinel)", () => {
    // Build a 20-level-deep nested object — beyond the engine's default
    // maxDepth of 10. Without a generous maxDepth the leaf would collapse to
    // "[REDACTED: too deep]"; the metadata projection must survive intact.
    let node: Record<string, unknown> = { leaf: "value" };
    for (let i = 0; i < 20; i++) node = { nested: node };

    const result = redactValue(node, {
      globalRules: { sensitiveKeys: ["nonexistent"], patterns: [], customPatterns: [] },
      replacementFormat: "simple",
      maxDepth: 64,
    });

    // Walk back down — leaf must be intact.
    let cursor: any = result;
    for (let i = 0; i < 20; i++) cursor = cursor.nested;
    expect(cursor.leaf).toBe("value");
  });
});
