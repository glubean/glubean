/**
 * contract.browser judgment matchers (proposal contract-browser-two-tier.md
 * §3.1). Pure functions over the frozen evidence bundle so they can be unit
 * tested without a live browser — the adapter wires their results into
 * `ctx.assert` for authoritative Mode A judging.
 *
 * The load-bearing one is `matchCalls`: the "killer feature" that asserts a
 * browser journey triggered a specific `contract.http` case. Per §3.1 the P1
 * scope is the **minimal reliable subset**:
 *
 *   - route identity  = referenced contract's `endpoint` (method + path
 *     template); path params normalized to wildcards; query NOT part of
 *     identity; host NOT part of identity (a browser app on app.* legitimately
 *     calls an API on api.*).
 *   - method          = strict equal
 *   - status          = equal to the referenced case's `expect.status`
 *   - repetition      = atLeastOnce (a single satisfying call is a hit)
 *   - schema          = when the response body is available (JSON, <64KB, not
 *     base64) AND the referenced case declares `expect.schema`, validate it;
 *     otherwise degrade to `status-only` and mark `schema: "unverified"` — a
 *     visible debt, NOT a fail.
 *
 * Deferred (NOT this subset): complex query matching, `times`, retry policy,
 * body-diff UI.
 */

import type { ContractCaseRef } from "@glubean/sdk";
import type {
  BrowserConsoleError,
  BrowserLocatorSpec,
  BrowserTraceRecord,
  ConsoleExpect,
  UrlExpect,
} from "./types.js";

// =============================================================================
// HTTP endpoint parsing / path templates
// =============================================================================

/**
 * Parse an HTTP contract `endpoint` string (`"POST /api/x/:id"`) into method +
 * path template. Mirrors the SDK HTTP adapter's `parseEndpoint`: a leading
 * `METHOD ` prefix is optional (defaults to GET).
 */
export function parseHttpEndpoint(endpoint: string): { method: string; path: string } {
  const spaceIdx = endpoint.indexOf(" ");
  if (spaceIdx === -1) return { method: "GET", path: endpoint };
  return {
    method: endpoint.slice(0, spaceIdx).toUpperCase(),
    path: endpoint.slice(spaceIdx + 1),
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convert an HTTP path template to an anchored RegExp. `:param` segments (the
 * SDK's placeholder syntax — see `resolveParams`) match any single non-slash
 * segment. A trailing slash on the observed path is tolerated.
 */
export function pathTemplateToRegExp(template: string): RegExp {
  // Normalize a leading slash: HTTP endpoints may be authored without one
  // (`GET api/users/:id`), but observed request pathnames always carry it.
  const withSlash = template.startsWith("/") ? template : `/${template}`;
  const normalized = withSlash.replace(/\/+$/, "") || "/";
  const body = normalized
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/]+" : escapeRegExp(seg)))
    .join("/");
  return new RegExp(`^${body}/?$`);
}

/** Extract the pathname from an observed request URL (host + query stripped). */
export function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    // Relative or malformed — strip query/hash and use as-is.
    const q = url.search?.length ? url : url.split(/[?#]/, 1)[0];
    return q;
  }
}

// =============================================================================
// calls matcher (§3.1 minimal reliable subset)
// =============================================================================

/** Outcome of matching one `expect.calls` reference against the trace. */
export interface CallsMatchResult {
  /** True iff at least one traced request matched method + path + status. */
  matched: boolean;
  /** Schema verification outcome for the matched call. */
  schema: "verified" | "unverified" | "mismatch" | "not-applicable";
  /** Human-readable evidence (method + url + status — never a body). */
  detail: string;
  /** The referenced route, for diagnostics: "METHOD /path/template". */
  route: string;
}

/** Minimal SchemaLike surface used for standalone validation. */
interface SchemaLikeLoose {
  safeParse?: (v: unknown) => { success: boolean; error?: unknown };
  parse?: (v: unknown) => unknown;
}

/** Validate `value` against a SchemaLike without a TestContext. */
function schemaAccepts(schema: SchemaLikeLoose, value: unknown): boolean {
  if (typeof schema.safeParse === "function") {
    try {
      return schema.safeParse(value).success === true;
    } catch {
      return false;
    }
  }
  if (typeof schema.parse === "function") {
    try {
      schema.parse(value);
      return true;
    } catch {
      return false;
    }
  }
  // No usable validator — treat as unverifiable (caller degrades to unverified).
  return true;
}

/**
 * Read `{ method, path, status, schema }` from a referenced contract.http
 * case. Returns null when the ref does not resolve to a runnable *outbound*
 * HTTP case: no endpoint, an unknown `caseKey` (typo), or an inbound case with
 * no `expect.status`. Rejecting here is what stops a broken ref from silently
 * matching any observed request to the endpoint.
 */
function readReferencedRoute(ref: ContractCaseRef<unknown, unknown>): {
  method: string;
  pathTemplate: string;
  status: number;
  schema: SchemaLikeLoose | undefined;
} | null {
  const spec = ref.contract?._spec as
    | { endpoint?: string; cases?: Record<string, unknown> }
    | undefined;
  if (!spec || typeof spec.endpoint !== "string") return null;
  const { method, path } = parseHttpEndpoint(spec.endpoint);
  const caseSpec = spec.cases?.[ref.caseKey] as
    | { expect?: { status?: number; schema?: SchemaLikeLoose } }
    | undefined;
  // A valid outbound HTTP case always declares a numeric expect.status.
  if (!caseSpec || typeof caseSpec.expect?.status !== "number") return null;
  return {
    method,
    pathTemplate: path,
    status: caseSpec.expect.status,
    schema: caseSpec.expect.schema,
  };
}

/**
 * Match an `expect.calls` reference against the observed network trace.
 *
 * Returns a structured result; the adapter turns `matched` into an authoritative
 * `ctx.assert`. A `schema: "unverified"` result is NOT a failure — it means the
 * route + status matched but the body could not be validated (body unavailable,
 * or the referenced case declared no schema).
 */
export function matchCalls(
  ref: ContractCaseRef<unknown, unknown>,
  traces: readonly BrowserTraceRecord[],
): CallsMatchResult {
  const referenced = readReferencedRoute(ref);
  if (!referenced) {
    // Broken ref (unknown caseKey / not an outbound HTTP case / no endpoint):
    // fail loudly rather than silently matching any request to the endpoint.
    return {
      matched: false,
      schema: "not-applicable",
      detail: `calls ref "${ref.contractId}#${ref.caseKey}" does not resolve to an outbound HTTP case (unknown case key, inbound case, or missing endpoint/status)`,
      route: `${ref.protocol}:${ref.contractId}#${ref.caseKey}`,
    };
  }

  const { method, pathTemplate, status, schema } = referenced;
  const route = `${method} ${pathTemplate}`;
  const pathRe = pathTemplateToRegExp(pathTemplate);

  // Candidates: method + path template match (query & host ignored per §3.1).
  const routeHits = traces.filter(
    (t) => t.method.toUpperCase() === method && pathRe.test(pathnameOf(t.url)),
  );
  if (routeHits.length === 0) {
    return {
      matched: false,
      schema: "not-applicable",
      detail: `no ${route} request observed during the journey`,
      route,
    };
  }

  // atLeastOnce on status: any route hit with the expected status satisfies.
  const statusHits = routeHits.filter((t) => t.status === status);
  if (statusHits.length === 0) {
    const got = [...new Set(routeHits.map((t) => t.status))].join(", ");
    return {
      matched: false,
      schema: "not-applicable",
      detail: `${route} observed but status ${status} not seen (got ${got})`,
      route,
    };
  }

  const hit = statusHits[0];
  const statusPart = `${hit.method} ${pathnameOf(hit.url)} → ${hit.status}`;

  // Schema check (best-effort; body absent → unverified, NOT fail).
  if (!schema) {
    return { matched: true, schema: "not-applicable", detail: statusPart, route };
  }
  // atLeastOnce also applies to the body: check EVERY matching call's body —
  // if any one satisfies the schema, the contract holds (a broken retry
  // followed by a good call must not fail).
  const bodies = statusHits.filter((t) => t.responseBody !== undefined);
  if (bodies.length === 0) {
    return {
      matched: true,
      schema: "unverified",
      detail: `${statusPart} (response body unavailable — schema unverified)`,
      route,
    };
  }
  if (bodies.some((t) => schemaAccepts(schema, t.responseBody))) {
    return { matched: true, schema: "verified", detail: `${statusPart} (body matches schema)`, route };
  }
  return {
    matched: false,
    schema: "mismatch",
    detail: `${statusPart} but no matching call's response body satisfied the referenced case schema`,
    route,
  };
}

// =============================================================================
// url matcher
// =============================================================================

/** Outcome of a url expectation check. */
export interface UrlMatchResult {
  ok: boolean;
  detail: string;
}

/**
 * Judge a `url` expectation against the terminal URL. Pure — the adapter reads
 * `page.url()` and passes it here.
 */
export function matchUrl(expect: UrlExpect, finalUrl: string): UrlMatchResult {
  let pathname = finalUrl;
  try {
    pathname = new URL(finalUrl).pathname || "/";
  } catch {
    /* leave finalUrl as-is for relative inputs */
  }

  // notPath is a universal forbidden-path guard — enforce it FIRST, even when
  // `pattern` or `path` is also declared (a regex host/prefix match must not
  // let an explicitly-forbidden path through).
  if (expect.notPath !== undefined) {
    const forbidden = Array.isArray(expect.notPath) ? expect.notPath : [expect.notPath];
    if (forbidden.includes(pathname)) {
      return { ok: false, detail: `terminal path ${pathname} is forbidden (notPath)` };
    }
  }

  if (expect.pattern !== undefined) {
    const re = new RegExp(expect.pattern);
    const ok = re.test(finalUrl);
    return { ok, detail: `final url ${finalUrl} ${ok ? "matches" : "does not match"} /${expect.pattern}/` };
  }

  if (expect.path !== undefined) {
    const allowed = Array.isArray(expect.path) ? expect.path : [expect.path];
    const ok = allowed.includes(pathname);
    return {
      ok,
      detail: ok
        ? `terminal path ${pathname} ∈ {${allowed.join(", ")}}`
        : `terminal path ${pathname} ∉ {${allowed.join(", ")}}`,
    };
  }

  // Only notPath was specified and it passed the forbidden-path guard above.
  if (expect.notPath !== undefined) {
    return { ok: true, detail: `terminal path ${pathname} is not forbidden` };
  }

  return { ok: false, detail: "url expectation declared no path/pattern/notPath" };
}

// =============================================================================
// console matcher
// =============================================================================

/** Outcome of a console expectation check. */
export interface ConsoleMatchResult {
  ok: boolean;
  detail: string;
  /** Errors counted as real (not noise). */
  counted: BrowserConsoleError[];
  /** Errors excluded as third-party / resource noise. */
  noise: BrowserConsoleError[];
}

/**
 * Judge a `console` expectation. Errors whose message OR source URL contains
 * any `allow` substring are treated as noise (excluded); the rest count.
 * (proposal RESULT.md #3 — product-domain errors count; resource / third-party
 * are noise. The author encodes the noise boundary via `allow`.)
 */
export function matchConsole(
  expect: ConsoleExpect,
  errors: readonly BrowserConsoleError[],
): ConsoleMatchResult {
  const allow = expect.allow ?? [];
  const isNoise = (e: BrowserConsoleError): boolean =>
    allow.some((frag) => e.message.includes(frag) || (e.source ?? "").includes(frag));

  const noise = errors.filter(isNoise);
  const counted = errors.filter((e) => !isNoise(e));
  const max = expect.errors ?? 0;
  const ok = counted.length <= max;
  return {
    ok,
    counted,
    noise,
    detail: ok
      ? `${counted.length} product console error(s) ≤ ${max} allowed` +
        (noise.length ? `; ${noise.length} noise excluded` : "")
      : `${counted.length} product console error(s) > ${max} allowed: ` +
        counted.map((e) => e.message).slice(0, 3).join(" | "),
  };
}

// =============================================================================
// dom locator → selector (used by the adapter's live-page checks)
// =============================================================================

/**
 * Resolve a `BrowserLocatorSpec` to the page-locator call the adapter should
 * make. Returns a discriminated hint the adapter maps onto
 * `page.byRole/byText/byLabel/byTestId/locator`. Kept here (not the adapter)
 * so the "exactly one strategy" rule is unit-testable.
 */
export function resolveLocator(spec: BrowserLocatorSpec):
  | { kind: "role"; role: string; name?: string }
  | { kind: "text"; text: string }
  | { kind: "label"; label: string }
  | { kind: "testId"; testId: string }
  | { kind: "selector"; selector: string } {
  if (spec.role !== undefined) return { kind: "role", role: spec.role, name: spec.name };
  if (spec.testId !== undefined) return { kind: "testId", testId: spec.testId };
  if (spec.label !== undefined) return { kind: "label", label: spec.label };
  if (spec.text !== undefined) return { kind: "text", text: spec.text };
  if (spec.selector !== undefined) return { kind: "selector", selector: spec.selector };
  throw new Error(
    "BrowserLocatorSpec must set one of: role / testId / label / text / selector",
  );
}

/** A short human label for a locator (for assertion messages). */
export function describeLocator(spec: BrowserLocatorSpec): string {
  const r = resolveLocator(spec);
  switch (r.kind) {
    case "role":
      return r.name ? `role=${r.role}[name="${r.name}"]` : `role=${r.role}`;
    case "text":
      return `text="${r.text}"`;
    case "label":
      return `label="${r.label}"`;
    case "testId":
      return `testId="${r.testId}"`;
    case "selector":
      return `selector="${r.selector}"`;
  }
}
