/**
 * Pure utility functions extracted from testController.ts.
 *
 * These functions have zero dependency on the `vscode` API and can be
 * unit-tested with `node:test` + `node:assert`.
 *
 * Run tests: npx tsx --test src/testController.utils.test.ts
 */

// ---------------------------------------------------------------------------
// Types (shared with testController.ts)
// ---------------------------------------------------------------------------

/** Event from the runner (matches ExecutionEvent union) */
export interface GlubeanEvent {
  type: string;
  // log
  message?: string;
  data?: unknown;
  // assertion
  passed?: boolean;
  actual?: unknown;
  expected?: unknown;
  // status
  status?: string;
  error?: string;
  // step
  index?: number;
  name?: string;
  total?: number;
  durationMs?: number;
  assertions?: number;
  stepIndex?: number;
}

/** A request/response pair from a .trace.jsonc file */
export interface TracePair {
  request: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
  response?: unknown;
}

// ---------------------------------------------------------------------------
// CLI argument builder
// ---------------------------------------------------------------------------

/**
 * Build CLI args for `glubean run`.
 * Always includes --verbose --pretty --result-json --emit-full-trace
 * for maximum output in the Test Results panel.
 *
 * @param filePath   Path to the test file
 * @param filterId   Optional test ID filter (--filter)
 * @param pickKey    Optional test.pick example key (--pick)
 * @param envFile    Optional env file path (--env-file)
 */
export function buildArgs(
  filePath: string,
  filterId?: string,
  pickKey?: string,
  envFile?: string,
): string[] {
  const args = [
    "run",
    filePath,
    "--verbose",
    "--pretty",
    "--result-json",
    "--emit-full-trace",
  ];
  if (filterId) {
    args.push("--filter", filterId);
  }
  if (pickKey) {
    args.push("--pick", pickKey);
  }
  if (envFile) {
    args.push("--env-file", envFile);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a JSON value for display — pretty-print if small enough, truncate if large.
 */
export function formatJson(value: unknown, maxLen = 2000): string {
  if (value === undefined || value === null) {
    return "";
  }
  try {
    const str = JSON.stringify(value, null, 2);
    if (str.length > maxLen) {
      return str.slice(0, maxLen) + "\n... (truncated)";
    }
    return str;
  } catch {
    return String(value);
  }
}

/**
 * Format headers as a readable block.
 */
export function formatHeaders(
  headers: Record<string, string> | undefined,
): string {
  if (!headers || Object.keys(headers).length === 0) {
    return "";
  }
  return Object.entries(headers)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
}

/**
 * Format a single trace event into a multi-line string with full HTTP details.
 */
export function formatTraceEvent(data: Record<string, unknown>): string {
  const method = data.method ?? "???";
  const url = data.url ?? "";
  const status = data.status ?? "";
  const duration = data.duration ?? "";
  const name = data.name ? ` (${data.name})` : "";

  const lines: string[] = [];
  lines.push(`── HTTP ${method} ${url}${name} → ${status} (${duration}ms)`);

  const reqHeaders = data.requestHeaders as Record<string, string> | undefined;
  const resHeaders = data.responseHeaders as Record<string, string> | undefined;
  const reqBody = data.requestBody;
  const resBody = data.responseBody;

  if (reqHeaders && Object.keys(reqHeaders).length > 0) {
    lines.push("  Request Headers:");
    lines.push(formatHeaders(reqHeaders));
  }
  if (reqBody !== undefined) {
    lines.push("  Request Body:");
    lines.push("  " + formatJson(reqBody).replace(/\n/g, "\n  "));
  }
  if (resHeaders && Object.keys(resHeaders).length > 0) {
    lines.push("  Response Headers:");
    lines.push(formatHeaders(resHeaders));
  }
  if (resBody !== undefined) {
    lines.push("  Response Body:");
    lines.push("  " + formatJson(resBody).replace(/\n/g, "\n  "));
  }

  return lines.join("\n");
}

/**
 * Build a structured output block from all events for a test, suitable for
 * the Test Results "message" area. Includes logs, HTTP traces, assertions, etc.
 */
export function buildEventsSummary(events: GlubeanEvent[]): string {
  const lines: string[] = [];

  for (const event of events) {
    switch (event.type) {
      case "log": {
        const dataStr =
          event.data !== undefined ? " " + formatJson(event.data, 500) : "";
        lines.push(`[LOG] ${event.message ?? ""}${dataStr}`);
        break;
      }
      case "trace": {
        const traceData = (event.data ?? {}) as Record<string, unknown>;
        lines.push(formatTraceEvent(traceData));
        break;
      }
      case "assertion": {
        const icon = event.passed ? "✓" : "✗";
        lines.push(`[ASSERT ${icon}] ${event.message ?? ""}`);
        if (!event.passed) {
          if (event.expected !== undefined) {
            lines.push(`  Expected: ${formatJson(event.expected, 500)}`);
          }
          if (event.actual !== undefined) {
            lines.push(`  Actual:   ${formatJson(event.actual, 500)}`);
          }
        }
        break;
      }
      case "warning": {
        lines.push(`[WARN] ${event.message ?? ""}`);
        break;
      }
      case "schema_validation": {
        const ev = event as unknown as Record<string, unknown>;
        const label = ev.label ?? "";
        const success = ev.success ? "✓" : "✗";
        lines.push(`[SCHEMA ${success}] ${label}`);
        const issues = ev.issues as
          | Array<{ message: string; path?: Array<string | number> }>
          | undefined;
        if (issues && issues.length > 0) {
          for (const issue of issues) {
            const p = issue.path ? ` @ ${issue.path.join(".")}` : "";
            lines.push(`  - ${issue.message}${p}`);
          }
        }
        break;
      }
      case "metric": {
        const ev = event as unknown as Record<string, unknown>;
        const unit = ev.unit ? ` ${ev.unit}` : "";
        lines.push(`[METRIC] ${ev.name}: ${ev.value}${unit}`);
        break;
      }
      case "step_start": {
        lines.push(
          `\n━━ Step ${(event.index ?? 0) + 1}/${event.total ?? "?"}: ${
            event.name ?? ""
          } ━━`,
        );
        break;
      }
      case "step_end": {
        const ev = event as unknown as Record<string, unknown>;
        const st = ev.status ?? "unknown";
        const dur = ev.durationMs ? ` (${ev.durationMs}ms)` : "";
        lines.push(`━━ Step done: ${st}${dur}`);
        if (ev.returnState !== undefined) {
          lines.push(`  → return: ${formatJson(ev.returnState, 1000)}`);
        }
        break;
      }
      case "error": {
        lines.push(`[ERROR] ${event.message ?? ""}`);
        break;
      }
      case "status": {
        if (event.error) {
          lines.push(`[STATUS] ${event.status ?? "failed"}: ${event.error}`);
        }
        break;
      }
      default:
        break;
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// cURL generation
// ---------------------------------------------------------------------------

/**
 * Convert a trace request/response pair into a cURL command string.
 */
export function tracePairToCurl(pair: TracePair): string {
  const req = pair.request;
  const parts: string[] = ["curl"];

  // Method
  if (req.method && req.method.toUpperCase() !== "GET") {
    parts.push(`-X ${req.method.toUpperCase()}`);
  }

  // URL
  parts.push(`'${req.url}'`);

  // Headers
  if (req.headers) {
    for (const [key, value] of Object.entries(req.headers)) {
      parts.push(`-H '${key}: ${value}'`);
    }
  }

  // Body
  if (req.body !== undefined) {
    const bodyStr =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    parts.push(`-d '${bodyStr}'`);
  }

  return parts.join(" \\\n  ");
}
