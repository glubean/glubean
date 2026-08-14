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
 * Run the schema against the example. `safeParse` is preferred, `parse` is the
 * fallback; a schema exposing neither (e.g. a hand-rolled `jsonSchema`-only
 * `SchemaLike`) is skipped silently, as is any schema that blows up on its own.
 *
 * The example is deep-cloned first: the value handed to the schema is the SAME
 * object the projection publishes (and `canonicalHash` covers), and a schema
 * that normalizes in place (or a `parse` that mutates its input) would rewrite
 * the author's artifact from inside an advisory check. A value that can't be
 * cloned (functions, class instances, streams) is skipped rather than exposed.
 */
function checkExample(schema: SchemaLike<unknown>, value: unknown): ExampleCheck {
  let isolated: unknown;
  try {
    isolated = structuredClone(value);
  } catch {
    // Not cloneable — refuse to hand the live reference to a user schema.
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

function checkSite(
  site: ContractSite,
  caseKey: string | undefined,
  sitePath: string,
  schema: SchemaLike<unknown> | undefined,
  value: unknown,
): void {
  // Both a schema and an example must be present for the site to be checkable.
  // A schema may be a callable (some libraries hand back a function carrying
  // `parse`/`safeParse`), so accept "function" alongside "object".
  if (schema == null) return;
  if (typeof schema !== "object" && typeof schema !== "function") return;
  if (value === undefined) return;

  // JSON array key: injective, so no instance/id/path triple can collide.
  const guardKey = JSON.stringify([site.instanceName ?? "", site.contractId, sitePath]);
  if (warnedSites.has(guardKey)) return;

  const result = checkExample(schema, value);
  if (result.status === "ok") return;

  warnedSites.add(guardKey);
  const instance =
    site.instanceName === undefined ? "" : ` (instance "${site.instanceName}")`;
  const where = caseKey === undefined ? "" : ` case "${caseKey}"`;
  console.warn(
    `[glubean] contract "${site.contractId}"${instance}${where}: ${sitePath} does ` +
      `not match its schema — ${result.summary} (examples are documentation-only; ` +
      `update the example or the schema)`,
  );
}

function checkExamplesMap(
  site: ContractSite,
  caseKey: string | undefined,
  basePath: string,
  schema: SchemaLike<unknown> | undefined,
  examples: Record<string, ContractExample<unknown>> | undefined,
): void {
  if (!examples || typeof examples !== "object") return;
  for (const [name, example] of Object.entries(examples)) {
    if (!example || typeof example !== "object") continue;
    checkSite(site, caseKey, `${basePath}.${name}`, schema, example.value);
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
      checkSite(site, undefined, "request.example", request.body, request.example);
      checkExamplesMap(
        site,
        undefined,
        "request.examples",
        request.body,
        request.examples,
      );
    }

    for (const projCase of projection.cases ?? []) {
      const response = projCase.schemas?.response;
      if (!response) continue;
      checkSite(
        site,
        projCase.key,
        `cases.${projCase.key}.expect.example`,
        response.body,
        response.example,
      );
      checkExamplesMap(
        site,
        projCase.key,
        `cases.${projCase.key}.expect.examples`,
        response.body,
        response.examples,
      );
    }
  } catch {
    // A docs-quality hint must never break contract construction.
  }
}
