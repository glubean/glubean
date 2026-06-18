/**
 * Workflow retry-meta validation (authoring-side).
 *
 * Lives in the SDK (not the executor) because it is shared: the `workflow()`
 * builder validates `retry` at authoring time, and the workflow executor
 * re-validates it at run time. When the executor moved out of the SDK into
 * `@glubean/runner` (plan 0007), this validation stayed here so the builder
 * keeps a same-package import and the (relocated) executor reaches it via
 * `@glubean/sdk/internal`.
 */
import type { RetryMeta } from "./types.js";

export function validateRetryMeta(retry: RetryMeta, stepLabel: string): void {
  if (!Number.isInteger(retry.attempts) || retry.attempts < 2) {
    throw new Error(
      `workflow step "${stepLabel}": retry.attempts must be an integer >= 2 ` +
        `(1 attempt is no retry — omit \`retry\`); got ${String(retry.attempts)}`,
    );
  }
  if (
    retry.delay !== undefined &&
    (typeof retry.delay !== "number" || !Number.isFinite(retry.delay) || retry.delay < 0)
  ) {
    throw new Error(
      `workflow step "${stepLabel}": retry.delay must be a finite number >= 0; got ${String(retry.delay)}`,
    );
  }
  if (typeof retry.reason !== "string" || retry.reason.length === 0) {
    throw new Error(
      `workflow step "${stepLabel}": retry.reason is required — state why replaying ` +
        `this step is safe (idempotency is the author's responsibility, §17 #7)`,
    );
  }
}
