/**
 * @module adapter
 *
 * Scope adapter — maps ExecutionEvent types to redaction scopes.
 *
 * Without this adapter, the engine's scope toggles are decorative.
 * This function dispatches each event's payload fields to the correct
 * scope so the engine can gate redaction per-scope.
 *
 * Both the CLI (for --share) and the server (for event ingestion) use
 * this adapter. The server adapter may handle additional premium scopes.
 */

import type { RedactionEngine } from "./engine";
import type { RedactionConfig } from "./types";

/**
 * A generic event shape compatible with both ExecutionEvent (oss runner)
 * and RunEvent (server). The adapter only reads `type` and mutates payload
 * fields in-place on a clone.
 */
export interface RedactableEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Redact an event by dispatching its payload fields to the appropriate
 * scopes. Returns a new event object — the original is not mutated.
 *
 * Scope mapping:
 * - trace → requestHeaders, requestQuery, requestBody, responseHeaders, responseBody
 * - log → consoleOutput
 * - assertion → errorMessages
 * - error / status → errorMessages
 * - warning / schema_validation → errorMessages
 * - step_end → returnState
 * - metric, step_start, start, summary → no redaction
 *
 * @example
 * const redacted = redactEvent(engine, { type: "trace", data: { ... } });
 */
export function redactEvent<C extends RedactionConfig>(
  engine: RedactionEngine<C>,
  event: RedactableEvent
): RedactableEvent {
  const t = event.type;

  // Events that don't need redaction — return as-is
  if (
    t === "metric" ||
    t === "step_start" ||
    t === "start" ||
    t === "summary" ||
    t === "timeout_update"
  ) {
    return event;
  }

  // step_end: only needs redaction if returnState is present
  if (t === "step_end") {
    if (event.returnState != null) {
      const clone = structuredClone(event);
      clone.returnState = engine.redact(
        clone.returnState,
        "returnState" as keyof C["scopes"] & string
      ).value;
      return clone;
    }
    return event;
  }

  // Clone to avoid mutating the original
  const clone = structuredClone(event);

  if (t === "trace") {
    // Trace events have data: ApiTrace with headers/bodies
    const data = clone.data as Record<string, unknown> | undefined;
    if (data) {
      if (data.requestHeaders != null) {
        data.requestHeaders = engine.redact(
          data.requestHeaders,
          "requestHeaders" as keyof C["scopes"] & string
        ).value;
      }
      if (data.requestBody != null) {
        data.requestBody = engine.redact(
          data.requestBody,
          "requestBody" as keyof C["scopes"] & string
        ).value;
      }
      if (data.responseHeaders != null) {
        data.responseHeaders = engine.redact(
          data.responseHeaders,
          "responseHeaders" as keyof C["scopes"] & string
        ).value;
      }
      if (data.responseBody != null) {
        data.responseBody = engine.redact(
          data.responseBody,
          "responseBody" as keyof C["scopes"] & string
        ).value;
      }
      // URL may contain query params with secrets
      if (typeof data.url === "string") {
        data.url = engine.redact(
          data.url,
          "requestQuery" as keyof C["scopes"] & string
        ).value as string;
      }
    }
  } else if (t === "log") {
    if (clone.message != null) {
      clone.message = engine.redact(
        clone.message,
        "consoleOutput" as keyof C["scopes"] & string
      ).value;
    }
    if (clone.data != null) {
      clone.data = engine.redact(
        clone.data,
        "consoleOutput" as keyof C["scopes"] & string
      ).value;
    }
  } else if (t === "assertion") {
    if (clone.message != null) {
      clone.message = engine.redact(
        clone.message,
        "errorMessages" as keyof C["scopes"] & string
      ).value;
    }
    if (clone.actual != null) {
      clone.actual = engine.redact(
        clone.actual,
        "errorMessages" as keyof C["scopes"] & string
      ).value;
    }
    if (clone.expected != null) {
      clone.expected = engine.redact(
        clone.expected,
        "errorMessages" as keyof C["scopes"] & string
      ).value;
    }
  } else if (t === "error") {
    if (clone.message != null) {
      clone.message = engine.redact(
        clone.message,
        "errorMessages" as keyof C["scopes"] & string
      ).value;
    }
  } else if (t === "status") {
    if (clone.error != null) {
      clone.error = engine.redact(
        clone.error,
        "errorMessages" as keyof C["scopes"] & string
      ).value;
    }
    if (clone.stack != null) {
      clone.stack = engine.redact(
        clone.stack,
        "errorMessages" as keyof C["scopes"] & string
      ).value;
    }
  } else if (t === "warning" || t === "schema_validation") {
    if (clone.message != null) {
      clone.message = engine.redact(
        clone.message,
        "errorMessages" as keyof C["scopes"] & string
      ).value;
    }
  }

  return clone;
}
