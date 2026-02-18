/**
 * `glubean coverage` command — show API endpoint test coverage.
 *
 * Cross-references an OpenAPI spec with trace data from the last
 * `glubean run` (stored in .glubean/traces.json) to determine which
 * endpoints have test coverage. Falls back to tag-based matching
 * from scan metadata if no trace data is available.
 */

import { resolve } from "@std/path";
import { scan } from "@glubean/scanner";
import { type Endpoint, extractEndpoints, findOpenApiSpec, loadOpenApiSpec } from "../lib/openapi.ts";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

/** Trace summary written by `glubean run`. */
interface TraceSummary {
  runAt: string;
  file: string;
  traces: Array<{
    testId: string;
    method: string;
    url: string;
    status: number;
  }>;
}

/** Coverage result for a single endpoint. */
interface EndpointCoverage {
  endpoint: Endpoint;
  covered: boolean;
  testIds: string[];
  source: "trace" | "tag" | "none";
}

export interface CoverageCommandOptions {
  openapi?: string;
  dir?: string;
  json?: boolean;
}

export async function coverageCommand(
  options: CoverageCommandOptions = {},
): Promise<void> {
  const dir = options.dir ? resolve(options.dir) : Deno.cwd();

  // 1. Resolve and load OpenAPI spec
  let openapiPath: string;
  if (options.openapi) {
    openapiPath = resolve(options.openapi);
  } else {
    const found = await findOpenApiSpec(dir);
    if (!found) {
      console.error(
        `${colors.red}Error: No OpenAPI spec found. Provide --openapi <path> or create openapi.json / openapi.yaml.${colors.reset}`,
      );
      Deno.exit(1);
    }
    openapiPath = found;
  }

  let spec;
  try {
    spec = await loadOpenApiSpec(openapiPath);
  } catch (err) {
    console.error(
      `${colors.red}Error: Failed to parse ${openapiPath}: ${err instanceof Error ? err.message : err}${colors.reset}`,
    );
    Deno.exit(1);
  }

  const endpoints = extractEndpoints(spec);
  if (endpoints.length === 0) {
    console.log(
      `\n${colors.yellow}No endpoints found in OpenAPI spec.${colors.reset}\n`,
    );
    return;
  }

  // 2. Try to load trace data
  const tracesPath = resolve(dir, ".glubean", "traces.json");
  let traces: TraceSummary | null = null;
  try {
    const content = await Deno.readTextFile(tracesPath);
    traces = JSON.parse(content) as TraceSummary;
  } catch {
    // No trace data available
  }

  // 3. Compute coverage
  let results: EndpointCoverage[];
  let source: string;

  if (traces && traces.traces.length > 0) {
    results = computeTraceCoverage(endpoints, traces);
    source = `last run: ${traces.runAt}`;
  } else {
    // Fallback: tag-based matching from scan metadata
    results = await computeTagCoverage(endpoints, dir);
    source = traces ? "last run (no traces recorded)" : "tag-based (no trace data — run tests first)";
  }

  // 4. Output
  if (options.json) {
    const output = {
      source,
      total: endpoints.length,
      covered: results.filter((r) => r.covered).length,
      uncovered: results.filter((r) => !r.covered).length,
      endpoints: results.map((r) => ({
        method: r.endpoint.method,
        path: r.endpoint.path,
        covered: r.covered,
        testIds: r.testIds,
        source: r.source,
      })),
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  outputCoverageReport(results, source);
}

// ---------------------------------------------------------------------------
// Trace-based coverage
// ---------------------------------------------------------------------------

/**
 * Match a trace URL against OpenAPI endpoint path templates.
 * E.g. "https://api.example.com/users/42/role" matches "/users/{id}/role"
 */
function matchTraceToEndpoint(
  traceUrl: string,
  traceMethod: string,
  endpoints: Endpoint[],
): Endpoint | null {
  // Extract pathname from the URL
  let urlPath: string;
  try {
    urlPath = new URL(traceUrl).pathname;
  } catch {
    // If URL parsing fails, try treating as a path directly
    urlPath = traceUrl.startsWith("/") ? traceUrl : `/${traceUrl}`;
  }

  // Normalize: remove trailing slash
  if (urlPath.length > 1 && urlPath.endsWith("/")) {
    urlPath = urlPath.slice(0, -1);
  }

  for (const ep of endpoints) {
    if (ep.method.toUpperCase() !== traceMethod.toUpperCase()) continue;

    // Convert OpenAPI path template to regex
    // "/users/{id}/role" → /^\/users\/[^/]+\/role$/
    const escaped = ep.path.replace(
      /[.*+?^${}()|[\]\\]/g,
      (m) => m === "{" || m === "}" ? m : `\\${m}`,
    );
    const pattern = escaped.replace(/\{[^}]+\}/g, "[^/]+");
    try {
      if (new RegExp(`^${pattern}$`).test(urlPath)) {
        return ep;
      }
    } catch {
      // Invalid regex, skip
    }
  }
  return null;
}

function computeTraceCoverage(
  endpoints: Endpoint[],
  traces: TraceSummary,
): EndpointCoverage[] {
  // Build a map of endpoint key → test IDs
  const coverageMap = new Map<string, Set<string>>();

  for (const trace of traces.traces) {
    const matched = matchTraceToEndpoint(trace.url, trace.method, endpoints);
    if (matched) {
      const key = `${matched.method} ${matched.path}`;
      if (!coverageMap.has(key)) {
        coverageMap.set(key, new Set());
      }
      coverageMap.get(key)!.add(trace.testId);
    }
  }

  return endpoints.map((ep) => {
    const key = `${ep.method} ${ep.path}`;
    const testIds = coverageMap.get(key);
    return {
      endpoint: ep,
      covered: !!testIds && testIds.size > 0,
      testIds: testIds ? [...testIds] : [],
      source: testIds && testIds.size > 0 ? ("trace" as const) : ("none" as const),
    };
  });
}

// ---------------------------------------------------------------------------
// Tag-based coverage (fallback)
// ---------------------------------------------------------------------------

async function computeTagCoverage(
  endpoints: Endpoint[],
  dir: string,
): Promise<EndpointCoverage[]> {
  // Scan project to get test metadata
  let scanResult;
  try {
    scanResult = await scan(dir);
  } catch {
    // Can't scan — return everything as uncovered
    return endpoints.map((ep) => ({
      endpoint: ep,
      covered: false,
      testIds: [],
      source: "none" as const,
    }));
  }

  // Build a map: tags → test IDs
  // Tags matching "METHOD /path" pattern are treated as endpoint references
  const tagToTestIds = new Map<string, string[]>();
  for (const [_filePath, fileMeta] of Object.entries(scanResult.files)) {
    for (const exp of fileMeta.exports) {
      if (exp.tags) {
        for (const tag of exp.tags) {
          if (!tagToTestIds.has(tag)) {
            tagToTestIds.set(tag, []);
          }
          tagToTestIds.get(tag)!.push(exp.id);
        }
      }
    }
  }

  return endpoints.map((ep) => {
    const key = `${ep.method} ${ep.path}`;
    const keyLower = key.toLowerCase();
    // Try matching tags like "GET /users", "get /users", "get-users", etc.
    let testIds: string[] = [];

    for (const [tag, ids] of tagToTestIds) {
      if (tag.toLowerCase() === keyLower) {
        testIds = [...testIds, ...ids];
      }
    }

    return {
      endpoint: ep,
      covered: testIds.length > 0,
      testIds: [...new Set(testIds)],
      source: testIds.length > 0 ? ("tag" as const) : ("none" as const),
    };
  });
}

// ---------------------------------------------------------------------------
// Report output
// ---------------------------------------------------------------------------

function outputCoverageReport(
  results: EndpointCoverage[],
  source: string,
): void {
  const covered = results.filter((r) => r.covered);
  const uncovered = results.filter((r) => !r.covered);
  const total = results.length;
  const pct = total > 0 ? Math.round((covered.length / total) * 100) : 0;

  console.log(
    `\n${colors.bold}API Coverage${colors.reset} ${colors.dim}(${source})${colors.reset}\n`,
  );
  console.log(
    `  ${colors.bold}Endpoints:${colors.reset} ${total} total, ${colors.green}${covered.length} covered${colors.reset}, ${
      uncovered.length > 0 ? colors.red : colors.dim
    }${uncovered.length} uncovered${colors.reset} (${pct}%)\n`,
  );

  if (covered.length > 0) {
    console.log(`  ${colors.bold}Covered:${colors.reset}`);
    for (const r of covered) {
      const method = r.endpoint.method.padEnd(7);
      const tests = r.testIds.length > 0
        ? ` — ${r.testIds.length} test${r.testIds.length > 1 ? "s" : ""} (${r.testIds.join(", ")})`
        : "";
      console.log(
        `    ${colors.green}${method}${colors.reset} ${r.endpoint.path}${colors.dim}${tests}${colors.reset}`,
      );
    }
    console.log();
  }

  if (uncovered.length > 0) {
    console.log(`  ${colors.bold}Uncovered:${colors.reset}`);
    for (const r of uncovered) {
      const method = r.endpoint.method.padEnd(7);
      const summary = r.endpoint.summary ? ` ${colors.dim}— ${r.endpoint.summary}${colors.reset}` : "";
      console.log(
        `    ${colors.red}${method}${colors.reset} ${r.endpoint.path}${summary}`,
      );
    }
    console.log();
  }
}
