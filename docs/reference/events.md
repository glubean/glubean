# Event Reference

Every event type emitted by the Glubean runner during test execution.

## Event Lifecycle

```
start → [log | assertion | trace | metric | step_start | step_end]* → summary → status
```

All events are JSON lines on stdout. The executor parses them into timestamped `TimelineEvent` objects.

## Transport

Events are emitted by the **harness** (sandboxed subprocess) as JSON lines on stdout:

```json
{ "type": "log", "message": "Hello", "stepIndex": 0 }
```

The **executor** (parent process) reads these lines, adds `ts` (milliseconds since execution start) and an optional
`testId` (for batch execution), then exposes them as `TimelineEvent` objects.

### Common Fields

| Field       | Type      | Description                                                      |
| ----------- | --------- | ---------------------------------------------------------------- |
| `ts`        | `number`  | Milliseconds since test execution started                        |
| `testId`    | `string?` | Present in batch execution to identify which test owns the event |
| `stepIndex` | `number?` | Zero-based index of the containing builder step (if applicable)  |

---

## Event Types

### `start`

Emitted once at the beginning of test execution.

| Field        | Type        | Description                                                |
| ------------ | ----------- | ---------------------------------------------------------- |
| `type`       | `"start"`   | Event type                                                 |
| `id`         | `string`    | Test ID                                                    |
| `name`       | `string`    | Human-readable test name                                   |
| `tags`       | `string[]?` | Test tags                                                  |
| `retryCount` | `number?`   | Whole-test re-run count (omitted when first attempt = `0`) |

`retryCount` reflects execution-level retries orchestrated by the runner/control plane. It is different from step
retries (`StepMeta.retries`), which happen inside a single execution.

---

### `log`

A log message from `ctx.log()`.

| Field       | Type       | Description              |
| ----------- | ---------- | ------------------------ |
| `type`      | `"log"`    | Event type               |
| `ts`        | `number`   | Milliseconds since start |
| `stepIndex` | `number?`  | Containing step index    |
| `message`   | `string`   | Log message              |
| `data`      | `unknown?` | Optional structured data |

---

### `assertion`

Result of `ctx.assert()` or `ctx.expect()`. Does not throw — records the result and continues.

| Field       | Type          | Description                  |
| ----------- | ------------- | ---------------------------- |
| `type`      | `"assertion"` | Event type                   |
| `ts`        | `number`      | Milliseconds since start     |
| `stepIndex` | `number?`     | Containing step index        |
| `passed`    | `boolean`     | Whether the assertion passed |
| `message`   | `string`      | Assertion description        |
| `actual`    | `unknown?`    | Actual value (on failure)    |
| `expected`  | `unknown?`    | Expected value (on failure)  |

---

### `trace`

An HTTP API trace, auto-emitted by `ctx.http` for every request.

| Field       | Type       | Description              |
| ----------- | ---------- | ------------------------ |
| `type`      | `"trace"`  | Event type               |
| `ts`        | `number`   | Milliseconds since start |
| `stepIndex` | `number?`  | Containing step index    |
| `data`      | `ApiTrace` | Trace details            |

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

---

### `metric`

A custom or auto-generated metric from `ctx.metric()` or `ctx.http`.

Metric payloads are not redaction-focused fields. Keep names/tags free of secrets and PII.

| Field       | Type                      | Description                            |
| ----------- | ------------------------- | -------------------------------------- |
| `type`      | `"metric"`                | Event type                             |
| `ts`        | `number`                  | Milliseconds since start               |
| `stepIndex` | `number?`                 | Containing step index                  |
| `name`      | `string`                  | Metric name (e.g., `http_duration_ms`) |
| `value`     | `number`                  | Metric value                           |
| `unit`      | `string?`                 | Unit (e.g., `"ms"`, `"bytes"`)         |
| `tags`      | `Record<string, string>?` | Dimensional tags                       |

**Auto-generated metrics:**

| Name               | Source       | Tags             |
| ------------------ | ------------ | ---------------- |
| `http_duration_ms` | `ctx.http.*` | `method`, `path` |

---

### `step_start`

Emitted when a builder API step begins.

| Field   | Type           | Description              |
| ------- | -------------- | ------------------------ |
| `type`  | `"step_start"` | Event type               |
| `ts`    | `number`       | Milliseconds since start |
| `index` | `number`       | Zero-based step index    |
| `name`  | `string`       | Step name                |
| `total` | `number`       | Total steps in this test |

---

### `step_end`

Emitted when a builder API step completes, fails, or is skipped.

| Field              | Type                                | Description                    |
| ------------------ | ----------------------------------- | ------------------------------ |
| `type`             | `"step_end"`                        | Event type                     |
| `ts`               | `number`                            | Milliseconds since start       |
| `index`            | `number`                            | Zero-based step index          |
| `name`             | `string`                            | Step name                      |
| `status`           | `"passed" \| "failed" \| "skipped"` | Step outcome                   |
| `durationMs`       | `number`                            | Step execution time            |
| `assertions`       | `number`                            | Total assertions in this step  |
| `failedAssertions` | `number`                            | Failed assertions in this step |
| `error`            | `string?`                           | Error message (if step threw)  |

**Step status rules:**

- **`passed`**: Completed without errors, all assertions passed.
- **`failed`**: Threw an error or had failed assertions.
- **`skipped`**: A previous step failed; this step was not executed.

**Failure propagation:**

```
step_start(0) → step_end(0, passed) → step_start(1) → step_end(1, failed) → step_end(2, skipped) → teardown → summary → status(failed)
```

---

### `summary`

Test execution summary. Always emitted once before the final `status` event.

Summary data is aggregate telemetry. Do not place sensitive values in custom summary-like payloads emitted by user code.

| Field                   | Type        | Description                      |
| ----------------------- | ----------- | -------------------------------- |
| `type`                  | `"summary"` | Event type                       |
| `ts`                    | `number`    | Milliseconds since start         |
| `data.httpRequestTotal` | `number`    | Total HTTP requests              |
| `data.httpErrorTotal`   | `number`    | HTTP requests with status >= 400 |
| `data.httpErrorRate`    | `number`    | Error rate (0.0 - 1.0)           |
| `data.assertionTotal`   | `number`    | Total assertions                 |
| `data.assertionFailed`  | `number`    | Failed assertions                |
| `data.stepTotal`        | `number`    | Total steps (0 for simple tests) |
| `data.stepPassed`       | `number`    | Steps that passed                |
| `data.stepFailed`       | `number`    | Steps that failed                |
| `data.stepSkipped`      | `number`    | Steps skipped                    |

---

### `status`

Final test outcome. Always the last event.

| Field             | Type                                   | Description                    |
| ----------------- | -------------------------------------- | ------------------------------ |
| `type`            | `"status"`                             | Event type                     |
| `status`          | `"completed" \| "failed" \| "skipped"` | Final outcome                  |
| `error`           | `string?`                              | Error message (on failure)     |
| `stack`           | `string?`                              | Stack trace (on failure)       |
| `reason`          | `string?`                              | Skip reason (via `ctx.skip()`) |
| `peakMemoryBytes` | `number?`                              | Peak heap usage in bytes       |

---

## ExecutionResult

The executor collects all events into a final result:

```typescript
interface ExecutionResult {
  success: boolean;
  testId: string;
  testName?: string;
  events: TimelineEvent[];
  error?: string;
  stack?: string;
  duration: number;
  retryCount?: number;
  assertionCount: number;
  failedAssertionCount: number;
  peakMemoryBytes?: number;
}
```

---

## Timeline Summary

| Type         | Source         | Frequency    | Has `stepIndex` | Key Fields                                |
| ------------ | -------------- | ------------ | --------------- | ----------------------------------------- |
| `log`        | `ctx.log()`    | 0–N per test | Yes             | `message`, `data`                         |
| `assertion`  | `ctx.assert()` | 0–N per test | Yes             | `passed`, `message`, `actual`, `expected` |
| `trace`      | `ctx.http.*`   | 0–N per test | Yes             | `data` (ApiTrace)                         |
| `metric`     | `ctx.metric()` | 0–N per test | Yes             | `name`, `value`, `unit`, `tags`           |
| `step_start` | builder steps  | 0–N per test | N/A (has index) | `index`, `name`, `total`                  |
| `step_end`   | builder steps  | 0–N per test | N/A (has index) | `index`, `name`, `status`, `durationMs`   |
| `summary`    | harness        | 1 per test   | No              | HTTP + assertion + step aggregate stats   |

---

## Example Timeline

A builder test with 3 steps where step 2 fails:

```json
{"type":"step_start","ts":5,"index":0,"name":"create user","total":3}
{"type":"log","ts":6,"stepIndex":0,"message":"Creating user..."}
{"type":"trace","ts":120,"stepIndex":0,"data":{"method":"POST","url":"/users","status":201,"duration":114}}
{"type":"assertion","ts":121,"stepIndex":0,"passed":true,"message":"User created"}
{"type":"step_end","ts":122,"index":0,"name":"create user","status":"passed","durationMs":117,"assertions":1,"failedAssertions":0}
{"type":"step_start","ts":123,"index":1,"name":"verify email","total":3}
{"type":"trace","ts":250,"stepIndex":1,"data":{"method":"GET","url":"/users/1/email","status":404,"duration":126}}
{"type":"assertion","ts":251,"stepIndex":1,"passed":false,"message":"Email should exist","actual":404,"expected":200}
{"type":"step_end","ts":252,"index":1,"name":"verify email","status":"failed","durationMs":129,"assertions":1,"failedAssertions":1}
{"type":"step_end","ts":252,"index":2,"name":"cleanup","status":"skipped","durationMs":0,"assertions":0,"failedAssertions":0}
{"type":"summary","ts":280,"data":{"httpRequestTotal":2,"httpErrorTotal":1,"httpErrorRate":0.5,"assertionTotal":2,"assertionFailed":1,"stepTotal":3,"stepPassed":1,"stepFailed":1,"stepSkipped":1}}
```
