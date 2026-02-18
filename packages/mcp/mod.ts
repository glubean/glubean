/**
 * Glubean MCP server (stdio).
 *
 * Purpose:
 * - Let AI agents (Cursor, etc.) run verification-as-code locally
 * - Fetch structured failures (assertions/logs/traces) for automatic fixing
 * - Optionally trigger/tail remote runs via Glubean Open Platform APIs
 *
 * IMPORTANT (stdio transport):
 * - Never write to stdout. Use stderr for logs.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { dirname, resolve, toFileUrl } from "@std/path";
import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { resolveModuleTests, TestExecutor } from "@glubean/runner";
import type { ResolvedTest } from "@glubean/runner";
import { createStaticScanner, scan } from "@glubean/scanner";
import type { BundleMetadata, FileMeta, ScanResult } from "@glubean/scanner";

type Vars = Record<string, string>;
const METADATA_SCHEMA_VERSION = "1";

async function findProjectRoot(startDir: string): Promise<string> {
  let dir = startDir;
  while (true) {
    try {
      await Deno.stat(resolve(dir, "deno.json"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break; // filesystem root reached
      dir = parent;
    }
  }
  return startDir;
}

async function loadEnvFile(envPath: string): Promise<Vars> {
  const vars: Vars = {};
  try {
    const content = await Deno.readTextFile(envPath);
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    }
  } catch {
    // missing env file is allowed
  }
  return vars;
}

function normalizeFilePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function normalizeFileMap(
  files: Record<string, FileMeta>,
): Record<string, FileMeta> {
  const normalized: Record<string, FileMeta> = {};
  for (const [path, meta] of Object.entries(files)) {
    const normalizedPath = normalizeFilePath(path);
    if (normalized[normalizedPath]) {
      throw new Error(`Duplicate file path after normalization: ${path}`);
    }
    normalized[normalizedPath] = meta;
  }
  return normalized;
}

function deriveMetadataStats(files: Record<string, FileMeta>): {
  testCount: number;
  fileCount: number;
  tags: string[];
} {
  let testCount = 0;
  const allTags = new Set<string>();

  for (const fileMeta of Object.values(files)) {
    for (const exp of fileMeta.exports) {
      if (exp.tags) {
        exp.tags.forEach((tag) => allTags.add(tag));
      }
      testCount += 1;
    }
  }

  return {
    testCount,
    fileCount: Object.keys(files).length,
    tags: Array.from(allTags).sort(),
  };
}

async function computeRootHash(
  files: Record<string, FileMeta>,
): Promise<string> {
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  const payload = entries
    .map(([path, meta]) => `${path}:${meta.hash}`)
    .join("\n");
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return `sha256-${encodeHex(new Uint8Array(hash))}`;
}

async function buildMetadata(
  scanResult: ScanResult,
  options: { generatedBy: string; generatedAt?: string },
): Promise<BundleMetadata> {
  const normalizedFiles = normalizeFileMap(scanResult.files);
  const stats = deriveMetadataStats(normalizedFiles);
  const rootHash = await computeRootHash(normalizedFiles);

  return {
    schemaVersion: METADATA_SCHEMA_VERSION,
    specVersion: scanResult.specVersion,
    generatedBy: options.generatedBy,
    generatedAt: options.generatedAt || new Date().toISOString(),
    rootHash,
    files: normalizedFiles,
    testCount: stats.testCount,
    fileCount: stats.fileCount,
    tags: stats.tags,
    warnings: scanResult.warnings,
  };
}

async function discoverTestsFromFile(filePath: string): Promise<{
  fileUrl: string;
  tests: ResolvedTest[];
}> {
  const absolutePath = resolve(filePath);
  const fileUrl = toFileUrl(absolutePath).toString();
  const module = await import(fileUrl);
  const tests = resolveModuleTests(module);
  return { fileUrl, tests };
}

function resolveRootDir(dir?: string): string {
  return dir ? resolve(dir) : Deno.cwd();
}

async function scanProject(
  dir: string,
  mode: "runtime" | "static",
): Promise<ScanResult> {
  if (mode === "static") {
    const scanner = createStaticScanner();
    return await scanner.scan(dir);
  }
  return await scan(dir);
}

export interface LocalRunResult {
  exportName: string;
  id: string;
  name?: string;
  success: boolean;
  durationMs: number;
  assertions: Array<{
    passed: boolean;
    message: string;
    actual?: unknown;
    expected?: unknown;
  }>;
  logs: Array<{ message: string; data?: unknown }>;
  traces: Array<unknown>;
  error?: { message: string; stack?: string };
}

async function runLocalTestsFromFile(args: {
  filePath: string;
  filter?: string;
  envFile?: string;
  includeLogs?: boolean;
  includeTraces?: boolean;
  stopOnFailure?: boolean;
  concurrency?: number;
}): Promise<{
  fileUrl: string;
  projectRoot: string;
  vars: Vars;
  secrets: Vars;
  results: LocalRunResult[];
  summary: { total: number; passed: number; failed: number };
  error?: string;
}> {
  const absolutePath = resolve(args.filePath);
  const testDir = dirname(absolutePath);
  const projectRoot = await findProjectRoot(testDir);

  const envPath = args.envFile ? resolve(args.envFile) : resolve(projectRoot, ".env");
  const secretsPath = envPath + ".secrets";

  const [vars, secrets] = await Promise.all([
    loadEnvFile(envPath),
    loadEnvFile(secretsPath),
  ]);

  const { fileUrl, tests } = await discoverTestsFromFile(absolutePath);

  const hasOnly = tests.some((t) => t.only);
  const normalizedFilter = args.filter?.toLowerCase().trim();

  const selected = tests.filter((t) => {
    if (t.skip) return false;
    if (hasOnly && !t.only) return false;
    if (!normalizedFilter) return true;
    const haystack = [t.id, t.name ?? "", ...(t.tags ?? [])]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedFilter);
  });

  if (selected.length === 0) {
    return {
      fileUrl,
      projectRoot,
      vars,
      secrets,
      results: [],
      summary: { total: 0, passed: 0, failed: 0 },
      error: tests.length === 0
        ? "No tests discovered in file. Check that exports use test() from @glubean/sdk."
        : `No tests matched filter "${args.filter}". Available: ${tests.map((t) => t.id).join(", ")}`,
    };
  }

  const executor = new TestExecutor();

  const concurrency = Math.max(1, args.concurrency ?? 1);
  const stopOnFailure = Boolean(args.stopOnFailure);
  const includeLogs = args.includeLogs ?? true;
  const includeTraces = args.includeTraces ?? false;

  const results: LocalRunResult[] = [];
  let nextIndex = 0;
  let stop = false;

  const runNext = async (): Promise<void> => {
    while (!stop) {
      const index = nextIndex++;
      if (index >= selected.length) return;

      const test = selected[index];
      const start = Date.now();

      const logs: LocalRunResult["logs"] = [];
      const assertions: LocalRunResult["assertions"] = [];
      const traces: LocalRunResult["traces"] = [];

      let statusSuccess = false;
      let errorMessage: string | undefined;
      let errorStack: string | undefined;

      for await (
        const event of executor.run(fileUrl, test.id, {
          vars,
          secrets,
        }, { exportName: test.exportName })
      ) {
        switch (event.type) {
          case "log":
            if (includeLogs) {
              logs.push({ message: event.message, data: event.data });
            }
            break;
          case "assertion":
            assertions.push({
              passed: event.passed,
              message: event.message,
              actual: event.actual,
              expected: event.expected,
            });
            break;
          case "trace":
            if (includeTraces) traces.push(event.data);
            break;
          case "status":
            statusSuccess = event.status === "completed";
            if (event.error) errorMessage = event.error;
            if (event.stack) errorStack = event.stack;
            break;
          case "error":
            errorMessage = event.message;
            break;
        }
      }

      const allAssertionsPassed = assertions.every((a) => a.passed);
      const success = statusSuccess && allAssertionsPassed && !errorMessage;

      const result: LocalRunResult = {
        exportName: test.exportName,
        id: test.id,
        name: test.name,
        success,
        durationMs: Date.now() - start,
        assertions,
        logs,
        traces,
        error: errorMessage ? { message: errorMessage, stack: errorStack } : undefined,
      };
      results.push(result);

      if (!success && stopOnFailure) {
        stop = true;
        return;
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, selected.length || 1) },
    () => runNext(),
  );
  await Promise.all(workers);

  const passed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  return {
    fileUrl,
    projectRoot,
    vars,
    secrets,
    results,
    summary: { total: results.length, passed, failed },
  };
}

function bearerHeaders(token?: string): HeadersInit {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 2000)}`,
    );
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const server = new McpServer({
  name: "glubean",
  version: "0.1.0",
});

server.registerTool(
  "glubean_discover_tests",
  {
    description: "Discover Glubean test exports from a file path and return their metadata.",
    inputSchema: {
      filePath: z
        .string()
        .describe("Path to a test module file (e.g. tests/api.test.ts)"),
    },
  },
  async (input: { filePath: string }) => {
    const { filePath } = input;
    const { tests } = await discoverTestsFromFile(filePath);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ tests }, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  "glubean_run_local_file",
  {
    description: "Run Glubean test exports from a file locally and return structured results for AI debugging/fixing.",
    inputSchema: {
      filePath: z.string().describe("Path to a test module file"),
      filter: z
        .string()
        .optional()
        .describe("Filter by id/name/tag (substring match)"),
      envFile: z
        .string()
        .optional()
        .describe("Path to .env file (default: <projectRoot>/.env)"),
      includeLogs: z
        .boolean()
        .optional()
        .describe("Include ctx.log events (default: true)"),
      includeTraces: z
        .boolean()
        .optional()
        .describe("Include ctx.trace events (default: false)"),
      stopOnFailure: z
        .boolean()
        .optional()
        .describe("Stop after first failed test (default: false)"),
      concurrency: z
        .number()
        .int()
        .min(1)
        .max(16)
        .optional()
        .describe("Parallelism (default: 1)"),
    },
  },
  async (input: {
    filePath: string;
    filter?: string;
    envFile?: string;
    includeLogs?: boolean;
    includeTraces?: boolean;
    stopOnFailure?: boolean;
    concurrency?: number;
  }) => {
    const result = await runLocalTestsFromFile({
      filePath: input.filePath,
      filter: input.filter,
      envFile: input.envFile,
      includeLogs: input.includeLogs,
      includeTraces: input.includeTraces,
      stopOnFailure: input.stopOnFailure,
      concurrency: input.concurrency,
    });

    // Never return secrets. Return only counts so the agent can reason about config presence.
    const safe: Record<string, unknown> = {
      projectRoot: result.projectRoot,
      fileUrl: result.fileUrl,
      varsCount: Object.keys(result.vars).length,
      secretsCount: Object.keys(result.secrets).length,
      summary: result.summary,
      results: result.results,
    };
    if (result.error) {
      safe.error = result.error;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(safe, null, 2) }],
    };
  },
);

server.registerTool(
  "glubean_list_test_files",
  {
    description: "List Glubean test files in a directory (lightweight index, no file writes).",
    inputSchema: {
      dir: z
        .string()
        .optional()
        .describe(
          "Project root directory (default: current working directory)",
        ),
      mode: z
        .enum(["static", "runtime"])
        .optional()
        .describe(
          'Scan mode: "static" (no runtime imports, default) or "runtime" (most accurate)',
        ),
    },
  },
  async (input: { dir?: string; mode?: "static" | "runtime" }) => {
    const rootDir = resolveRootDir(input.dir);
    const mode = input.mode ?? "static";
    const result = await scanProject(rootDir, mode);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              rootDir,
              mode,
              fileCount: result.fileCount,
              files: Object.keys(result.files).sort(),
              warnings: result.warnings,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "glubean_get_metadata",
  {
    description: "Generate metadata (equivalent to metadata.json) in-memory for AI use, without writing to disk.",
    inputSchema: {
      dir: z
        .string()
        .optional()
        .describe(
          "Project root directory (default: current working directory)",
        ),
      mode: z
        .enum(["runtime", "static"])
        .optional()
        .describe(
          'Scan mode: "runtime" (most accurate, default) or "static" (no runtime imports)',
        ),
      generatedBy: z
        .string()
        .optional()
        .describe('Override generatedBy field (default: "@glubean/mcp@0.1.0")'),
    },
  },
  async (input: {
    dir?: string;
    mode?: "runtime" | "static";
    generatedBy?: string;
  }) => {
    const rootDir = resolveRootDir(input.dir);
    const mode = input.mode ?? "runtime";
    const result = await scanProject(rootDir, mode);
    const metadata = await buildMetadata(result, {
      generatedBy: input.generatedBy ?? "@glubean/mcp@0.1.0",
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              rootDir,
              mode,
              metadata,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "glubean_open_trigger_run",
  {
    description: "Trigger a remote run via Glubean Open Platform API (POST /open/v1/runs).",
    inputSchema: {
      apiUrl: z.string().describe("Base API URL, e.g. https://api.glubean.com"),
      token: z.string().describe("Project token with runs:write scope"),
      projectId: z.string().describe("Project ID (short id)"),
      bundleId: z.string().describe("Bundle ID (short id)"),
      jobId: z.string().optional().describe("Optional job ID"),
    },
  },
  async (input: {
    apiUrl: string;
    token: string;
    projectId: string;
    bundleId: string;
    jobId?: string;
  }) => {
    const { apiUrl, token, projectId, bundleId, jobId } = input;
    const url = `${apiUrl.replace(/\/$/, "")}/open/v1/runs`;
    const body = { projectId, bundleId, jobId };
    const json = await fetchJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearerHeaders(token) },
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  },
);

server.registerTool(
  "glubean_open_get_run",
  {
    description: "Get run status via Glubean Open Platform API (GET /open/v1/runs/:runId).",
    inputSchema: {
      apiUrl: z.string().describe("Base API URL, e.g. https://api.glubean.com"),
      token: z.string().describe("Project token with runs:read scope"),
      runId: z.string().describe("Run ID"),
    },
  },
  async (input: { apiUrl: string; token: string; runId: string }) => {
    const { apiUrl, token, runId } = input;
    const url = `${apiUrl.replace(/\/$/, "")}/open/v1/runs/${
      encodeURIComponent(
        runId,
      )
    }`;
    const json = await fetchJson(url, {
      method: "GET",
      headers: bearerHeaders(token),
    });
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  },
);

server.registerTool(
  "glubean_open_get_run_events",
  {
    description: "Fetch a page of run events via Glubean Open Platform API (GET /open/v1/runs/:runId/events).",
    inputSchema: {
      apiUrl: z.string().describe("Base API URL, e.g. https://api.glubean.com"),
      token: z.string().describe("Project token with runs:read scope"),
      runId: z.string().describe("Run ID"),
      afterSeq: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Cursor: return events after this seq"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Max events (default server: 100)"),
      type: z
        .string()
        .optional()
        .describe("Filter by event type (log/assert/trace/result)"),
    },
  },
  async (input: {
    apiUrl: string;
    token: string;
    runId: string;
    afterSeq?: number;
    limit?: number;
    type?: string;
  }) => {
    const { apiUrl, token, runId, afterSeq, limit, type } = input;
    const base = `${
      apiUrl.replace(
        /\/$/,
        "",
      )
    }/open/v1/runs/${encodeURIComponent(runId)}/events`;
    const params = new URLSearchParams();
    if (afterSeq !== undefined) params.set("afterSeq", String(afterSeq));
    if (limit !== undefined) params.set("limit", String(limit));
    if (type) params.set("type", type);
    const url = params.size ? `${base}?${params.toString()}` : base;

    const json = await fetchJson(url, {
      method: "GET",
      headers: bearerHeaders(token),
    });
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("glubean MCP server running (stdio)");
}

if (import.meta.main) {
  await main();
}
