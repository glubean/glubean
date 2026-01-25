#!/usr/bin/env -S deno run -A
/**
 * Glubean Worker CLI
 *
 * Self-hosted test execution agent that connects to Glubean ControlPlane.
 *
 * Usage:
 *   deno run -A cli.ts [options]
 *   glubean-worker [options]  # If installed via deno install
 *
 * Options:
 *   --config <path>  Path to config file (JSON)
 *   --help           Show this help message
 *
 * Environment variables:
 *   GLUBEAN_CONTROL_PLANE_URL  (required) Control plane API URL
 *   GLUBEAN_WORKER_TOKEN       (required) Worker authentication token
 *   GLUBEAN_WORKER_ID          Worker identifier (auto-generated if not set)
 *   GLUBEAN_LOG_LEVEL          Log level (debug, info, warn, error)
 *   GLUBEAN_ALLOW_NET          Allowed network hosts (* for all)
 *
 * @example
 * # Using environment variables
 * export GLUBEAN_CONTROL_PLANE_URL=https://api.glubean.com
 * export GLUBEAN_WORKER_TOKEN=gwt_xxx
 * deno run -A cli.ts
 *
 * @example
 * # Using config file
 * deno run -A cli.ts --config ./worker.json
 */

import { loadConfig, loadConfigFromFile, ConfigError } from "./config.ts";
import { createLogger } from "./logger.ts";
import { ControlPlaneClient } from "./client.ts";
import { runWorker } from "./loop.ts";

const VERSION = "0.1.0";

function printHelp(): void {
  console.log(`
Glubean Worker v${VERSION}
Self-hosted test execution agent

USAGE:
  glubean-worker [options]
  deno run -A cli.ts [options]

OPTIONS:
  --config <path>    Path to config file (JSON)
  --version          Show version
  --help             Show this help message

ENVIRONMENT VARIABLES:
  GLUBEAN_CONTROL_PLANE_URL   (required) Control plane API URL
  GLUBEAN_WORKER_TOKEN        (required) Worker authentication token
  GLUBEAN_WORKER_ID           Worker identifier
  GLUBEAN_LOG_LEVEL           Log level (debug, info, warn, error)
  GLUBEAN_ALLOW_NET           Allowed network hosts (* for all)
  GLUBEAN_EXECUTION_TIMEOUT_MS    Test execution timeout
  GLUBEAN_EXECUTION_CONCURRENCY   Max parallel test execution

EXAMPLES:
  # Using environment variables
  export GLUBEAN_CONTROL_PLANE_URL=https://api.glubean.com
  export GLUBEAN_WORKER_TOKEN=gwt_xxx
  glubean-worker

  # Using config file
  glubean-worker --config ./worker.json

CONFIG FILE FORMAT:
  {
    "controlPlaneUrl": "https://api.glubean.com",
    "workerToken": "gwt_xxx",
    "workerId": "my-worker",
    "logLevel": "info",
    "allowNet": "*"
  }
`);
}

function printVersion(): void {
  console.log(`glubean-worker v${VERSION}`);
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args);

  if (args.help) {
    printHelp();
    Deno.exit(0);
  }

  if (args.version) {
    printVersion();
    Deno.exit(0);
  }

  // Load configuration
  let config;
  try {
    if (args.config) {
      config = await loadConfigFromFile(args.config);
    } else {
      config = loadConfig();
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[FATAL] ${err.message}`);
      Deno.exit(1);
    }
    throw err;
  }

  // Initialize logger
  const logger = createLogger(config);
  logger.info("Worker initializing", {
    version: VERSION,
    workerId: config.workerId,
  });

  // Initialize ControlPlane client
  const client = new ControlPlaneClient({
    baseUrl: config.controlPlaneUrl,
    workerToken: config.workerToken,
    timeoutMs: config.controlPlaneTimeoutMs,
    maxRetries: config.controlPlaneMaxRetries,
  });

  // Run the worker loop (daemon mode) until shutdown
  const abort = new AbortController();

  // Handle graceful shutdown
  const handleShutdown = (signal: string) => {
    logger.info("Received shutdown signal", { signal });
    abort.abort();

    // Give some time for graceful shutdown, then force exit
    setTimeout(() => {
      logger.warn("Forcing exit after timeout");
      Deno.exit(0);
    }, 10_000);
  };

  // Register signal handlers
  try {
    Deno.addSignalListener("SIGTERM", () => handleShutdown("SIGTERM"));
    Deno.addSignalListener("SIGINT", () => handleShutdown("SIGINT"));
  } catch {
    // Signal listeners may not be supported on all platforms
    logger.warn("Signal listeners not supported on this platform");
  }

  logger.info("Worker started");

  await runWorker({
    config,
    client,
    logger,
    lifecycle: { mode: "daemon" },
    signal: abort.signal,
  });
}

interface Args {
  config?: string;
  help: boolean;
  version: boolean;
}

function parseArgs(args: string[]): Args {
  const result: Args = {
    help: false,
    version: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--version" || arg === "-v") {
      result.version = true;
    } else if (arg === "--config" || arg === "-c") {
      result.config = args[++i];
      if (!result.config) {
        console.error("Error: --config requires a path argument");
        Deno.exit(1);
      }
    } else if (arg.startsWith("--config=")) {
      result.config = arg.slice("--config=".length);
    } else if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}`);
      console.error("Use --help for usage information");
      Deno.exit(1);
    }
  }

  return result;
}

// Run
if (import.meta.main) {
  main().catch((err) => {
    console.error("[FATAL] Unhandled error:", err);
    Deno.exit(1);
  });
}
