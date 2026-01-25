/**
 * Worker configuration management.
 *
 * Loads configuration from environment variables or config file.
 * Fail-fast on missing required values.
 */

/**
 * Configuration for a Glubean worker.
 */
export interface WorkerConfig {
  /** Base URL of the ControlPlane API. */
  controlPlaneUrl: string;

  /** Worker authentication token (from team settings). */
  workerToken: string;

  /** Unique identifier for this worker instance. */
  workerId: string;

  /** Timeout for ControlPlane requests (ms). */
  controlPlaneTimeoutMs: number;

  /** Max retries for idempotent ControlPlane requests. */
  controlPlaneMaxRetries: number;

  /** Interval between claim attempts when idle (ms). */
  claimIntervalMs: number;

  /** Heartbeat interval (ms). Should be < lease duration / 3. */
  heartbeatIntervalMs: number;

  /** Long-poll duration for claim requests (ms). 0 = no long-poll. */
  longPollMs: number;

  /** Log level. */
  logLevel: "debug" | "info" | "warn" | "error";

  /** Directory for temporary bundle downloads. */
  workDir: string;

  /** Timeout for bundle downloads (ms). */
  downloadTimeoutMs: number;

  /** Allowed network hosts for test execution (comma-separated or "*"). */
  allowNet: string;

  /** Timeout for test execution (ms). */
  executionTimeoutMs: number;

  /** Max concurrency for test execution. */
  executionConcurrency: number;

  /** Stop executing remaining tests after first failure. */
  stopOnFailure: boolean;

  /** Interval between event flush attempts (ms). */
  eventFlushIntervalMs: number;

  /** Flush immediately when buffered event count reaches this number. */
  eventFlushMaxBuffer: number;

  /** Hard cap on buffered events to prevent unbounded memory growth. */
  eventMaxBuffer: number;

  /** Maximum consecutive flush failures before aborting execution. */
  eventFlushMaxConsecutiveFailures: number;

  /** Tags for task matching (e.g., ["tier:pro", "team:acme"]). */
  tags: string[];

  /** Max concurrent tasks per worker. Default: 1. */
  maxConcurrentTasks: number;

  /** Memory limit per task in bytes (0 = no limit). Default: 0. */
  taskMemoryLimitBytes: number;

  /** Interval for memory monitoring in ms. Default: 2000. */
  memoryCheckIntervalMs: number;

  /**
   * Default path for secrets file.
   * Used when job doesn't specify secretsPath and GLUBEAN_SECRETS_PATH is not set.
   * Secrets are loaded locally and never transmitted over the network.
   */
  defaultSecretsPath?: string;
}

/**
 * Error thrown when configuration is invalid.
 */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * Environment variable names.
 */
export const ENV_VARS = {
  CONTROL_PLANE_URL: "GLUBEAN_CONTROL_PLANE_URL",
  WORKER_TOKEN: "GLUBEAN_WORKER_TOKEN",
  WORKER_ID: "GLUBEAN_WORKER_ID",
  WORKER_TAGS: "GLUBEAN_WORKER_TAGS",
  CONTROL_PLANE_TIMEOUT_MS: "GLUBEAN_CONTROL_PLANE_TIMEOUT_MS",
  CONTROL_PLANE_MAX_RETRIES: "GLUBEAN_CONTROL_PLANE_MAX_RETRIES",
  CLAIM_INTERVAL_MS: "GLUBEAN_CLAIM_INTERVAL_MS",
  HEARTBEAT_INTERVAL_MS: "GLUBEAN_HEARTBEAT_INTERVAL_MS",
  LONG_POLL_MS: "GLUBEAN_LONG_POLL_MS",
  LOG_LEVEL: "GLUBEAN_LOG_LEVEL",
  WORK_DIR: "GLUBEAN_WORK_DIR",
  DOWNLOAD_TIMEOUT_MS: "GLUBEAN_DOWNLOAD_TIMEOUT_MS",
  ALLOW_NET: "GLUBEAN_ALLOW_NET",
  EXECUTION_TIMEOUT_MS: "GLUBEAN_EXECUTION_TIMEOUT_MS",
  EXECUTION_CONCURRENCY: "GLUBEAN_EXECUTION_CONCURRENCY",
  STOP_ON_FAILURE: "GLUBEAN_STOP_ON_FAILURE",
  EVENT_FLUSH_INTERVAL_MS: "GLUBEAN_EVENT_FLUSH_INTERVAL_MS",
  EVENT_FLUSH_MAX_BUFFER: "GLUBEAN_EVENT_FLUSH_MAX_BUFFER",
  EVENT_MAX_BUFFER: "GLUBEAN_EVENT_MAX_BUFFER",
  EVENT_FLUSH_MAX_CONSECUTIVE_FAILURES:
    "GLUBEAN_EVENT_FLUSH_MAX_CONSECUTIVE_FAILURES",
  MAX_CONCURRENT_TASKS: "GLUBEAN_MAX_CONCURRENT_TASKS",
  TASK_MEMORY_LIMIT_MB: "GLUBEAN_TASK_MEMORY_LIMIT_MB",
  MEMORY_CHECK_INTERVAL_MS: "GLUBEAN_MEMORY_CHECK_INTERVAL_MS",
  SECRETS_PATH: "GLUBEAN_SECRETS_PATH",
  DEFAULT_SECRETS_PATH: "GLUBEAN_DEFAULT_SECRETS_PATH",
} as const;

/**
 * Load configuration from environment variables.
 *
 * @throws ConfigError if required values are missing
 */
export function loadConfig(): WorkerConfig {
  const get = (key: string): string | undefined => Deno.env.get(key);

  const require = (key: string): string => {
    const value = get(key);
    if (!value) {
      throw new ConfigError(`Missing required environment variable: ${key}`);
    }
    return value;
  };

  const getInt = (key: string, defaultValue: number): number => {
    const value = get(key);
    if (!value) return defaultValue;
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
      throw new ConfigError(
        `Invalid integer for ${key}: ${value}`,
      );
    }
    return parsed;
  };

  const getBool = (key: string, defaultValue: boolean): boolean => {
    const value = get(key);
    if (!value) return defaultValue;
    return value.toLowerCase() === "true" || value === "1";
  };

  const logLevel = (get(ENV_VARS.LOG_LEVEL) || "info") as WorkerConfig["logLevel"];
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    throw new ConfigError(
      `Invalid log level: ${logLevel}. Must be one of: debug, info, warn, error`,
    );
  }

  // Generate default worker ID from hostname + random suffix
  const defaultWorkerId = `worker-${crypto.randomUUID().slice(0, 8)}`;

  return {
    controlPlaneUrl: require(ENV_VARS.CONTROL_PLANE_URL),
    workerToken: require(ENV_VARS.WORKER_TOKEN),
    workerId: get(ENV_VARS.WORKER_ID) || defaultWorkerId,
    controlPlaneTimeoutMs: getInt(ENV_VARS.CONTROL_PLANE_TIMEOUT_MS, 30_000),
    controlPlaneMaxRetries: getInt(ENV_VARS.CONTROL_PLANE_MAX_RETRIES, 3),
    claimIntervalMs: getInt(ENV_VARS.CLAIM_INTERVAL_MS, 5_000),
    heartbeatIntervalMs: getInt(ENV_VARS.HEARTBEAT_INTERVAL_MS, 10_000),
    longPollMs: getInt(ENV_VARS.LONG_POLL_MS, 30_000),
    logLevel,
    workDir: get(ENV_VARS.WORK_DIR) || Deno.makeTempDirSync({ prefix: "glubean-" }),
    downloadTimeoutMs: getInt(ENV_VARS.DOWNLOAD_TIMEOUT_MS, 60_000),
    allowNet: get(ENV_VARS.ALLOW_NET) || "*",
    executionTimeoutMs: getInt(ENV_VARS.EXECUTION_TIMEOUT_MS, 300_000),
    executionConcurrency: getInt(ENV_VARS.EXECUTION_CONCURRENCY, 1),
    stopOnFailure: getBool(ENV_VARS.STOP_ON_FAILURE, false),
    eventFlushIntervalMs: getInt(ENV_VARS.EVENT_FLUSH_INTERVAL_MS, 1_000),
    eventFlushMaxBuffer: getInt(ENV_VARS.EVENT_FLUSH_MAX_BUFFER, 50),
    eventMaxBuffer: getInt(ENV_VARS.EVENT_MAX_BUFFER, 10_000),
    eventFlushMaxConsecutiveFailures: getInt(
      ENV_VARS.EVENT_FLUSH_MAX_CONSECUTIVE_FAILURES,
      5,
    ),
    tags: (get(ENV_VARS.WORKER_TAGS) || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    maxConcurrentTasks: getInt(ENV_VARS.MAX_CONCURRENT_TASKS, 1),
    taskMemoryLimitBytes: getInt(ENV_VARS.TASK_MEMORY_LIMIT_MB, 0) * 1024 * 1024,
    memoryCheckIntervalMs: getInt(ENV_VARS.MEMORY_CHECK_INTERVAL_MS, 2000),
    defaultSecretsPath: get(ENV_VARS.DEFAULT_SECRETS_PATH),
  };
}

/**
 * Configuration file format (JSON).
 */
export interface ConfigFile {
  controlPlaneUrl?: string;
  workerToken?: string;
  workerId?: string;
  logLevel?: "debug" | "info" | "warn" | "error";
  allowNet?: string;
  executionTimeoutMs?: number;
  executionConcurrency?: number;
  stopOnFailure?: boolean;
  /** Tags for task matching (e.g., ["tier:pro", "team:acme"]). */
  tags?: string[];
  /** Max concurrent tasks per worker. */
  maxConcurrentTasks?: number;
  /** Memory limit per task in MB. */
  taskMemoryLimitMb?: number;
}

/**
 * Load configuration from a JSON file and merge with environment variables.
 * Environment variables take precedence.
 */
export async function loadConfigFromFile(
  filePath: string,
): Promise<WorkerConfig> {
  let fileConfig: ConfigFile = {};

  try {
    const content = await Deno.readTextFile(filePath);
    fileConfig = JSON.parse(content) as ConfigFile;
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw new ConfigError(`Failed to read config file: ${err}`);
    }
  }

  // Set environment variables from file (if not already set)
  if (fileConfig.controlPlaneUrl && !Deno.env.get(ENV_VARS.CONTROL_PLANE_URL)) {
    Deno.env.set(ENV_VARS.CONTROL_PLANE_URL, fileConfig.controlPlaneUrl);
  }
  if (fileConfig.workerToken && !Deno.env.get(ENV_VARS.WORKER_TOKEN)) {
    Deno.env.set(ENV_VARS.WORKER_TOKEN, fileConfig.workerToken);
  }
  if (fileConfig.workerId && !Deno.env.get(ENV_VARS.WORKER_ID)) {
    Deno.env.set(ENV_VARS.WORKER_ID, fileConfig.workerId);
  }
  if (fileConfig.logLevel && !Deno.env.get(ENV_VARS.LOG_LEVEL)) {
    Deno.env.set(ENV_VARS.LOG_LEVEL, fileConfig.logLevel);
  }
  if (fileConfig.allowNet && !Deno.env.get(ENV_VARS.ALLOW_NET)) {
    Deno.env.set(ENV_VARS.ALLOW_NET, fileConfig.allowNet);
  }
  if (
    fileConfig.executionTimeoutMs !== undefined &&
    !Deno.env.get(ENV_VARS.EXECUTION_TIMEOUT_MS)
  ) {
    Deno.env.set(
      ENV_VARS.EXECUTION_TIMEOUT_MS,
      String(fileConfig.executionTimeoutMs),
    );
  }
  if (
    fileConfig.executionConcurrency !== undefined &&
    !Deno.env.get(ENV_VARS.EXECUTION_CONCURRENCY)
  ) {
    Deno.env.set(
      ENV_VARS.EXECUTION_CONCURRENCY,
      String(fileConfig.executionConcurrency),
    );
  }
  if (
    fileConfig.stopOnFailure !== undefined &&
    !Deno.env.get(ENV_VARS.STOP_ON_FAILURE)
  ) {
    Deno.env.set(ENV_VARS.STOP_ON_FAILURE, String(fileConfig.stopOnFailure));
  }
  if (fileConfig.tags?.length && !Deno.env.get(ENV_VARS.WORKER_TAGS)) {
    Deno.env.set(ENV_VARS.WORKER_TAGS, fileConfig.tags.join(","));
  }
  if (
    fileConfig.maxConcurrentTasks !== undefined &&
    !Deno.env.get(ENV_VARS.MAX_CONCURRENT_TASKS)
  ) {
    Deno.env.set(
      ENV_VARS.MAX_CONCURRENT_TASKS,
      String(fileConfig.maxConcurrentTasks),
    );
  }
  if (
    fileConfig.taskMemoryLimitMb !== undefined &&
    !Deno.env.get(ENV_VARS.TASK_MEMORY_LIMIT_MB)
  ) {
    Deno.env.set(
      ENV_VARS.TASK_MEMORY_LIMIT_MB,
      String(fileConfig.taskMemoryLimitMb),
    );
  }

  return loadConfig();
}
