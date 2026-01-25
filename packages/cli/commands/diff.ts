/**
 * `glubean diff` command — show OpenAPI spec changes vs a git ref.
 *
 * Computes a semantic diff between the current OpenAPI spec on disk and
 * the version at a git ref (default: HEAD). Outputs a human-readable
 * or JSON report of added, removed, and modified endpoints.
 *
 * Requires git. Exits with error if not in a git repo.
 */

import { resolve, relative } from "@std/path";
import { isGitRepo, gitShow, gitRoot } from "../lib/git.ts";
import {
  findOpenApiSpec,
  loadOpenApiSpec,
  parseOpenApiContent,
  extractEndpoints,
  diffEndpoints,
  formatRequestBody,
  formatParameters,
  formatResponses,
  type OpenApiDiff,
} from "../lib/openapi.ts";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
};

export interface DiffCommandOptions {
  openapi?: string;
  base?: string;
  json?: boolean;
}

export async function diffCommand(
  options: DiffCommandOptions = {}
): Promise<void> {
  const base = options.base || "HEAD";
  const dir = Deno.cwd();

  // 1. Verify git repo
  if (!(await isGitRepo(dir))) {
    console.error(
      `${colors.red}Error: Not a git repository. \`glubean diff\` requires git.${colors.reset}`
    );
    Deno.exit(1);
  }

  // 2. Resolve OpenAPI file path
  let openapiPath: string;
  if (options.openapi) {
    openapiPath = resolve(options.openapi);
  } else {
    const found = await findOpenApiSpec(dir);
    if (!found) {
      console.error(
        `${colors.red}Error: No OpenAPI spec found. Provide --openapi <path> or create openapi.json / openapi.yaml.${colors.reset}`
      );
      Deno.exit(1);
    }
    openapiPath = found;
  }

  // 3. Load current spec from disk
  let currentSpec;
  try {
    currentSpec = await loadOpenApiSpec(openapiPath);
  } catch (err) {
    console.error(
      `${colors.red}Error: Failed to parse ${openapiPath}: ${
        err instanceof Error ? err.message : err
      }${colors.reset}`
    );
    Deno.exit(1);
  }

  // 4. Load base spec from git
  const repoRoot = await gitRoot(dir);
  if (!repoRoot) {
    console.error(
      `${colors.red}Error: Could not determine git root.${colors.reset}`
    );
    Deno.exit(1);
  }
  const relPath = relative(repoRoot, openapiPath);

  const baseContent = await gitShow(base, relPath, dir);
  if (!baseContent) {
    if (!options.json) {
      console.log(
        `\n${colors.yellow}No previous version of ${relPath} found at ref "${base}".${colors.reset}`
      );
      console.log(
        `${colors.dim}This appears to be a new OpenAPI spec. All endpoints are new.${colors.reset}\n`
      );
    }
    // Treat as all-new: diff against empty spec
    const headEndpoints = extractEndpoints(currentSpec);
    const diff = diffEndpoints([], headEndpoints);
    outputDiff(diff, base, relPath, options.json ?? false);
    return;
  }

  let baseSpec;
  try {
    baseSpec = parseOpenApiContent(baseContent, openapiPath);
  } catch (err) {
    console.error(
      `${colors.red}Error: Failed to parse ${relPath} at ref "${base}": ${
        err instanceof Error ? err.message : err
      }${colors.reset}`
    );
    Deno.exit(1);
  }

  // 5. Extract endpoints and diff
  const baseEndpoints = extractEndpoints(baseSpec);
  const headEndpoints = extractEndpoints(currentSpec);
  const diff = diffEndpoints(baseEndpoints, headEndpoints);

  // 6. Output
  outputDiff(diff, base, relPath, options.json ?? false);
}

function outputDiff(
  diff: OpenApiDiff,
  base: string,
  filePath: string,
  json: boolean
): void {
  if (json) {
    console.log(JSON.stringify(diff, null, 2));
    return;
  }

  const totalChanges =
    diff.added.length + diff.removed.length + diff.modified.length;
  if (totalChanges === 0) {
    console.log(
      `\n${colors.green}No API changes${colors.reset} ${colors.dim}(${base} → working copy)${colors.reset}\n`
    );
    return;
  }

  console.log(
    `\n${colors.bold}API Diff${colors.reset} ${colors.dim}(${base} → working copy · ${filePath})${colors.reset}\n`
  );

  // Added endpoints
  if (diff.added.length > 0) {
    console.log(
      `  ${colors.bold}New Endpoints (${diff.added.length}):${colors.reset}`
    );
    for (const ep of diff.added) {
      console.log(
        `    ${colors.green}+ ${ep.method} ${ep.path}${colors.reset}${
          ep.summary ? ` — ${ep.summary}` : ""
        }`
      );
      const body = formatRequestBody(ep);
      if (body) {
        console.log(`      ${colors.dim}Request: ${body}${colors.reset}`);
      }
      const params = formatParameters(ep);
      if (params) {
        console.log(`      ${colors.dim}Query: ${params}${colors.reset}`);
      }
      const resp = formatResponses(ep);
      if (resp) {
        console.log(`      ${colors.dim}Response: ${resp}${colors.reset}`);
      }
    }
    console.log();
  }

  // Modified endpoints
  if (diff.modified.length > 0) {
    console.log(
      `  ${colors.bold}Modified Endpoints (${diff.modified.length}):${colors.reset}`
    );
    for (const { endpoint, changes } of diff.modified) {
      console.log(
        `    ${colors.yellow}~ ${endpoint.method} ${endpoint.path}${colors.reset}`
      );
      for (const change of changes) {
        const color = change.startsWith("+")
          ? colors.green
          : change.startsWith("-")
          ? colors.red
          : colors.yellow;
        console.log(`      ${color}${change}${colors.reset}`);
      }
    }
    console.log();
  }

  // Removed endpoints
  if (diff.removed.length > 0) {
    console.log(
      `  ${colors.bold}Removed Endpoints (${diff.removed.length}):${colors.reset}`
    );
    for (const ep of diff.removed) {
      console.log(
        `    ${colors.red}- ${ep.method} ${ep.path}${colors.reset}${
          ep.summary ? ` — ${ep.summary}` : ""
        }`
      );
    }
    console.log();
  }
}
