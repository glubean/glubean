export interface ResponseBudgetOptions {
  requestUrl: URL;
  maxResponseBytes: number;
  getUsedResponseBytes: () => number;
  addUsedResponseBytes: (delta: number) => void;
  emitWarning: (code: string, message: string) => void;
}

function createBudgetExceededError(maxResponseBytes: number): Error {
  return new Error(
    `Network policy exceeded response-byte budget (${maxResponseBytes}).`,
  );
}

export function applyResponseByteBudget(
  response: Response,
  options: ResponseBudgetOptions,
): Response {
  if (!response.body) return response;

  const contentLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > 0) {
    if (
      options.getUsedResponseBytes() + contentLength > options.maxResponseBytes
    ) {
      options.emitWarning(
        "response_budget_exceeded",
        `Response-byte budget exceeded (${options.maxResponseBytes})`,
      );
      throw createBudgetExceededError(options.maxResponseBytes);
    }
  } else {
    options.emitWarning(
      "response_size_unknown",
      `No content-length for ${options.requestUrl.href}; enforcing response-byte budget via stream counting.`,
    );
  }

  const budgetedBody = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        options.addUsedResponseBytes(chunk.byteLength);
        if (options.getUsedResponseBytes() > options.maxResponseBytes) {
          options.emitWarning(
            "response_budget_exceeded",
            `Response-byte budget exceeded (${options.maxResponseBytes})`,
          );
          controller.error(createBudgetExceededError(options.maxResponseBytes));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );

  return new Response(budgetedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
