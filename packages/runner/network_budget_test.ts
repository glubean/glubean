import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { applyResponseByteBudget } from "./network_budget.ts";

function makeChunkedResponse(chunks: string[]): Response {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(new TextEncoder().encode(chunks[index]));
      index++;
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/plain" },
  });
}

Deno.test("applyResponseByteBudget enforces streamed bytes without content-length", async () => {
  const warnings: string[] = [];
  let usedBytes = 0;

  const response = makeChunkedResponse(["12345", "67890"]);
  const wrapped = applyResponseByteBudget(response, {
    requestUrl: new URL("https://example.com/stream"),
    maxResponseBytes: 8,
    getUsedResponseBytes: () => usedBytes,
    addUsedResponseBytes: (delta) => {
      usedBytes += delta;
    },
    emitWarning: (code, message) => {
      warnings.push(`[${code}] ${message}`);
    },
  });

  await assertRejects(
    async () => {
      await wrapped.text();
    },
    Error,
    "Network policy exceeded response-byte budget",
  );

  assertEquals(usedBytes > 8, true);
  assertEquals(
    warnings.some((message) => message.includes("[response_size_unknown]")),
    true,
  );
  assertEquals(
    warnings.some((message) => message.includes("[response_budget_exceeded]")),
    true,
  );
});

Deno.test("applyResponseByteBudget rejects when content-length overflows budget", () => {
  const warnings: string[] = [];
  let usedBytes = 5;

  const response = new Response("payload", {
    headers: {
      "content-type": "text/plain",
      "content-length": "10",
    },
  });

  const error = assertThrows(
    () =>
      applyResponseByteBudget(response, {
        requestUrl: new URL("https://example.com/payload"),
        maxResponseBytes: 12,
        getUsedResponseBytes: () => usedBytes,
        addUsedResponseBytes: (delta) => {
          usedBytes += delta;
        },
        emitWarning: (code, message) => {
          warnings.push(`[${code}] ${message}`);
        },
      }),
    Error,
    "Network policy exceeded response-byte budget",
  );

  assertStringIncludes(error.message, "response-byte budget");
  assertEquals(usedBytes, 5);
  assertEquals(
    warnings.some((message) => message.includes("[response_budget_exceeded]")),
    true,
  );
});

Deno.test("applyResponseByteBudget passes through when within budget", async () => {
  let usedBytes = 0;
  const warnings: string[] = [];

  const response = makeChunkedResponse(["abcd", "ef"]);
  const wrapped = applyResponseByteBudget(response, {
    requestUrl: new URL("https://example.com/ok"),
    maxResponseBytes: 16,
    getUsedResponseBytes: () => usedBytes,
    addUsedResponseBytes: (delta) => {
      usedBytes += delta;
    },
    emitWarning: (code, message) => {
      warnings.push(`[${code}] ${message}`);
    },
  });

  const body = await wrapped.text();
  assertEquals(body, "abcdef");
  assertEquals(usedBytes, 6);
  assertEquals(
    warnings.some((message) => message.includes("[response_budget_exceeded]")),
    false,
  );
});
