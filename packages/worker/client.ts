/**
 * Control Plane API client.
 *
 * Uses native fetch for HTTP communication.
 * Implements the TaskLeaseProtocol and event streaming endpoints.
 */

import type {
  ClaimTaskRequest,
  ClaimTaskResponse,
  CompleteTaskRequest,
  FailTaskRequest,
  GetRuntimeContextRequest,
  GetRuntimeContextResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  RunEvent as _RunEvent,
  SubmitEventsRequest,
} from "./types.ts";

/**
 * Error from Control Plane API.
 */
export class ControlPlaneError extends Error {
  override name = "ControlPlaneError";

  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
    public readonly body?: unknown,
  ) {
    super(message);
  }

  static timeout(timeoutMs: number): ControlPlaneError {
    return new ControlPlaneError(
      `Request timed out after ${timeoutMs}ms`,
      "TIMEOUT",
    );
  }

  static leaseExpired(): ControlPlaneError {
    return new ControlPlaneError("Lease has expired", "LEASE_EXPIRED", 401);
  }

  static http(statusCode: number, body?: unknown): ControlPlaneError {
    const message = body && typeof body === "object" && "message" in body
      ? String((body as { message: unknown }).message)
      : `HTTP ${statusCode}`;
    return new ControlPlaneError(message, "HTTP_ERROR", statusCode, body);
  }

  static network(message: string, cause?: Error): ControlPlaneError {
    const error = new ControlPlaneError(message, "NETWORK_ERROR");
    if (cause) error.cause = cause;
    return error;
  }
}

export interface ControlPlaneClientOptions {
  /** Base URL of the ControlPlane API (e.g., https://api.glubean.com). */
  baseUrl: string;
  /** Worker authentication token. */
  workerToken: string;
  /** Request timeout in milliseconds. */
  timeoutMs: number;
  /** Max retries for idempotent operations. */
  maxRetries: number;
}

const DATA_PLANE_BASE_PATH = "data-plane/worker/tasks";

/**
 * Client for interacting with ControlPlane APIs.
 *
 * @example
 * const client = new ControlPlaneClient({
 *   baseUrl: "https://api.glubean.com",
 *   workerToken: "gwt_xxx",
 *   timeoutMs: 30000,
 *   maxRetries: 3,
 * });
 * const { task } = await client.claim({ workerId: "worker-1", longPollMs: 30000 });
 */
export class ControlPlaneClient {
  private readonly baseUrl: string;
  private readonly workerToken: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: ControlPlaneClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.workerToken = options.workerToken;
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
  }

  /**
   * Claim a task from the queue.
   * Returns null task if no work is available.
   */
  claim(req: ClaimTaskRequest): Promise<ClaimTaskResponse> {
    // For long-poll, extend timeout to account for wait time
    const timeout = req.longPollMs ? req.longPollMs + 5000 : this.timeoutMs;

    // Don't retry claim (non-idempotent)
    return this.post<ClaimTaskResponse>(`${DATA_PLANE_BASE_PATH}/claim`, req, {
      timeout,
      retry: false,
    });
  }

  /**
   * Extend a task lease.
   * Optionally includes system resource info for the dashboard.
   */
  heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse> {
    const body: Record<string, unknown> = {};
    if (req.systemInfo) {
      body.systemInfo = req.systemInfo;
    }
    return this.post<HeartbeatResponse>(
      `${DATA_PLANE_BASE_PATH}/${req.taskId}/heartbeat`,
      body,
      { leaseToken: req.leaseToken },
    );
  }

  /**
   * Get the runtime context for a claimed task.
   */
  getContext(
    req: GetRuntimeContextRequest,
  ): Promise<GetRuntimeContextResponse> {
    return this.get<GetRuntimeContextResponse>(
      `${DATA_PLANE_BASE_PATH}/${req.taskId}/context`,
      { leaseToken: req.leaseToken },
    );
  }

  /**
   * Submit a batch of run events.
   */
  async submitEvents(req: SubmitEventsRequest): Promise<void> {
    await this.post<void>(
      `${DATA_PLANE_BASE_PATH}/${req.taskId}/events`,
      { events: req.events },
      { leaseToken: req.leaseToken },
    );
  }

  /**
   * Mark a task as successfully completed.
   */
  async complete(req: CompleteTaskRequest): Promise<void> {
    await this.post<void>(
      `${DATA_PLANE_BASE_PATH}/${req.taskId}/complete`,
      { summary: req.summary, idempotencyKey: req.idempotencyKey },
      { leaseToken: req.leaseToken },
    );
  }

  /**
   * Mark a task as failed.
   */
  async fail(req: FailTaskRequest): Promise<void> {
    await this.post<void>(
      `${DATA_PLANE_BASE_PATH}/${req.taskId}/fail`,
      { failureClass: req.failureClass, message: req.message },
      { leaseToken: req.leaseToken },
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private get<T>(
    path: string,
    options?: { leaseToken?: string; timeout?: number },
  ): Promise<T> {
    return this.request<T>("GET", path, undefined, options);
  }

  private post<T>(
    path: string,
    body: unknown,
    options?: { leaseToken?: string; timeout?: number; retry?: boolean },
  ): Promise<T> {
    return this.request<T>("POST", path, body, options);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options?: { leaseToken?: string; timeout?: number; retry?: boolean },
  ): Promise<T> {
    const url = `${this.baseUrl}/${path}`;
    const timeout = options?.timeout ?? this.timeoutMs;
    const shouldRetry = options?.retry !== false;
    const maxAttempts = shouldRetry ? this.maxRetries + 1 : 1;

    let lastError: ControlPlaneError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.workerToken}`,
        };

        if (options?.leaseToken) {
          headers["X-Lease-Token"] = options.leaseToken;
        }

        const response = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          // Handle 401 as lease expired
          if (response.status === 401 && options?.leaseToken) {
            throw ControlPlaneError.leaseExpired();
          }

          // Try to parse error body
          let errorBody: unknown;
          try {
            const text = await response.text();
            errorBody = text ? JSON.parse(text) : undefined;
          } catch {
            // Ignore body parsing errors
          }

          const error = ControlPlaneError.http(response.status, errorBody);

          // Don't retry 4xx errors (except 408, 429)
          if (
            response.status >= 400 &&
            response.status < 500 &&
            response.status !== 408 &&
            response.status !== 429
          ) {
            throw error;
          }

          lastError = error;
          if (attempt < maxAttempts) {
            await this.backoff(attempt);
            continue;
          }
          throw error;
        }

        // Handle empty responses
        const text = await response.text();
        if (!text) {
          return undefined as T;
        }
        return JSON.parse(text) as T;
      } catch (err) {
        clearTimeout(timeoutId);

        if (err instanceof ControlPlaneError) {
          throw err;
        }

        if (err instanceof DOMException && err.name === "AbortError") {
          throw ControlPlaneError.timeout(timeout);
        }

        const error = ControlPlaneError.network(
          err instanceof Error ? err.message : "Unknown error",
          err instanceof Error ? err : undefined,
        );

        lastError = error;
        if (attempt < maxAttempts) {
          await this.backoff(attempt);
          continue;
        }
        throw error;
      }
    }

    throw lastError ?? new ControlPlaneError("Request failed", "UNKNOWN");
  }

  private async backoff(attempt: number): Promise<void> {
    // Exponential backoff with jitter
    const baseMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
    const jitter = Math.random() * baseMs * 0.5;
    await new Promise((resolve) => setTimeout(resolve, baseMs + jitter));
  }
}
