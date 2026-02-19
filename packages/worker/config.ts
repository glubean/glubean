/**
 * Worker configuration management.
 *
 * Loads configuration from environment variables or config file.
 * Fail-fast on missing required values.
 */

import { WORKER_RUN_DEFAULTS } from "@glubean/runner";
import type { SharedRunConfig } from "@glubean/runner";

export type NetworkPolicyMode = "trusted" | "shared_serverless";

/**
 * Network guardrail configuration used by the runner harness.
 */
export interface WorkerNetworkPolicy {
  /** Trusted self-hosted mode or shared serverless mode. */
  mode: NetworkPolicyMode;
  /** Hard cap on total outbound requests per test execution. */
  maxRequests: number;
  /** Max in-flight outbound requests per test execution. */
  maxConcurrentRequests: number;
  /** Per-request timeout for outbound HTTP requests in milliseconds. */
  requestTimeoutMs: number;
  /** Approximate response-byte budget based on content-length headers. */
  maxResponseBytes: number;
  /** Allowed destination ports for outbound HTTP(S) requests. */
  allowedPorts: number[];
}

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

  /** Shared run config for test execution (permissions, timeout, concurrency, etc.). */
  run: SharedRunConfig;

  /**
   * Overall task deadline in ms (download + extract + run all tests).
   * Worker derives per-test timeout from this: floor(taskTimeoutMs * 0.9 / testCount).
   */
  taskTimeoutMs: number;

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

  /**
   * Network guardrails for outbound traffic from sandboxed test code.
   * In shared serverless mode, additional egress restrictions are enforced.
   */
  networkPolicy: WorkerNetworkPolicy;
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
  TASK_TIMEOUT_MS: "GLUBEAN_TASK_TIMEOUT_MS",
  FAIL_FAST: "GLUBEAN_FAIL_FAST",
  EXECUTION_CONCURRENCY: "GLUBEAN_EXECUTION_CONCURRENCY",
  EVENT_FLUSH_INTERVAL_MS: "GLUBEAN_EVENT_FLUSH_INTERVAL_MS",
  EVENT_FLUSH_MAX_BUFFER: "GLUBEAN_EVENT_FLUSH_MAX_BUFFER",
  EVENT_MAX_BUFFER: "GLUBEAN_EVENT_MAX_BUFFER",
  EVENT_FLUSH_MAX_CONSECUTIVE_FAILURES: "GLUBEAN_EVENT_FLUSH_MAX_CONSECUTIVE_FAILURES",
  MAX_CONCURRENT_TASKS: "GLUBEAN_MAX_CONCURRENT_TASKS",
  TASK_MEMORY_LIMIT_MB: "GLUBEAN_TASK_MEMORY_LIMIT_MB",
  MEMORY_CHECK_INTERVAL_MS: "GLUBEAN_MEMORY_CHECK_INTERVAL_MS",
  SECRETS_PATH: "GLUBEAN_SECRETS_PATH",
  DEFAULT_SECRETS_PATH: "GLUBEAN_DEFAULT_SECRETS_PATH",
  NETWORK_POLICY_MODE: "GLUBEAN_NETWORK_POLICY_MODE",
  EGRESS_MAX_REQUESTS: "GLUBEAN_EGRESS_MAX_REQUESTS",
  EGRESS_MAX_CONCURRENT_REQUESTS: "GLUBEAN_EGRESS_MAX_CONCURRENT_REQUESTS",
  EGRESS_REQUEST_TIMEOUT_MS: "GLUBEAN_EGRESS_REQUEST_TIMEOUT_MS",
  EGRESS_MAX_RESPONSE_BYTES: "GLUBEAN_EGRESS_MAX_RESPONSE_BYTES",
  EGRESS_ALLOWED_PORTS: "GLUBEAN_EGRESS_ALLOWED_PORTS",
} as const;

const LEGACY_ENV_RENAMES = {
  GLUBEAN_EXECUTION_TIMEOUT_MS: ENV_VARS.TASK_TIMEOUT_MS,
  GLUBEAN_STOP_ON_FAILURE: ENV_VARS.FAIL_FAST,
} as const;

const LEGACY_FILE_RENAMES = {
  executionTimeoutMs: "taskTimeoutMs",
  stopOnFailure: "failFast",
} as const;

function assertNoLegacyEnvVars(
  get: (key: string) => string | undefined,
): void {
  for (const [legacy, canonical] of Object.entries(LEGACY_ENV_RENAMES)) {
    if (get(legacy) !== undefined) {
      throw new ConfigError(
        `Legacy environment variable ${legacy} is no longer supported. Use ${canonical} instead.`,
      );
    }
  }
}

function assertNoLegacyFileKeys(
  fileConfig: Record<string, unknown>,
): void {
  for (const [legacy, canonical] of Object.entries(LEGACY_FILE_RENAMES)) {
    if (Object.prototype.hasOwnProperty.call(fileConfig, legacy)) {
      throw new ConfigError(
        `Legacy config key "${legacy}" is no longer supported. Use "${canonical}" instead.`,
      );
    }
  }
}

function parseIntegerValue(key: string, value: unknown): number {
  const parsed = parseInt(String(value), 10);
  if (isNaN(parsed)) {
    throw new ConfigError(`Invalid integer for ${key}: ${value}`);
  }
  return parsed;
}

function parseBooleanValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return String(value).toLowerCase() === "true" || String(value) === "1";
}

function parseTags(value: string): string[] {
  return value.split(",").map((t) => t.trim()).filter(Boolean);
}

function normalizeTagList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function normalizePorts(
  key: string,
  ports: number[],
): number[] {
  const normalized = ports.map((port) => Math.floor(port));
  if (
    normalized.length === 0 ||
    normalized.some((port) => !Number.isFinite(port) || port < 1 || port > 65535)
  ) {
    throw new ConfigError(
      `Invalid port list for ${key}: ${ports.join(",")}`,
    );
  }
  return Array.from(new Set(normalized));
}

function parsePortsFromString(key: string, value: string): number[] {
  const parts = value.split(",").map((v) => v.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new ConfigError(`Invalid port list for ${key}: ${value}`);
  }
  const parsed = parts.map((part) => parseIntegerValue(key, part));
  return normalizePorts(key, parsed);
}

function buildWorkerConfig(
  get: (key: string) => string | undefined,
  fileConfig: ConfigFile = {},
): WorkerConfig {
  assertNoLegacyEnvVars(get);

  const getString = (key: string, fileValue?: string): string | undefined => {
    const envValue = get(key);
    if (envValue) return envValue;
    if (fileValue) return fileValue;
    return undefined;
  };

  const requireString = (key: string, fileValue?: string): string => {
    const value = getString(key, fileValue);
    if (!value) {
      throw new ConfigError(`Missing required environment variable: ${key}`);
    }
    return value;
  };

  const getInt = (
    key: string,
    fileValue: number | undefined,
    defaultValue: number,
  ): number => {
    const envValue = get(key);
    if (envValue) {
      return parseIntegerValue(key, envValue);
    }
    if (fileValue !== undefined) {
      return parseIntegerValue(key, fileValue);
    }
    return defaultValue;
  };

  const getBool = (
    key: string,
    fileValue: boolean | undefined,
    defaultValue: boolean,
  ): boolean => {
    const envValue = get(key);
    if (envValue) {
      return parseBooleanValue(envValue);
    }
    if (fileValue !== undefined) {
      return parseBooleanValue(fileValue);
    }
    return defaultValue;
  };

  const logLevel = (getString(ENV_VARS.LOG_LEVEL, fileConfig.logLevel) ??
    "info") as WorkerConfig["logLevel"];
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    throw new ConfigError(
      `Invalid log level: ${logLevel}. Must be one of: debug, info, warn, error`,
    );
  }

  const defaultWorkerId = `worker-${crypto.randomUUID().slice(0, 8)}`;
  const envAllowNet = get(ENV_VARS.ALLOW_NET);
  const envTags = get(ENV_VARS.WORKER_TAGS);
  const networkPolicyMode = (getString(
    ENV_VARS.NETWORK_POLICY_MODE,
    fileConfig.networkPolicyMode,
  ) ?? "trusted") as NetworkPolicyMode;
  if (!["trusted", "shared_serverless"].includes(networkPolicyMode)) {
    throw new ConfigError(
      `Invalid network policy mode: ${networkPolicyMode}. Must be one of: trusted, shared_serverless`,
    );
  }

  const envAllowedPorts = get(ENV_VARS.EGRESS_ALLOWED_PORTS);
  const allowedPorts = envAllowedPorts
    ? parsePortsFromString(ENV_VARS.EGRESS_ALLOWED_PORTS, envAllowedPorts)
    : fileConfig.egressAllowedPorts
    ? normalizePorts(ENV_VARS.EGRESS_ALLOWED_PORTS, fileConfig.egressAllowedPorts)
    : [80, 443, 8080, 8443];

  return {
    controlPlaneUrl: requireString(
      ENV_VARS.CONTROL_PLANE_URL,
      fileConfig.controlPlaneUrl,
    ),
    workerToken: requireString(ENV_VARS.WORKER_TOKEN, fileConfig.workerToken),
    workerId: getString(ENV_VARS.WORKER_ID, fileConfig.workerId) ??
      defaultWorkerId,
    controlPlaneTimeoutMs: getInt(
      ENV_VARS.CONTROL_PLANE_TIMEOUT_MS,
      undefined,
      30_000,
    ),
    controlPlaneMaxRetries: getInt(
      ENV_VARS.CONTROL_PLANE_MAX_RETRIES,
      undefined,
      3,
    ),
    claimIntervalMs: getInt(ENV_VARS.CLAIM_INTERVAL_MS, undefined, 5_000),
    heartbeatIntervalMs: getInt(
      ENV_VARS.HEARTBEAT_INTERVAL_MS,
      undefined,
      10_000,
    ),
    longPollMs: getInt(ENV_VARS.LONG_POLL_MS, undefined, 30_000),
    logLevel,
    workDir: getString(ENV_VARS.WORK_DIR) ??
      Deno.makeTempDirSync({ prefix: "glubean-" }),
    downloadTimeoutMs: getInt(ENV_VARS.DOWNLOAD_TIMEOUT_MS, undefined, 60_000),
    run: {
      ...WORKER_RUN_DEFAULTS,
      failFast: getBool(ENV_VARS.FAIL_FAST, fileConfig.failFast, false),
      allowNet: envAllowNet ?? fileConfig.allowNet ?? "*",
      concurrency: getInt(
        ENV_VARS.EXECUTION_CONCURRENCY,
        fileConfig.executionConcurrency,
        1,
      ),
    },
    taskTimeoutMs: getInt(
      ENV_VARS.TASK_TIMEOUT_MS,
      fileConfig.taskTimeoutMs,
      300_000,
    ),
    eventFlushIntervalMs: getInt(ENV_VARS.EVENT_FLUSH_INTERVAL_MS, undefined, 1_000),
    eventFlushMaxBuffer: getInt(ENV_VARS.EVENT_FLUSH_MAX_BUFFER, undefined, 50),
    eventMaxBuffer: getInt(ENV_VARS.EVENT_MAX_BUFFER, undefined, 10_000),
    eventFlushMaxConsecutiveFailures: getInt(
      ENV_VARS.EVENT_FLUSH_MAX_CONSECUTIVE_FAILURES,
      undefined,
      5,
    ),
    tags: envTags ? parseTags(envTags) : normalizeTagList(fileConfig.tags),
    maxConcurrentTasks: getInt(
      ENV_VARS.MAX_CONCURRENT_TASKS,
      fileConfig.maxConcurrentTasks,
      1,
    ),
    taskMemoryLimitBytes: getInt(
      ENV_VARS.TASK_MEMORY_LIMIT_MB,
      fileConfig.taskMemoryLimitMb,
      0,
    ) * 1024 * 1024,
    memoryCheckIntervalMs: getInt(
      ENV_VARS.MEMORY_CHECK_INTERVAL_MS,
      undefined,
      2000,
    ),
    defaultSecretsPath: get(ENV_VARS.DEFAULT_SECRETS_PATH),
    networkPolicy: {
      mode: networkPolicyMode,
      maxRequests: getInt(
        ENV_VARS.EGRESS_MAX_REQUESTS,
        fileConfig.egressMaxRequests,
        300,
      ),
      maxConcurrentRequests: getInt(
        ENV_VARS.EGRESS_MAX_CONCURRENT_REQUESTS,
        fileConfig.egressMaxConcurrentRequests,
        20,
      ),
      requestTimeoutMs: getInt(
        ENV_VARS.EGRESS_REQUEST_TIMEOUT_MS,
        fileConfig.egressRequestTimeoutMs,
        30_000,
      ),
      maxResponseBytes: getInt(
        ENV_VARS.EGRESS_MAX_RESPONSE_BYTES,
        fileConfig.egressMaxResponseBytes,
        20 * 1024 * 1024,
      ),
      allowedPorts,
    },
  };
}

/**
 * Load configuration from environment variables.
 *
 * @throws ConfigError if required values are missing
 */
export function loadConfig(): WorkerConfig {
  return buildWorkerConfig((key) => Deno.env.get(key));
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
  taskTimeoutMs?: number;
  executionConcurrency?: number;
  failFast?: boolean;
  /** Tags for task matching (e.g., ["tier:pro", "team:acme"]). */
  tags?: string[];
  /** Max concurrent tasks per worker. */
  maxConcurrentTasks?: number;
  /** Memory limit per task in MB. */
  taskMemoryLimitMb?: number;
  /** Worker network policy mode. */
  networkPolicyMode?: NetworkPolicyMode;
  /** Max outbound requests per test execution in shared mode. */
  egressMaxRequests?: number;
  /** Max in-flight outbound requests per test execution in shared mode. */
  egressMaxConcurrentRequests?: number;
  /** Per-request timeout in milliseconds in shared mode. */
  egressRequestTimeoutMs?: number;
  /** Approximate response-byte budget per test execution in shared mode. */
  egressMaxResponseBytes?: number;
  /** Allowed outbound destination ports in shared mode. */
  egressAllowedPorts?: number[];
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
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      assertNoLegacyFileKeys(parsed);
      fileConfig = parsed as ConfigFile;
    } else {
      throw new ConfigError("Config file must contain a JSON object.");
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      if (err instanceof ConfigError) throw err;
      throw new ConfigError(`Failed to read config file: ${err}`);
    }
  }

  return buildWorkerConfig((key) => Deno.env.get(key), fileConfig);
}
