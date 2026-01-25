# Glubean Data Structures

## 1. Test Bundle (The Artifact)

When a user runs `glubean sync`, the CLI generates a "Bundle". In the Deno world, this isn't a single JS file, but a logical collection of source files and metadata.

### 1.1 `metadata.json`

This file is the "Index" of the bundle. It tells the platform what tests are available without parsing code.

```json
{
  "schemaVersion": "1",
  "specVersion": "2.0",
  "generatedBy": "@glubean/cli@0.2.0",
  "generatedAt": "2026-02-04T12:00:00Z",
  "rootHash": "sha256-...",
  "version": "1.0.0",
  "projectId": "proj_123",
  "testCount": 3,
  "fileCount": 2,
  "tags": ["auth", "smoke"],
  "files": {
    "auth/login.ts": {
      "hash": "sha256-...",
      "exports": [
        {
          "type": "testCase",
          "exportName": "simpleTest",
          "id": "simple-test",
          "name": "Simple Test",
          "tags": ["smoke"],
          "location": { "line": 10, "col": 1 }
        },
        {
          "type": "testSuite",
          "exportName": "authSuite",
          "id": "auth-flow",
          "name": "Authentication Flow",
          "tags": ["auth"],
          "tests": [
            {
              "id": "auth-flow:Login Success",
              "name": "Login Success",
              "tags": ["critical"]
            },
            {
              "id": "auth-flow:Login Fail",
              "name": "Login Fail"
            }
          ],
          "location": { "line": 25, "col": 1 }
        }
      ]
    },
    "utils/api.ts": {
      "hash": "sha256-...",
      "exports": []
    }
  }
}
```

**Notes:**

- `version` and `projectId` are optional when metadata is generated locally (e.g. pre-commit or GitHub builds).
- `rootHash` is computed from sorted `<path>:<hash>` entries joined by `\\n`.

### 1.2 Storage Structure (S3/R2)

We store files with a content-addressable naming scheme (CAS) or a versioned folder structure to support immutable deployments. **The bucket is PRIVATE.**

**Structure:**

```
s3://glubean-registry-private/
  ├── projects/
  │   └── {projectId}/
  │       └── bundles/
  │           └── {bundleId}/ (e.g. git commit hash or timestamp)
  │               ├── metadata.json
  │               ├── auth/
  │               │   └── login.ts
  │               └── utils/
  │                   └── api.ts
```

## 2. Execution Payload (The Trigger)

When the Platform triggers a run (via AWS EventBridge or API), it sends this payload to the Runner.

```json
{
  "runId": "run_abc123",
  "bundle": {
    "url": "https://registry.glubean.com/projects/p1/bundles/b1/", // Presigned URL
    "entryFile": "auth/login.ts"
  },
  "target": {
    "type": "specific",
    // Format: "ExportName" or "ExportName:TestName"
    "testIds": ["authSuite:Login Success"]
  },
  "context": {
    "envId": "env_staging",
    "vars": {
      "BASE_URL": "https://api.staging.com"
    },
    "secrets": {
      "API_KEY": "encrypted:kms:...", // Runner decrypts this
      "DENO_AUTH_TOKENS": "token@private.com" // For private imports
    }
  }
}
```

## 3. Result Stream (The Output)

The Runner streams these events back to the Platform (via stdout or HTTP callback).

### 3.1 Log Event

```json
{
  "type": "log",
  "runId": "run_abc123",
  "testId": "authSuite:Login Success",
  "level": "info",
  "message": "Starting login flow",
  "timestamp": 1715432105
}
```

### 3.2 Assertion Event

```json
{
  "type": "assertion",
  "runId": "run_abc123",
  "testId": "authSuite:Login Success",
  "passed": true,
  "message": "Status code is 200",
  "details": {
    "expected": 200,
    "actual": 200
  },
  "timestamp": 1715432106
}
```

### 3.3 Trace Event (Network)

```json
{
  "type": "trace",
  "runId": "run_abc123",
  "testId": "authSuite:Login Success",
  "request": {
    "method": "POST",
    "url": "https://api.staging.com/login",
    "headers": { "Content-Type": "application/json" }
  },
  "response": {
    "status": 200,
    "duration": 150
  },
  "timestamp": 1715432106
}
```

### 3.4 Result Event (Final Status)

```json
{
  "type": "result",
  "runId": "run_abc123",
  "testId": "authSuite:Login Success",
  "status": "passed", // passed, failed, error, skipped
  "duration": 250,
  "timestamp": 1715432107
}
```

## 4. Design Rationale

1.  **Metadata Hierarchy:** `metadata.json` now supports nested `testSuite` structures, enabling the UI to show a tree view (Suite -> Tests).
2.  **Addressing Strategy:** Tests within suites are addressed by a composite ID (e.g., `SuiteExport:TestName`) to ensure uniqueness and allow granular execution.
3.  **Source Preservation:** Storing original `.ts` files (instead of a bundle) makes debugging easier. If a test fails, the stack trace points to `auth/login.ts:10`, which matches the user's local file.
4.  **Private Registry:** S3 bucket is private. Access is granted via Presigned URLs (for Runner) or API (for CLI).
5.  **Private Imports:** Supported via `DENO_AUTH_TOKENS` injected into secrets.
