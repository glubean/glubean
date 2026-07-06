/**
 * Tests for the contract.browser judgment matchers (proposal §3.1). Pure
 * functions — no live browser. The load-bearing coverage is `matchCalls` (the
 * killer feature: method + normalized path template + status + atLeastOnce +
 * best-effort schema).
 */

import { describe, expect, test } from "vitest";
import type { ContractCaseRef } from "@glubean/sdk";
import {
  describeLocator,
  matchCalls,
  matchConsole,
  matchUrl,
  parseHttpEndpoint,
  pathTemplateToRegExp,
  pathnameOf,
  resolveLocator,
} from "./matchers.js";
import type { BrowserTraceRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface SchemaStub {
  safeParse: (v: unknown) => { success: boolean };
}

function makeHttpRef(opts: {
  endpoint: string;
  caseKey?: string;
  status?: number;
  schema?: SchemaStub;
  contractId?: string;
}): ContractCaseRef<unknown, unknown> {
  const caseKey = opts.caseKey ?? "ok";
  return {
    __glubean_type: "contract-case-ref",
    contractId: opts.contractId ?? "auth.sign-in.email",
    caseKey,
    protocol: "http",
    target: opts.endpoint,
    contract: {
      _spec: {
        endpoint: opts.endpoint,
        cases: { [caseKey]: { expect: { status: opts.status, schema: opts.schema } } },
      },
    },
  } as unknown as ContractCaseRef<unknown, unknown>;
}

function trace(p: Partial<BrowserTraceRecord> & { method: string; url: string; status: number }): BrowserTraceRecord {
  return { durationMs: 10, ...p };
}

// ---------------------------------------------------------------------------
// parseHttpEndpoint / pathTemplateToRegExp / pathnameOf
// ---------------------------------------------------------------------------

describe("parseHttpEndpoint", () => {
  test("splits method + path", () => {
    expect(parseHttpEndpoint("POST /api/auth/sign-in/email")).toEqual({
      method: "POST",
      path: "/api/auth/sign-in/email",
    });
  });
  test("defaults to GET when no method prefix", () => {
    expect(parseHttpEndpoint("/health")).toEqual({ method: "GET", path: "/health" });
  });
  test("uppercases method", () => {
    expect(parseHttpEndpoint("get /x").method).toBe("GET");
  });
});

describe("pathTemplateToRegExp", () => {
  test("matches an exact path", () => {
    const re = pathTemplateToRegExp("/api/auth/sign-in/email");
    expect(re.test("/api/auth/sign-in/email")).toBe(true);
    expect(re.test("/api/auth/sign-in/sms")).toBe(false);
  });
  test("normalizes :param segments to wildcards", () => {
    const re = pathTemplateToRegExp("/projects/:projectId/targets");
    expect(re.test("/projects/proj_default_ABC123/targets")).toBe(true);
    expect(re.test("/projects/abc/def/targets")).toBe(false); // slash is a boundary
    expect(re.test("/projects//targets")).toBe(false);
  });
  test("tolerates a trailing slash", () => {
    expect(pathTemplateToRegExp("/x/y").test("/x/y/")).toBe(true);
  });
});

describe("pathnameOf", () => {
  test("strips host and query", () => {
    expect(pathnameOf("https://api.staging.glubean.com/api/x?includeArchived=true")).toBe("/api/x");
  });
});

// ---------------------------------------------------------------------------
// matchCalls — the killer feature (§3.1 minimal reliable subset)
// ---------------------------------------------------------------------------

describe("matchCalls", () => {
  test("matches method + path template + status (host & query ignored)", () => {
    const ref = makeHttpRef({ endpoint: "POST /api/auth/sign-in/email", status: 200 });
    const traces = [
      trace({ method: "GET", url: "https://app.staging.glubean.com/", status: 200 }),
      trace({ method: "POST", url: "https://api.staging.glubean.com/api/auth/sign-in/email?x=1", status: 200 }),
    ];
    const r = matchCalls(ref, traces);
    expect(r.matched).toBe(true);
    expect(r.schema).toBe("not-applicable");
    expect(r.route).toBe("POST /api/auth/sign-in/email");
  });

  test("no matching route → not matched", () => {
    const ref = makeHttpRef({ endpoint: "POST /api/auth/sign-in/email", status: 200 });
    const r = matchCalls(ref, [trace({ method: "GET", url: "https://x/health", status: 200 })]);
    expect(r.matched).toBe(false);
    expect(r.detail).toContain("no POST /api/auth/sign-in/email");
  });

  test("route hit but wrong status → not matched, reports observed status", () => {
    const ref = makeHttpRef({ endpoint: "POST /api/auth/sign-in/email", status: 200 });
    const r = matchCalls(ref, [
      trace({ method: "POST", url: "https://api/api/auth/sign-in/email", status: 401 }),
    ]);
    expect(r.matched).toBe(false);
    expect(r.detail).toContain("401");
  });

  test("method must match strictly", () => {
    const ref = makeHttpRef({ endpoint: "POST /api/x", status: 200 });
    const r = matchCalls(ref, [trace({ method: "GET", url: "https://h/api/x", status: 200 })]);
    expect(r.matched).toBe(false);
  });

  test("atLeastOnce: one satisfying call among many is a hit", () => {
    const ref = makeHttpRef({ endpoint: "GET /api/x", status: 200 });
    const r = matchCalls(ref, [
      trace({ method: "GET", url: "https://h/api/x", status: 500 }),
      trace({ method: "GET", url: "https://h/api/x", status: 200 }),
    ]);
    expect(r.matched).toBe(true);
  });

  test("schema verified when body available and valid", () => {
    const ref = makeHttpRef({
      endpoint: "POST /api/x",
      status: 200,
      schema: { safeParse: () => ({ success: true }) },
    });
    const r = matchCalls(ref, [
      trace({ method: "POST", url: "https://h/api/x", status: 200, responseBody: { ok: true } }),
    ]);
    expect(r.matched).toBe(true);
    expect(r.schema).toBe("verified");
  });

  test("schema unverified (matched, NOT fail) when body unavailable", () => {
    const ref = makeHttpRef({
      endpoint: "POST /api/x",
      status: 200,
      schema: { safeParse: () => ({ success: true }) },
    });
    const r = matchCalls(ref, [trace({ method: "POST", url: "https://h/api/x", status: 200 })]);
    expect(r.matched).toBe(true);
    expect(r.schema).toBe("unverified");
  });

  test("schema mismatch → not matched", () => {
    const ref = makeHttpRef({
      endpoint: "POST /api/x",
      status: 200,
      schema: { safeParse: () => ({ success: false }) },
    });
    const r = matchCalls(ref, [
      trace({ method: "POST", url: "https://h/api/x", status: 200, responseBody: { bad: 1 } }),
    ]);
    expect(r.matched).toBe(false);
    expect(r.schema).toBe("mismatch");
  });

  test("non-HTTP / unresolvable ref → not matched, not-applicable", () => {
    const ref = {
      __glubean_type: "contract-case-ref",
      contractId: "x",
      caseKey: "ok",
      protocol: "grpc",
      target: "x",
      contract: { _spec: {} },
    } as unknown as ContractCaseRef<unknown, unknown>;
    const r = matchCalls(ref, []);
    expect(r.matched).toBe(false);
    expect(r.schema).toBe("not-applicable");
  });
});

// ---------------------------------------------------------------------------
// matchUrl
// ---------------------------------------------------------------------------

describe("matchUrl", () => {
  test("path set (allowed terminal paths)", () => {
    expect(matchUrl({ path: ["/", "/dashboard"] }, "https://app.staging.glubean.com/").ok).toBe(true);
    expect(matchUrl({ path: ["/", "/dashboard"] }, "https://app.staging.glubean.com/dashboard").ok).toBe(true);
    expect(matchUrl({ path: ["/", "/dashboard"] }, "https://app.staging.glubean.com/login").ok).toBe(false);
  });
  test("single path string", () => {
    expect(matchUrl({ path: "/dashboard" }, "https://h/dashboard").ok).toBe(true);
  });
  test("pattern (regex against full url)", () => {
    expect(matchUrl({ pattern: "^https://app\\.staging\\." }, "https://app.staging.glubean.com/x").ok).toBe(true);
    expect(matchUrl({ pattern: "^https://app\\.staging\\." }, "https://other.com/x").ok).toBe(false);
  });
  test("notPath forbids a terminal path", () => {
    expect(matchUrl({ notPath: "/login" }, "https://h/login").ok).toBe(false);
    expect(matchUrl({ notPath: "/login" }, "https://h/dashboard").ok).toBe(true);
  });
  test("notPath checked before path when both present", () => {
    expect(matchUrl({ path: ["/login"], notPath: ["/login"] }, "https://h/login").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// matchConsole
// ---------------------------------------------------------------------------

describe("matchConsole", () => {
  test("passes with zero errors", () => {
    expect(matchConsole({ errors: 0 }, []).ok).toBe(true);
  });
  test("fails on a product-domain error", () => {
    const r = matchConsole({ errors: 0 }, [
      { message: "Failed to load resource: 404", source: "https://api.staging.glubean.com/projects/x/targets" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.counted).toHaveLength(1);
  });
  test("allow-substring marks an error as noise (excluded)", () => {
    const r = matchConsole({ errors: 0, allow: ["favicon"] }, [
      { message: "Failed to load resource: 404", source: "https://app/favicon.ico" },
    ]);
    expect(r.ok).toBe(true);
    expect(r.noise).toHaveLength(1);
    expect(r.counted).toHaveLength(0);
  });
  test("allow matches message OR source", () => {
    const r = matchConsole({ errors: 0, allow: ["third-party-widget"] }, [
      { message: "third-party-widget failed", source: "https://cdn.other.com/w.js" },
    ]);
    expect(r.ok).toBe(true);
  });
  test("errors > allowed count fails", () => {
    const r = matchConsole({ errors: 1 }, [
      { message: "e1", source: "https://app/x" },
      { message: "e2", source: "https://app/y" },
    ]);
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveLocator / describeLocator
// ---------------------------------------------------------------------------

describe("resolveLocator", () => {
  test("role wins, with name", () => {
    expect(resolveLocator({ role: "heading", name: "Welcome back, Peisong" })).toEqual({
      kind: "role",
      role: "heading",
      name: "Welcome back, Peisong",
    });
  });
  test("testId / text / label / selector", () => {
    expect(resolveLocator({ testId: "x" }).kind).toBe("testId");
    expect(resolveLocator({ text: "hi" }).kind).toBe("text");
    expect(resolveLocator({ label: "Email" }).kind).toBe("label");
    expect(resolveLocator({ selector: ".x" }).kind).toBe("selector");
  });
  test("throws when nothing is set", () => {
    expect(() => resolveLocator({})).toThrow(/one of/);
  });
});

describe("describeLocator", () => {
  test("role with name", () => {
    expect(describeLocator({ role: "heading", name: "Welcome" })).toBe('role=heading[name="Welcome"]');
  });
});
