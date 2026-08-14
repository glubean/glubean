/**
 * @module contract-http/example-check
 *
 * Build-time drift check between hand-written examples and the schemas they
 * sit beside (issue #31).
 *
 * `request.example` / `request.examples` and a case's `expect.example` /
 * `expect.examples` are documentation-only: nothing validates them at run time,
 * so they rot silently as the schema evolves and the OpenAPI/Markdown
 * projections keep publishing a payload the API would reject.
 *
 * This module runs once per contract construction (called from the HTTP
 * adapter's `normalize`) and emits ONE `console.warn` per drifting site. It is
 * strictly advisory:
 *
 * - never throws (a schema that misbehaves is silently skipped),
 * - never touches the projection output, `canonicalHash` inputs, or execution,
 * - never warns twice for the same `id` + site path, even if the module is
 *   re-imported and the contract re-constructed.
 *
 * HTTP only for now — GraphQL / gRPC examples are out of scope.
 */

import type { ContractProjection } from "../contract-types.js";
import type { SchemaLike } from "../types.js";
import type {
  ContractExample,
  HttpContractMeta,
  HttpPayloadSchemas,
} from "./types.js";

/** Sites already warned about, keyed by `contractId` + site path. */
const warnedSites = new Set<string>();

/** Max issues quoted in a warning before it collapses to "(+N more)". */
const MAX_QUOTED_ISSUES = 3;

/** Max characters of a thrown-error message quoted in a warning. */
const MAX_MESSAGE_CHARS = 200;

/**
 * Clear the "already warned" guard. Test-only — production code constructs a
 * contract once per process, so the guard is never reset at run time.
 * @internal
 */
export function __resetExampleWarningsForTesting(): void {
  warnedSites.clear();
}

type ExampleCheck =
  /** Example parsed cleanly, or there was nothing checkable here. */
  | { status: "ok" }
  /** Example is present and the schema rejected it. */
  | { status: "mismatch"; summary: string };

interface SchemaIssueLike {
  message?: string;
  path?: ReadonlyArray<PropertyKey>;
}

function summarizeIssues(issues: ReadonlyArray<SchemaIssueLike>): string {
  const quoted = issues.slice(0, MAX_QUOTED_ISSUES).map((issue) => {
    // `Array#join` throws a TypeError on a symbol segment (a schema keyed by a
    // symbol property reports one). The outer catch would swallow that and the
    // drift warning would vanish — stringify each segment first.
    const path =
      issue.path && issue.path.length > 0
        ? `${issue.path.map((segment) => String(segment)).join(".")}: `
        : "";
    return `${path}${issue.message ?? "invalid"}`;
  });
  const rest = issues.length - quoted.length;
  return quoted.join("; ") + (rest > 0 ? ` (+${rest} more)` : "");
}

function summarizeThrown(err: unknown): string {
  const issues = (err as { issues?: unknown } | null)?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return summarizeIssues(issues as ReadonlyArray<SchemaIssueLike>);
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.length > MAX_MESSAGE_CHARS
    ? `${message.slice(0, MAX_MESSAGE_CHARS)}…`
    : message;
}

/**
 * Is `value` a plain JSON shape, i.e. one that `structuredClone` reproduces
 * INDISTINGUISHABLY as far as a schema can tell?
 *
 * Only primitives, plain objects (`Object.prototype` or null prototype) and
 * plain arrays qualify. Everything else is rejected:
 *
 * - **Class instances** — `structuredClone` returns a plain object, so a schema
 *   doing `instanceof Foo` (or reading a prototype method) rejects the clone
 *   while the author's real example would pass. That is a FALSE drift warning,
 *   the one failure mode this check must never produce.
 * - **`Date` / `RegExp`** — `structuredClone` *does* preserve these two, so
 *   allowing them would be sound. They are excluded anyway to keep ONE rule
 *   ("the example is a JSON document") that matches what an example actually
 *   is: a payload the projection publishes as JSON, where a `Date` cannot
 *   survive serialization. Relaxing this later is a one-line change.
 * - **`Map` / `Set` / typed arrays** — cloneable, but outside that same JSON
 *   vocabulary.
 * - **Functions / symbols** — not cloneable at all.
 * - **Symbol-keyed or non-enumerable own properties** — silently dropped by
 *   `structuredClone`, so a schema reading them would see a different value.
 *
 * Skipping is always safe: this whole module is advisory, and a missed warning
 * costs far less than a wrong one.
 */
function isPlainJsonShape(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null) return true;
  const kind = typeof value;
  if (
    kind === "string" ||
    kind === "number" ||
    kind === "boolean" ||
    kind === "undefined" ||
    kind === "bigint"
  ) {
    return true;
  }
  if (kind !== "object") return false; // function, symbol

  const object = value as object;
  // A cycle is fine — `structuredClone` preserves cycles, and the node itself
  // was already checked on the way down.
  if (seen.has(object)) return true;
  seen.add(object);

  if (Object.getOwnPropertySymbols(object).length > 0) return false;

  const prototype = Object.getPrototypeOf(object) as unknown;
  if (Array.isArray(object)) {
    // An Array SUBCLASS clones down to a plain array — same identity loss as a
    // class instance.
    if (prototype !== Array.prototype) return false;
    // Own props beyond the indices + `length` (an "expando" array) are dropped
    // or reshaped by the clone.
    if (Object.getOwnPropertyNames(object).length !== object.length + 1) return false;
    return object.every((item) => isPlainJsonShape(item, seen));
  }

  if (prototype !== Object.prototype && prototype !== null) return false;
  // Non-enumerable own properties don't survive the clone.
  if (Object.getOwnPropertyNames(object).length !== Object.keys(object).length) {
    return false;
  }
  return Object.values(object).every((item) => isPlainJsonShape(item, seen));
}

/**
 * Run the schema against the example. `safeParse` is preferred, `parse` is the
 * fallback; a schema exposing neither (e.g. a hand-rolled `jsonSchema`-only
 * `SchemaLike`) is skipped silently, as is any schema that blows up on its own.
 *
 * The example is deep-cloned first: the value handed to the schema is the SAME
 * object the projection publishes (and `canonicalHash` covers), and a schema
 * that normalizes in place (or a `parse` that mutates its input) would rewrite
 * the author's artifact from inside an advisory check. A value the clone can't
 * reproduce faithfully ({@link isPlainJsonShape}) is skipped rather than either
 * exposed live or misjudged through a lossy copy.
 */
function checkExample(schema: SchemaLike<unknown>, value: unknown): ExampleCheck {
  let isolated: unknown;
  try {
    if (!isPlainJsonShape(value, new WeakSet<object>())) return { status: "ok" };
    isolated = structuredClone(value);
  } catch {
    // Not cloneable, or a getter/proxy threw while we inspected the shape —
    // refuse to hand the live reference to a user schema.
    return { status: "ok" };
  }

  try {
    if (typeof schema.safeParse === "function") {
      const result = schema.safeParse(isolated);
      if (result.success) return { status: "ok" };
      return { status: "mismatch", summary: summarizeIssues(result.error?.issues ?? []) };
    }
    if (typeof schema.parse === "function") {
      try {
        schema.parse(isolated);
        return { status: "ok" };
      } catch (err) {
        return { status: "mismatch", summary: summarizeThrown(err) };
      }
    }
  } catch {
    // The schema itself misbehaved (a safeParse that throws, an exotic
    // validator). That is not the author's example problem — stay quiet
    // rather than blame the wrong artifact.
    return { status: "ok" };
  }
  // Neither safeParse nor parse — nothing to check against.
  return { status: "ok" };
}

/**
 * Identity of the contract a site belongs to. The id ALONE is not unique: the
 * same id may legally be authored on two scoped surfaces
 * (`contract.http.with("api-a")` / `.with("api-b")`), and they are different
 * contracts with different schemas — so the once-per-site guard keys on both.
 */
interface ContractSite {
  contractId: string;
  instanceName: string | undefined;
}

/**
 * Structured identity of one checkable site.
 *
 * Each authored name (case key, named-example key) is its OWN tuple element, so
 * the identity is injective by construction. The rendered dotted path is not:
 * a case key or example name may itself contain dots, and then e.g.
 * `cases["x"].expect.examples["y.expect.example"]` and
 * `cases["x.expect.examples.y"].expect.example` render the SAME string —
 * keying on that string made the second site inherit the first one's
 * "already warned" mark and vanish. The dotted form is now display-only.
 */
type SiteId =
  | readonly ["request", "example"]
  | readonly ["request", "examples", string]
  | readonly ["case", string, "example"]
  | readonly ["case", string, "examples", string];

/** The author-facing dotted path for a site — for the warning text only. */
function renderSitePath(siteId: SiteId): string {
  if (siteId[0] === "request") {
    return siteId.length === 2 ? "request.example" : `request.examples.${siteId[2]}`;
  }
  const caseKey = siteId[1];
  return siteId.length === 3
    ? `cases.${caseKey}.expect.example`
    : `cases.${caseKey}.expect.examples.${siteId[3]}`;
}

function checkSite(
  site: ContractSite,
  siteId: SiteId,
  schema: SchemaLike<unknown> | undefined,
  value: unknown,
): void {
  // Both a schema and an example must be present for the site to be checkable.
  // A schema may be a callable (some libraries hand back a function carrying
  // `parse`/`safeParse`), so accept "function" alongside "object".
  if (schema == null) return;
  if (typeof schema !== "object" && typeof schema !== "function") return;
  if (value === undefined) return;

  // JSON array key over the STRUCTURED parts: injective, so no
  // instance/id/case/example combination can collide with another.
  const guardKey = JSON.stringify([site.instanceName ?? "", site.contractId, ...siteId]);
  if (warnedSites.has(guardKey)) return;

  const result = checkExample(schema, value);
  if (result.status === "ok") return;

  warnedSites.add(guardKey);
  const instance =
    site.instanceName === undefined ? "" : ` (instance "${site.instanceName}")`;
  const where = siteId[0] === "case" ? ` case "${siteId[1]}"` : "";
  console.warn(
    `[glubean] contract "${site.contractId}"${instance}${where}: ` +
      `${renderSitePath(siteId)} does not match its schema — ${result.summary} ` +
      `(examples are documentation-only; update the example or the schema)`,
  );
}

function checkExamplesMap(
  site: ContractSite,
  caseKey: string | undefined,
  schema: SchemaLike<unknown> | undefined,
  examples: Record<string, ContractExample<unknown>> | undefined,
): void {
  if (!examples || typeof examples !== "object") return;
  for (const [name, example] of Object.entries(examples)) {
    if (!example || typeof example !== "object") continue;
    const siteId: SiteId =
      caseKey === undefined
        ? (["request", "examples", name] as const)
        : (["case", caseKey, "examples", name] as const);
    checkSite(site, siteId, schema, example.value);
  }
}

/**
 * Warn about every example that no longer matches the schema next to it.
 *
 * Checked sites:
 * - `request.example` and `request.examples.<name>` against `request.body`
 * - `cases.<key>.expect.example` and `cases.<key>.expect.examples.<name>`
 *   against that case's `expect.schema`
 *
 * Inbound cases carry no `expect.schema`/response examples, so they contribute
 * no sites.
 */
export function warnOnExampleSchemaDrift(
  projection: ContractProjection<HttpPayloadSchemas, HttpContractMeta> & { id: string },
): void {
  try {
    const site: ContractSite = {
      contractId: projection.id,
      instanceName: projection.instanceName,
    };

    const request = projection.schemas?.request;
    if (request) {
      checkSite(site, ["request", "example"], request.body, request.example);
      checkExamplesMap(site, undefined, request.body, request.examples);
    }

    for (const projCase of projection.cases ?? []) {
      const response = projCase.schemas?.response;
      if (!response) continue;
      checkSite(
        site,
        ["case", projCase.key, "example"],
        response.body,
        response.example,
      );
      checkExamplesMap(site, projCase.key, response.body, response.examples);
    }
  } catch {
    // A docs-quality hint must never break contract construction.
  }
}
