# Glubean Event Reference

This document describes every event type emitted by the Glubean runner during test execution. The server uses these events to build timelines, dashboards, and alerts.

## Event Lifecycle

```
start → [log | assertion | trace | metric | step_start | step_end]* → summary → status
```

All events are JSON lines on stdout. The executor parses them into timestamped `TimelineEvent` objects (see `packages/runner/executor.ts`).

## Transport

Events are emitted by the **harness** (sandboxed subprocess) as JSON lines on stdout:

```json
{ "type": "log", "message": "Hello", "stepIndex": 0 }
```

The **executor** (parent process) reads these lines, adds a `ts` (milliseconds since execution start) and an optional `testId` (for batch execution), then exposes them as `TimelineEvent` objects via `ExecutionResult.events` and the `onEvent` streaming callback.

### Common Fields

These optional fields appear on most `TimelineEvent` types:

| Field       | Type      | Description                                                                                                                                                                                              |
| ----------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ts`        | `number`  | Milliseconds since test execution started                                                                                                                                                                |
| `testId`    | `string?` | Present in batch execution (`executeMany`) to identify which test the event belongs to                                                                                                                   |
| `stepIndex` | `number?` | Zero-based index of the containing builder step. **Only present when the event was emitted within a step.** Not present on simple (non-builder) tests or events outside of steps (e.g., setup/teardown). |

---

## Event Types

### `start`

Emitted once at the beginning of test execution.

| Field        | Type        | Description                                                                 |
| ------------ | ----------- | --------------------------------------------------------------------------- |
| `type`       | `"start"`   | Event type                                                                  |
| `id`         | `string`    | Test ID                                                                     |
| `name`       | `string`    | Human-readable test name                                                    |
| `tags`       | `string[]?` | Test tags                                                                   |
| `suiteId`    | `string?`   | Parent suite ID (legacy API)                                                |
| `suiteName`  | `string?`   | Parent suite name (legacy API)                                              |
| `retryCount` | `number?`   | Retry attempt number (omitted on first attempt; `1` = second attempt, etc.) |

> **Server note:** Not included in `TimelineEvent`. Used by executor to populate `ExecutionResult.testName`, `suiteId`, `suiteName`, `retryCount`.

**Server usage:** Use `retryCount` to distinguish retry attempts. Display "Attempt 2 of 3" in the UI. Track retry rates across tests.

---

### `log`

A log message from `ctx.log()`.

| Field       | Type       | Description                                      |
| ----------- | ---------- | ------------------------------------------------ |
| `type`      | `"log"`    | Event type                                       |
| `ts`        | `number`   | Milliseconds since test start                    |
| `testId`    | `string?`  | Present in batch execution                       |
| `stepIndex` | `number?`  | Containing step index (if within a builder step) |
| `message`   | `string`   | Log message                                      |
| `data`      | `unknown?` | Optional structured data                         |

**Server usage:** Display in test timeline. Searchable. Use `stepIndex` to group logs under their step.

---

### `assertion`

Result of `ctx.assert()`. Does **not** throw — records the result and continues execution. The step/test failure is determined by the harness based on assertion outcomes.

| Field       | Type          | Description                                      |
| ----------- | ------------- | ------------------------------------------------ |
| `type`      | `"assertion"` | Event type                                       |
| `ts`        | `number`      | Milliseconds since test start                    |
| `testId`    | `string?`     | Present in batch execution                       |
| `stepIndex` | `number?`     | Containing step index (if within a builder step) |
| `passed`    | `boolean`     | Whether the assertion passed                     |
| `message`   | `string`      | Assertion description                            |
| `actual`    | `unknown?`    | Actual value (on failure)                        |
| `expected`  | `unknown?`    | Expected value (on failure)                      |

**Server usage:** Count pass/fail per test and per step. Use `stepIndex` to group assertions under their step. Show failed assertions in detail view with actual vs expected diff.

---

### `trace`

An HTTP API trace, auto-emitted by `ctx.http` for every request.

| Field       | Type       | Description                                      |
| ----------- | ---------- | ------------------------------------------------ |
| `type`      | `"trace"`  | Event type                                       |
| `ts`        | `number`   | Milliseconds since test start                    |
| `testId`    | `string?`  | Present in batch execution                       |
| `stepIndex` | `number?`  | Containing step index (if within a builder step) |
| `data`      | `ApiTrace` | Trace details (see below)                        |

**`ApiTrace` shape:**

| Field             | Type       | Description                   |
| ----------------- | ---------- | ----------------------------- |
| `method`          | `string`   | HTTP method (GET, POST, etc.) |
| `url`             | `string`   | Request URL                   |
| `status`          | `number`   | Response status code          |
| `duration`        | `number`   | Request duration in ms        |
| `requestHeaders`  | `Record?`  | Request headers (redacted)    |
| `responseHeaders` | `Record?`  | Response headers              |
| `requestBody`     | `unknown?` | Request body                  |
| `responseBody`    | `unknown?` | Response body (if captured)   |

**Server usage:** Display API call waterfall. Calculate p50/p95/p99 latencies per endpoint. Use `stepIndex` to show which step made which API calls.

---

### `metric`

A custom or auto-generated metric from `ctx.metric()` or `ctx.http` (auto: `http_duration_ms`).

| Field       | Type                      | Description                                      |
| ----------- | ------------------------- | ------------------------------------------------ |
| `type`      | `"metric"`                | Event type                                       |
| `ts`        | `number`                  | Milliseconds since test start                    |
| `testId`    | `string?`                 | Present in batch execution                       |
| `stepIndex` | `number?`                 | Containing step index (if within a builder step) |
| `name`      | `string`                  | Metric name (e.g., `http_duration_ms`)           |
| `value`     | `number`                  | Metric value                                     |
| `unit`      | `string?`                 | Unit (e.g., `"ms"`, `"bytes"`)                   |
| `tags`      | `Record<string, string>?` | Dimensional tags                                 |

**Auto-generated metrics:**

| Name               | Source       | Tags             |
| ------------------ | ------------ | ---------------- |
| `http_duration_ms` | `ctx.http.*` | `method`, `path` |

**Server usage:** Store as time-series data. Build latency charts. Set threshold alerts (e.g., `http_duration_ms > 2000`).

---

### `step_start`

Emitted when a builder API step begins execution.

| Field    | Type           | Description                                   |
| -------- | -------------- | --------------------------------------------- |
| `type`   | `"step_start"` | Event type                                    |
| `ts`     | `number`       | Milliseconds since test start                 |
| `testId` | `string?`      | Present in batch execution                    |
| `index`  | `number`       | Zero-based step index                         |
| `name`   | `string`       | Step name (from builder `.step("name", ...)`) |
| `total`  | `number`       | Total number of steps in this test            |

**Server usage:** Mark step execution start in timeline. Use `total` to render step progress (e.g., "Step 2/5").

---

### `step_end`

Emitted when a builder API step completes, fails, or is skipped.

| Field              | Type                                | Description                                |
| ------------------ | ----------------------------------- | ------------------------------------------ |
| `type`             | `"step_end"`                        | Event type                                 |
| `ts`               | `number`                            | Milliseconds since test start              |
| `testId`           | `string?`                           | Present in batch execution                 |
| `index`            | `number`                            | Zero-based step index                      |
| `name`             | `string`                            | Step name                                  |
| `status`           | `"passed" \| "failed" \| "skipped"` | Step outcome                               |
| `durationMs`       | `number`                            | Step execution time in milliseconds        |
| `assertions`       | `number`                            | Total assertions in this step              |
| `failedAssertions` | `number`                            | Failed assertions in this step             |
| `error`            | `string?`                           | Error message (if step threw an exception) |

**Step status rules:**

- **`passed`**: Step completed without thrown errors and all assertions passed (`failedAssertions === 0`).
- **`failed`**: Step threw an error OR had one or more failed assertions.
- **`skipped`**: A previous step failed; this step was not executed. `durationMs` is `0`.

**Failure propagation:**

When a step fails:

1. The failed step emits `step_end` with `status: "failed"`.
2. All subsequent steps emit `step_end` with `status: "skipped"` (no `step_start`).
3. Teardown still runs (always).
4. The overall test is marked as failed.

```
step_start(0) → step_end(0, passed) → step_start(1) → step_end(1, failed) → step_end(2, skipped) → teardown → summary → status(failed)
```

**Server usage:**

- Render step timeline with color-coded status: green (passed), red (failed), gray (skipped).
- Show per-step duration bar chart.
- Display failed step's error and failed assertions in detail view.
- Track step-level pass rates across runs (e.g., "Step 'checkout' fails 15% of the time").

---

### `summary`

Test execution summary. Always emitted once before the final `status` event.

| Field                   | Type        | Description                                |
| ----------------------- | ----------- | ------------------------------------------ |
| `type`                  | `"summary"` | Event type                                 |
| `ts`                    | `number`    | Milliseconds since test start              |
| `testId`                | `string?`   | Present in batch execution                 |
| **HTTP stats**          |             |                                            |
| `data.httpRequestTotal` | `number`    | Total HTTP requests made                   |
| `data.httpErrorTotal`   | `number`    | HTTP requests with status >= 400           |
| `data.httpErrorRate`    | `number`    | Error rate (0.0 - 1.0)                     |
| **Assertion stats**     |             |                                            |
| `data.assertionTotal`   | `number`    | Total assertions executed                  |
| `data.assertionFailed`  | `number`    | Total failed assertions                    |
| **Step stats**          |             |                                            |
| `data.stepTotal`        | `number`    | Total number of steps (0 for simple tests) |
| `data.stepPassed`       | `number`    | Steps that passed                          |
| `data.stepFailed`       | `number`    | Steps that failed                          |
| `data.stepSkipped`      | `number`    | Steps that were skipped                    |

**Server usage:**

- Use as the **primary data source** for test result cards — no need to iterate `events[]` for counts.
- Show HTTP health overview. Alert on high error rates.
- Display assertion pass rate badge.
- Show step progress bar (e.g., "4/5 steps passed, 1 skipped").

---

### `status`

Final test outcome. Always the last meaningful event.

| Field             | Type                                   | Description                                |
| ----------------- | -------------------------------------- | ------------------------------------------ |
| `type`            | `"status"`                             | Event type                                 |
| `status`          | `"completed" \| "failed" \| "skipped"` | Final outcome                              |
| `id`              | `string?`                              | Test ID                                    |
| `error`           | `string?`                              | Error message (on failure)                 |
| `stack`           | `string?`                              | Stack trace (on failure)                   |
| `reason`          | `string?`                              | Skip reason (if skipped via `ctx.skip()`)  |
| `peakMemoryBytes` | `number?`                              | Peak heap usage in bytes                   |
| `peakMemoryMB`    | `string?`                              | Peak heap usage formatted (e.g., `"45.2"`) |

> **Server note:** Not included in `TimelineEvent`. Used by executor to populate `ExecutionResult.success`, `error`, `stack`, `peakMemoryBytes`.

**Server usage:** Determine overall pass/fail. Store peak memory for trend analysis.

---

## ExecutionResult

The executor collects all events into a final `ExecutionResult`:

```typescript
interface ExecutionResult {
  success: boolean; // true if status was "completed" or "skipped"
  testId: string; // Test ID
  testName?: string; // From start event
  suiteId?: string; // From start event (legacy suite API)
  suiteName?: string; // From start event (legacy suite API)
  events: TimelineEvent[]; // All timeline events in chronological order
  error?: string; // From status event
  stack?: string; // From status event
  duration: number; // Wall-clock execution time in ms
  retryCount?: number; // Retry attempt (from start event, undefined on first attempt)
  assertionCount: number; // Total assertions across the test (always present)
  failedAssertionCount: number; // Failed assertions across the test (always present)
  peakMemoryBytes?: number; // From status event
  peakMemoryMB?: string; // From status event
}
```

**Server note:** `assertionCount` and `failedAssertionCount` are pre-computed — no need to iterate `events[]` to count assertions. The `summary` event provides additional breakdowns (step counts, HTTP stats).

---

## TimelineEvent Types Summary

| Type         | Source               | Frequency    | Has `stepIndex`   | Key Fields                                                                |
| ------------ | -------------------- | ------------ | ----------------- | ------------------------------------------------------------------------- |
| `log`        | `ctx.log()`          | 0–N per test | Yes               | `message`, `data`                                                         |
| `assertion`  | `ctx.assert()`       | 0–N per test | Yes               | `passed`, `message`, `actual`, `expected`                                 |
| `trace`      | `ctx.http.*`         | 0–N per test | Yes               | `data` (ApiTrace)                                                         |
| `metric`     | `ctx.metric()`, auto | 0–N per test | Yes               | `name`, `value`, `unit`, `tags`                                           |
| `step_start` | builder steps        | 0–N per test | N/A (has `index`) | `index`, `name`, `total`                                                  |
| `step_end`   | builder steps        | 0–N per test | N/A (has `index`) | `index`, `name`, `status`, `durationMs`, `assertions`, `failedAssertions` |
| `summary`    | harness              | 1 per test   | No                | HTTP + assertion + step aggregate stats                                   |

---

## Example Timeline (Multi-Step Test)

A typical builder test with 3 steps where step 2 fails:

```json
{"type":"step_start","ts":5,"index":0,"name":"create user","total":3}
{"type":"log","ts":6,"stepIndex":0,"message":"Creating user..."}
{"type":"trace","ts":120,"stepIndex":0,"data":{"method":"POST","url":"/users","status":201,"duration":114}}
{"type":"metric","ts":120,"stepIndex":0,"name":"http_duration_ms","value":114,"unit":"ms","tags":{"method":"POST","path":"/users"}}
{"type":"assertion","ts":121,"stepIndex":0,"passed":true,"message":"User created"}
{"type":"step_end","ts":122,"index":0,"name":"create user","status":"passed","durationMs":117,"assertions":1,"failedAssertions":0}
{"type":"step_start","ts":123,"index":1,"name":"verify email","total":3}
{"type":"trace","ts":250,"stepIndex":1,"data":{"method":"GET","url":"/users/1/email","status":404,"duration":126}}
{"type":"assertion","ts":251,"stepIndex":1,"passed":false,"message":"Email should exist","actual":404,"expected":200}
{"type":"step_end","ts":252,"index":1,"name":"verify email","status":"failed","durationMs":129,"assertions":1,"failedAssertions":1}
{"type":"step_end","ts":252,"index":2,"name":"cleanup","status":"skipped","durationMs":0,"assertions":0,"failedAssertions":0}
{"type":"log","ts":253,"message":"Running teardown..."}
{"type":"summary","ts":280,"data":{"httpRequestTotal":2,"httpErrorTotal":1,"httpErrorRate":0.5,"assertionTotal":2,"assertionFailed":1,"stepTotal":3,"stepPassed":1,"stepFailed":1,"stepSkipped":1}}
```

---

## Server Integration Checklist

### Core

- [ ] Parse `TimelineEvent[]` from `ExecutionResult.events`
- [ ] Use `ExecutionResult.assertionCount` / `failedAssertionCount` for result cards (no iteration needed)
- [ ] Use `summary` event for aggregate stats (HTTP, assertions, steps)
- [ ] Use `ExecutionResult.retryCount` to track retry attempts

### Step Visualization

- [ ] Store `step_start` / `step_end` events for workflow visualization
- [ ] Use `stepIndex` on log/assertion/trace/metric events to group them under their step
- [ ] Calculate per-step duration trends from `step_end.durationMs`
- [ ] Track step-level pass rates from `step_end.status`

### API Observability

- [ ] Build API trace waterfall from `trace` events
- [ ] Aggregate `metric` events into time-series (especially `http_duration_ms`)
- [ ] Use `summary.data.httpErrorRate` for quick health alerts

### Resource Monitoring

- [ ] Display `peakMemoryBytes` trend for memory regression detection
