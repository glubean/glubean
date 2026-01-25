/**
 * Trigger command - triggers a remote run on Glubean Cloud.
 *
 * Usage:
 *   glubean trigger --project <id>              # Uses latest bundle
 *   glubean trigger --project <id> --bundle <id>  # Uses specific bundle
 *   glubean trigger --project <id> --follow     # Tail logs until complete
 */

import { DEFAULT_API_URL } from "../lib/constants.ts";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

export interface TriggerOptions {
  /** Project ID (required) */
  project?: string;
  /** Bundle ID (optional, uses latest if not specified) */
  bundle?: string;
  /** Job ID (optional) */
  job?: string;
  /** API server URL */
  apiUrl?: string;
  /** Auth token */
  token?: string;
  /** Follow logs until run completes */
  follow?: boolean;
}

interface CreateRunResponse {
  runId: string;
  taskId: string;
  bundleId: string;
}

interface RunStatus {
  runId: string;
  status: string;
  projectId: string;
  bundleId: string;
  summary?: {
    passed?: number;
    failed?: number;
    skipped?: number;
    total?: number;
    durationMs?: number;
  };
}

interface RunEvent {
  seq: number;
  type: string;
  timestamp: string;
  message?: string;
  data?: unknown;
  passed?: boolean;
  actual?: unknown;
  expected?: unknown;
}

interface GetEventsResponse {
  events: RunEvent[];
  nextCursor?: number;
  hasMore: boolean;
}

/**
 * Create a run via the API.
 */
async function createRun(
  projectId: string,
  apiUrl: string,
  token?: string,
  bundleId?: string,
  jobId?: string
): Promise<CreateRunResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const body: Record<string, string> = { projectId };
  if (bundleId) body.bundleId = bundleId;
  if (jobId) body.jobId = jobId;

  const response = await fetch(`${apiUrl}/data-plane/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create run: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * Get run status.
 */
async function getRunStatus(
  runId: string,
  apiUrl: string,
  token?: string
): Promise<RunStatus> {
  const headers: Record<string, string> = {};

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(`${apiUrl}/data-plane/runs/${runId}`, {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get run status: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * Get run events with cursor-based pagination.
 */
async function getRunEvents(
  runId: string,
  apiUrl: string,
  token?: string,
  afterSeq?: number
): Promise<GetEventsResponse> {
  const headers: Record<string, string> = {};

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const params = new URLSearchParams();
  if (afterSeq !== undefined) {
    params.set("afterSeq", String(afterSeq));
  }
  params.set("limit", "100");

  const url = `${apiUrl}/data-plane/runs/${runId}/events?${params.toString()}`;
  const response = await fetch(url, {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get run events: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * Format an event for console output.
 */
function formatEvent(event: RunEvent): string | null {
  switch (event.type) {
    case "log":
      return `${colors.dim}${event.message}${colors.reset}`;
    case "assertion": {
      const icon = event.passed
        ? `${colors.green}✓${colors.reset}`
        : `${colors.red}✗${colors.reset}`;
      let line = `${icon} ${event.message}`;
      if (
        !event.passed &&
        (event.expected !== undefined || event.actual !== undefined)
      ) {
        if (event.expected !== undefined) {
          line += `\n    ${colors.dim}Expected: ${JSON.stringify(
            event.expected
          )}${colors.reset}`;
        }
        if (event.actual !== undefined) {
          line += `\n    ${colors.dim}Actual:   ${JSON.stringify(
            event.actual
          )}${colors.reset}`;
        }
      }
      return line;
    }
    case "trace": {
      const data = event.data as
        | { method?: string; url?: string; status?: number; duration?: number }
        | undefined;
      if (data) {
        return `${colors.cyan}→ ${data.method} ${data.url} → ${data.status} (${data.duration}ms)${colors.reset}`;
      }
      return null;
    }
    case "step_start":
      return `${colors.blue}▶ ${event.message || "Step started"}${
        colors.reset
      }`;
    case "step_end":
      return `${colors.blue}◼ ${event.message || "Step ended"}${colors.reset}`;
    case "error":
      return `${colors.red}✗ Error: ${event.message}${colors.reset}`;
    default:
      return null; // Skip other event types
  }
}

/**
 * Tail run events until the run completes.
 */
async function tailEvents(
  runId: string,
  apiUrl: string,
  token?: string
): Promise<RunStatus> {
  let cursor: number | undefined = undefined;
  const terminalStatuses = ["passed", "failed", "cancelled", "exhausted"];
  let lastStatus = "running";

  while (true) {
    // Get new events
    try {
      const { events, nextCursor } = await getRunEvents(
        runId,
        apiUrl,
        token,
        cursor
      );

      for (const event of events) {
        const formatted = formatEvent(event);
        if (formatted) {
          console.log(`  ${formatted}`);
        }
      }

      if (nextCursor !== undefined) {
        cursor = nextCursor;
      }
    } catch (err) {
      // Ignore transient errors during polling
      console.log(`${colors.dim}  (polling...)${colors.reset}`);
    }

    // Check run status
    const status = await getRunStatus(runId, apiUrl, token);
    lastStatus = status.status;

    if (terminalStatuses.includes(status.status)) {
      return status;
    }

    // Wait before polling again
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

export async function triggerCommand(
  options: TriggerOptions = {}
): Promise<void> {
  console.log(
    `\n${colors.bold}${colors.blue}🚀 Glubean Trigger${colors.reset}\n`
  );

  // Validate options
  if (!options.project) {
    console.log(`${colors.red}✗ Error: --project is required${colors.reset}`);
    console.log(
      `${colors.dim}  Usage: glubean trigger --project <project-id>${colors.reset}\n`
    );
    Deno.exit(1);
  }

  const apiUrl = (
    options.apiUrl ||
    Deno.env.get("GLUBEAN_API_URL") ||
    DEFAULT_API_URL
  ).replace(/\/$/, "");
  const appUrl = apiUrl.replace("api.", "app.").replace(/\/$/, "");
  const token = options.token || Deno.env.get("GLUBEAN_TOKEN");

  console.log(`${colors.dim}Project: ${colors.reset}${options.project}`);
  if (options.bundle) {
    console.log(`${colors.dim}Bundle:  ${colors.reset}${options.bundle}`);
  } else {
    console.log(`${colors.dim}Bundle:  ${colors.reset}(latest)`);
  }
  if (options.job) {
    console.log(`${colors.dim}Job:     ${colors.reset}${options.job}`);
  }
  console.log();

  try {
    // Create the run
    console.log(`${colors.cyan}→ Creating run...${colors.reset}`);
    const result = await createRun(
      options.project,
      apiUrl,
      token,
      options.bundle,
      options.job
    );

    console.log(`${colors.green}✓ Run created${colors.reset}`);
    console.log(`${colors.dim}  Run ID:    ${colors.reset}${result.runId}`);
    console.log(`${colors.dim}  Bundle ID: ${colors.reset}${result.bundleId}`);
    console.log();

    // Print the web UI URL
    const runUrl = `${appUrl}/runs/${result.runId}`;
    console.log(`${colors.bold}View in browser:${colors.reset}`);
    console.log(`  ${colors.cyan}${runUrl}${colors.reset}`);
    console.log();

    // If follow mode, tail the logs
    if (options.follow) {
      console.log(`${colors.bold}Live output:${colors.reset}`);
      console.log(
        `${colors.dim}─────────────────────────────────────${colors.reset}`
      );

      const finalStatus = await tailEvents(result.runId, apiUrl, token);

      console.log(
        `${colors.dim}─────────────────────────────────────${colors.reset}`
      );
      console.log();

      // Print summary
      const statusColor =
        finalStatus.status === "passed" ? colors.green : colors.red;
      console.log(
        `${colors.bold}Result:${
          colors.reset
        } ${statusColor}${finalStatus.status.toUpperCase()}${colors.reset}`
      );

      if (finalStatus.summary) {
        const s = finalStatus.summary;
        const parts = [];
        if (s.passed !== undefined)
          parts.push(`${colors.green}${s.passed} passed${colors.reset}`);
        if (s.failed !== undefined)
          parts.push(`${colors.red}${s.failed} failed${colors.reset}`);
        if (s.skipped !== undefined)
          parts.push(`${colors.yellow}${s.skipped} skipped${colors.reset}`);
        if (parts.length > 0) {
          console.log(
            `${colors.bold}Tests:${colors.reset}  ${parts.join(", ")}`
          );
        }
        if (s.durationMs !== undefined) {
          console.log(`${colors.bold}Time:${colors.reset}   ${s.durationMs}ms`);
        }
      }
      console.log();

      // Exit with appropriate code
      if (finalStatus.status !== "passed") {
        Deno.exit(1);
      }
    } else {
      console.log(
        `${colors.dim}Tip: Use --follow to tail logs in real-time${colors.reset}\n`
      );
    }
  } catch (error) {
    console.log(
      `${colors.red}✗ ${error instanceof Error ? error.message : error}${
        colors.reset
      }`
    );
    Deno.exit(1);
  }
}
