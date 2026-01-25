import { assertEquals, assertRejects } from "@std/assert";
import { ControlPlaneClient, ControlPlaneError } from "./client.ts";

// Mock fetch helper
function mockFetch(
  handler: (req: Request) => Response | Promise<Response>
): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    return Promise.resolve(handler(request));
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function createClient(): ControlPlaneClient {
  return new ControlPlaneClient({
    baseUrl: "https://api.glubean.com",
    workerToken: "gwt_test_token",
    timeoutMs: 5000,
    maxRetries: 2,
  });
}

Deno.test("client.claim sends correct request", async () => {
  let capturedRequest: Request | undefined;
  let capturedBody: unknown;

  const restore = mockFetch(async (req) => {
    capturedRequest = req.clone();
    capturedBody = await req.json();
    return new Response(JSON.stringify({ task: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  try {
    const client = createClient();
    const result = await client.claim({
      workerId: "worker-1",
      longPollMs: 30000,
    });

    assertEquals(result.task, null);
    assertEquals(capturedRequest!.method, "POST");
    assertEquals(
      capturedRequest!.url,
      "https://api.glubean.com/data-plane/worker/tasks/claim"
    );
    assertEquals(
      capturedRequest!.headers.get("Authorization"),
      "Bearer gwt_test_token"
    );

    const body = capturedBody as { workerId: string; longPollMs: number };
    assertEquals(body.workerId, "worker-1");
    assertEquals(body.longPollMs, 30000);
  } finally {
    restore();
  }
});

Deno.test("client.claim returns task when available", async () => {
  const mockTask = {
    taskId: "task-123",
    leaseId: "lease-456",
    leaseToken: "token-789",
    leaseExpiresAt: "2025-01-30T12:00:00Z",
    attempt: 1,
  };

  const restore = mockFetch(() => {
    return new Response(JSON.stringify({ task: mockTask }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  try {
    const client = createClient();
    const result = await client.claim({ workerId: "worker-1" });

    assertEquals(result.task?.taskId, "task-123");
    assertEquals(result.task?.leaseToken, "token-789");
  } finally {
    restore();
  }
});

Deno.test("client.heartbeat sends lease token header", async () => {
  let capturedRequest: Request | undefined;

  const restore = mockFetch((req) => {
    capturedRequest = req.clone();
    return new Response(
      JSON.stringify({ leaseExpiresAt: "2025-01-30T12:30:00Z" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  try {
    const client = createClient();
    const result = await client.heartbeat({
      taskId: "task-123",
      leaseToken: "my-lease-token",
    });

    assertEquals(
      capturedRequest!.url,
      "https://api.glubean.com/data-plane/worker/tasks/task-123/heartbeat"
    );
    assertEquals(
      capturedRequest!.headers.get("X-Lease-Token"),
      "my-lease-token"
    );
    assertEquals(result.leaseExpiresAt, "2025-01-30T12:30:00Z");
  } finally {
    restore();
  }
});

Deno.test("client.getContext returns runtime context", async () => {
  const mockContext = {
    taskId: "task-123",
    runId: "run-456",
    projectId: "proj-789",
    bundle: {
      bundleId: "bundle-abc",
      download: {
        type: "bundle",
        url: "https://storage.example.com/bundle.tar",
      },
    },
    vars: { API_URL: "https://api.example.com" },
  };

  const restore = mockFetch(() => {
    return new Response(JSON.stringify({ context: mockContext }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  try {
    const client = createClient();
    const result = await client.getContext({
      taskId: "task-123",
      leaseToken: "token-xyz",
    });

    assertEquals(result.context.taskId, "task-123");
    assertEquals(result.context.vars?.API_URL, "https://api.example.com");
  } finally {
    restore();
  }
});

Deno.test("client.submitEvents sends batch", async () => {
  let capturedBody: unknown = null;

  const restore = mockFetch(async (req) => {
    capturedBody = await req.json();
    return new Response(null, { status: 204 });
  });

  try {
    const client = createClient();
    await client.submitEvents({
      taskId: "task-123",
      leaseToken: "token-xyz",
      events: [
        {
          runId: "run-1",
          taskId: "task-123",
          seq: 1,
          ts: "2025-01-30T12:00:00Z",
          type: "log",
          payload: { message: "Test log" },
        },
      ],
    });

    const body = capturedBody as { events: unknown[] };
    assertEquals(body.events.length, 1);
  } finally {
    restore();
  }
});

Deno.test("client throws ControlPlaneError on HTTP error", async () => {
  const restore = mockFetch(() => {
    return new Response(JSON.stringify({ message: "Task not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  });

  try {
    const client = createClient();

    await assertRejects(
      () => client.getContext({ taskId: "task-123", leaseToken: "token" }),
      ControlPlaneError,
      "Task not found"
    );
  } finally {
    restore();
  }
});

Deno.test("client throws lease expired on 401 with lease token", async () => {
  const restore = mockFetch(() => {
    return new Response(null, { status: 401 });
  });

  try {
    const client = createClient();

    await assertRejects(
      () => client.heartbeat({ taskId: "task-123", leaseToken: "expired" }),
      ControlPlaneError,
      "Lease has expired"
    );
  } finally {
    restore();
  }
});

Deno.test("client retries on 5xx errors", async () => {
  let attemptCount = 0;

  const restore = mockFetch(() => {
    attemptCount++;
    if (attemptCount < 3) {
      return new Response(null, { status: 503 });
    }
    return new Response(
      JSON.stringify({ leaseExpiresAt: "2025-01-30T12:30:00Z" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  try {
    const client = createClient();
    // Use heartbeat instead of claim because claim has retry: false
    const result = await client.heartbeat({
      taskId: "task-123",
      leaseToken: "token",
    });

    assertEquals(result.leaseExpiresAt, "2025-01-30T12:30:00Z");
    assertEquals(attemptCount, 3); // Initial + 2 retries
  } finally {
    restore();
  }
});

Deno.test("client does not retry on 4xx errors", async () => {
  let attemptCount = 0;

  const restore = mockFetch(() => {
    attemptCount++;
    return new Response(JSON.stringify({ message: "Bad request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  });

  try {
    const client = createClient();

    await assertRejects(
      () => client.getContext({ taskId: "task-123", leaseToken: "token" }),
      ControlPlaneError
    );

    assertEquals(attemptCount, 1); // No retries
  } finally {
    restore();
  }
});

Deno.test("client.complete sends summary", async () => {
  let capturedBody: unknown = null;

  const restore = mockFetch(async (req) => {
    capturedBody = await req.json();
    return new Response(null, { status: 204 });
  });

  try {
    const client = createClient();
    await client.complete({
      taskId: "task-123",
      leaseToken: "token-xyz",
      summary: {
        runId: "run-456",
        taskId: "task-123",
        status: "passed",
        startedAt: "2025-01-30T12:00:00Z",
        completedAt: "2025-01-30T12:01:00Z",
        durationMs: 60000,
      },
      idempotencyKey: "idem-123",
    });

    const body = capturedBody as {
      summary: { status: string };
      idempotencyKey: string;
    };
    assertEquals(body.summary.status, "passed");
    assertEquals(body.idempotencyKey, "idem-123");
  } finally {
    restore();
  }
});

Deno.test("client.fail sends failure info", async () => {
  let capturedBody: unknown = null;

  const restore = mockFetch(async (req) => {
    capturedBody = await req.json();
    return new Response(null, { status: 204 });
  });

  try {
    const client = createClient();
    await client.fail({
      taskId: "task-123",
      leaseToken: "token-xyz",
      failureClass: "timeout",
      message: "Execution timed out after 300s",
    });

    const body = capturedBody as { failureClass: string; message: string };
    assertEquals(body.failureClass, "timeout");
    assertEquals(body.message, "Execution timed out after 300s");
  } finally {
    restore();
  }
});
