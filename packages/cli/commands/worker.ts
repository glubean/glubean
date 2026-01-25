/**
 * Worker command - start self-hosted worker instances.
 *
 * @example
 * // Start single worker (default)
 * glubean worker start
 *
 * // Start 4 worker instances
 * glubean worker start --instances 4
 *
 * // Auto-detect CPU count
 * glubean worker start --instances auto
 *
 * // With config file
 * glubean worker start --config worker.json --instances 4
 */

export interface WorkerStartOptions {
  /** Number of worker instances to start. "auto" = CPU count. Default: 1 */
  instances?: number | "auto";
  /** Path to worker config file (JSON) */
  config?: string;
  /** Control plane URL (overrides config/env) */
  apiUrl?: string;
  /** Worker token (overrides config/env) */
  token?: string;
  /** Log level */
  logLevel?: string;
  /** Base worker ID (instances will be suffixed with -1, -2, etc.) */
  workerId?: string;
}

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

/**
 * Main worker command handler.
 */
export async function workerCommand(
  subcommand: string | undefined,
  options: WorkerStartOptions
): Promise<void> {
  // Default subcommand is "start"
  const cmd = subcommand || "start";

  switch (cmd) {
    case "start":
      await startWorker(options);
      break;
    case "help":
      printWorkerHelp();
      break;
    default:
      console.error(`Unknown worker subcommand: ${cmd}`);
      console.error('Run "glubean worker help" for usage.');
      Deno.exit(1);
  }
}

function printWorkerHelp(): void {
  console.log(`
${colors.bold}${colors.cyan}glubean worker${colors.reset} - Self-hosted worker management

${colors.bold}Usage:${colors.reset}
  glubean worker start [options]

${colors.bold}Options:${colors.reset}
  --instances, -n <N|auto>  Number of worker instances (default: 1)
                            Use "auto" to match CPU core count
  --config <path>           Worker config file (JSON)
  --api-url <url>           Control plane URL
  --token <token>           Worker token (or GLUBEAN_WORKER_TOKEN env)
  --log-level <level>       Log level (debug, info, warn, error)
  --worker-id <id>          Base worker ID (auto-generated if not set)

${colors.bold}Examples:${colors.reset}
  ${colors.dim}# Start single worker (default)${colors.reset}
  glubean worker start

  ${colors.dim}# Start 4 worker instances${colors.reset}
  glubean worker start -n 4

  ${colors.dim}# Auto-detect CPU count${colors.reset}
  glubean worker start --instances auto

  ${colors.dim}# With config file${colors.reset}
  glubean worker start --config worker.json -n 4

${colors.bold}Environment Variables:${colors.reset}
  GLUBEAN_CONTROL_PLANE_URL   Control plane API URL
  GLUBEAN_WORKER_TOKEN        Worker authentication token
  GLUBEAN_WORKER_ID           Worker identifier
  GLUBEAN_LOG_LEVEL           Log level

${colors.bold}Notes:${colors.reset}
  - Each instance runs as a separate process
  - Instance IDs are suffixed: worker-id-1, worker-id-2, etc.
  - Use Ctrl+C for graceful shutdown of all instances
`);
}

/**
 * Resolve the number of instances to start.
 */
function resolveInstanceCount(value?: number | "auto"): number {
  if (value === undefined) return 1;
  if (value === "auto") {
    const cpuCount = navigator.hardwareConcurrency || 4;
    return cpuCount;
  }
  if (typeof value === "number" && value >= 1) {
    return Math.floor(value);
  }
  return 1;
}

/**
 * Generate a base worker ID if not provided.
 */
function generateWorkerId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6);
  return `worker-${timestamp}-${random}`;
}

/**
 * Start worker instance(s).
 */
async function startWorker(options: WorkerStartOptions): Promise<void> {
  const instanceCount = resolveInstanceCount(options.instances);
  const baseWorkerId = options.workerId || generateWorkerId();

  console.log(
    `${colors.bold}Starting ${instanceCount} worker instance(s)...${colors.reset}`
  );

  if (instanceCount === 1) {
    // Single instance: run directly in current process
    await runSingleWorker(baseWorkerId, options);
  } else {
    // Multiple instances: spawn child processes
    await runWorkerCluster(instanceCount, baseWorkerId, options);
  }
}

/**
 * Run a single worker in the current process.
 * Imports and runs the worker directly for simpler single-instance usage.
 */
async function runSingleWorker(
  workerId: string,
  options: WorkerStartOptions
): Promise<void> {
  // Set environment variables from options
  if (options.apiUrl) {
    Deno.env.set("GLUBEAN_CONTROL_PLANE_URL", options.apiUrl);
  }
  if (options.token) {
    Deno.env.set("GLUBEAN_WORKER_TOKEN", options.token);
  }
  if (options.logLevel) {
    Deno.env.set("GLUBEAN_LOG_LEVEL", options.logLevel);
  }
  Deno.env.set("GLUBEAN_WORKER_ID", workerId);

  console.log(`  ${colors.green}▶${colors.reset} Instance: ${workerId}`);

  // Build args for worker CLI
  const args = ["run", "-A", "jsr:@glubean/worker/cli"];
  if (options.config) {
    args.push("--config", options.config);
  }

  // Run worker
  const cmd = new Deno.Command("deno", {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const proc = cmd.spawn();
  const status = await proc.status;

  if (!status.success) {
    Deno.exit(status.code);
  }
}

/**
 * Run multiple worker instances as child processes.
 */
async function runWorkerCluster(
  count: number,
  baseWorkerId: string,
  options: WorkerStartOptions
): Promise<void> {
  const processes: Deno.ChildProcess[] = [];
  const pids: number[] = [];

  // Build base environment
  const baseEnv: Record<string, string> = {
    ...Deno.env.toObject(),
  };
  if (options.apiUrl) {
    baseEnv.GLUBEAN_CONTROL_PLANE_URL = options.apiUrl;
  }
  if (options.token) {
    baseEnv.GLUBEAN_WORKER_TOKEN = options.token;
  }
  if (options.logLevel) {
    baseEnv.GLUBEAN_LOG_LEVEL = options.logLevel;
  }

  // Build base args
  const baseArgs = ["run", "-A", "jsr:@glubean/worker/cli"];
  if (options.config) {
    baseArgs.push("--config", options.config);
  }

  // Start instances
  for (let i = 1; i <= count; i++) {
    const workerId = `${baseWorkerId}-${i}`;

    const cmd = new Deno.Command("deno", {
      args: baseArgs,
      env: {
        ...baseEnv,
        GLUBEAN_WORKER_ID: workerId,
      },
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
    });

    const proc = cmd.spawn();
    processes.push(proc);
    pids.push(proc.pid);

    console.log(
      `  ${colors.green}▶${colors.reset} Instance ${i}: ${workerId} (pid: ${proc.pid})`
    );
  }

  console.log(
    `\n${colors.dim}Press Ctrl+C to stop all instances${colors.reset}\n`
  );

  // Track if we're shutting down
  let shuttingDown = false;

  // Graceful shutdown handler
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(
      `\n${colors.yellow}Shutting down ${count} workers...${colors.reset}`
    );

    for (const proc of processes) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // Process may have already exited
      }
    }
  };

  // Register signal handlers
  try {
    Deno.addSignalListener("SIGTERM", shutdown);
    Deno.addSignalListener("SIGINT", shutdown);
  } catch {
    // Signal listeners may not be supported on all platforms
  }

  // Wait for all processes to complete
  const results = await Promise.allSettled(processes.map((p) => p.status));

  // Report results
  let exitCode = 0;
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      const status = result.value;
      if (!status.success && status.code !== 0) {
        console.log(
          `  ${colors.yellow}⚠${colors.reset} Instance ${
            i + 1
          } exited with code ${status.code}`
        );
        exitCode = status.code;
      }
    } else {
      console.log(
        `  ${colors.yellow}⚠${colors.reset} Instance ${i + 1} error: ${
          result.reason
        }`
      );
      exitCode = 1;
    }
  }

  if (exitCode !== 0) {
    Deno.exit(exitCode);
  }
}
