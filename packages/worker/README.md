# @glubean/worker

Self-hosted Glubean worker for test execution.

This package provides a worker that connects to the Glubean ControlPlane to execute test bundles. It can be used for:

- **Self-hosted runners**: Run tests on your own infrastructure
- **Cloud workers**: Used by Glubean Cloud infrastructure
- **Custom integrations**: Embed worker functionality in your own applications

## Installation

```bash
# Install globally
deno install -A -n glubean-worker jsr:@glubean/worker/cli

# Or run directly
deno run -A jsr:@glubean/worker/cli
```

## Quick Start

### Using Environment Variables

```bash
export GLUBEAN_CONTROL_PLANE_URL=https://api.glubean.com
export GLUBEAN_WORKER_TOKEN=gwt_xxx
glubean-worker
```

### Using Config File

Create `worker.json`:

```json
{
  "controlPlaneUrl": "https://api.glubean.com",
  "workerToken": "gwt_xxx",
  "workerId": "my-private-runner",
  "logLevel": "info",
  "tags": ["tier:pro", "team:acme"]
}
```

Run:

```bash
glubean-worker --config ./worker.json
```

## Configuration

| Environment Variable            | Description                                 | Default        |
| ------------------------------- | ------------------------------------------- | -------------- |
| `GLUBEAN_CONTROL_PLANE_URL`     | Control plane API URL                       | (required)     |
| `GLUBEAN_WORKER_TOKEN`          | Worker authentication token                 | (required)     |
| `GLUBEAN_WORKER_ID`             | Worker identifier                           | auto-generated |
| `GLUBEAN_WORKER_TAGS`           | Tags for task matching (comma-separated)    | (none)         |
| `GLUBEAN_LOG_LEVEL`             | Log level (debug, info, warn, error)        | `info`         |
| `GLUBEAN_MAX_CONCURRENT_TASKS`  | Max concurrent tasks per worker             | `1`            |
| `GLUBEAN_TASK_MEMORY_LIMIT_MB`  | Memory limit per task in MB (0 = unlimited) | `0`            |
| `GLUBEAN_EXECUTION_TIMEOUT_MS`  | Test execution timeout                      | `300000`       |
| `GLUBEAN_EXECUTION_CONCURRENCY` | Max parallel tests within a task            | `1`            |

## Concurrent Task Execution

By default, each worker processes one task at a time. For self-hosted workers with ample resources, you can increase
concurrency:

```bash
# Run 5 tasks concurrently (for 8GB+ machines)
export GLUBEAN_MAX_CONCURRENT_TASKS=5
export GLUBEAN_TASK_MEMORY_LIMIT_MB=500  # Optional: limit each task to 500MB
```

**When to increase concurrency:**

- API tests are I/O-bound (waiting for network)
- You have dedicated resources (self-hosted)
- CPU utilization is low with single task

**Keep concurrency at 1 when:**

- Running on shared infrastructure (Glubean Cloud)
- Tests are CPU/memory intensive
- Predictable resource usage is required

## Kubernetes Deployment

### Basic Deployment (Shared Workers)

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: glubean-worker-config
data:
  GLUBEAN_CONTROL_PLANE_URL: "https://api.glubean.com"
  GLUBEAN_LOG_LEVEL: "info"
  GLUBEAN_EXECUTION_CONCURRENCY: "3"
---
apiVersion: v1
kind: Secret
metadata:
  name: glubean-worker-secrets
type: Opaque
stringData:
  GLUBEAN_WORKER_TOKEN: "gwt_your_token_here"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: glubean-worker
spec:
  replicas: 2
  selector:
    matchLabels:
      app: glubean-worker
  template:
    metadata:
      labels:
        app: glubean-worker
    spec:
      containers:
        - name: worker
          image: denoland/deno:latest
          command: ["deno", "run", "-A", "jsr:@glubean/worker/cli"]
          envFrom:
            - configMapRef:
                name: glubean-worker-config
            - secretRef:
                name: glubean-worker-secrets
          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "512Mi"
              cpu: "500m"
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: glubean-worker-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: glubean-worker
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
```

### Tiered Workers (Free / Pro / Enterprise)

```yaml
# Shared workers for Free tier
apiVersion: apps/v1
kind: Deployment
metadata:
  name: glubean-worker-free
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: worker
          image: denoland/deno:latest
          command: ["deno", "run", "-A", "jsr:@glubean/worker/cli"]
          env:
            - name: GLUBEAN_WORKER_TAGS
              value: "tier:free"
            - name: GLUBEAN_EXECUTION_TIMEOUT_MS
              value: "30000" # 30s limit for free
          resources:
            limits:
              memory: "256Mi"
              cpu: "250m"
---
# Priority workers for Pro tier
apiVersion: apps/v1
kind: Deployment
metadata:
  name: glubean-worker-pro
spec:
  replicas: 5
  template:
    spec:
      containers:
        - name: worker
          image: denoland/deno:latest
          command: ["deno", "run", "-A", "jsr:@glubean/worker/cli"]
          env:
            - name: GLUBEAN_WORKER_TAGS
              value: "tier:pro"
            - name: GLUBEAN_EXECUTION_TIMEOUT_MS
              value: "60000" # 60s limit for pro
          resources:
            limits:
              memory: "512Mi"
              cpu: "500m"
---
# Reserved workers for Enterprise (Team: ACME)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: glubean-worker-acme
spec:
  replicas: 2 # Fixed, no autoscaling
  template:
    spec:
      containers:
        - name: worker
          image: denoland/deno:latest
          command: ["deno", "run", "-A", "jsr:@glubean/worker/cli"]
          env:
            - name: GLUBEAN_WORKER_TAGS
              value: "tier:enterprise,team:acme"
            - name: GLUBEAN_EXECUTION_TIMEOUT_MS
              value: "300000" # 5min for enterprise
          resources:
            limits:
              memory: "1Gi"
              cpu: "1000m"
        # Optional: dedicated nodes for enterprise
      nodeSelector:
        dedicated: enterprise
      tolerations:
        - key: "dedicated"
          operator: "Equal"
          value: "enterprise"
          effect: "NoSchedule"
```

### Docker Compose (Development)

```yaml
version: "3.8"
services:
  worker:
    image: denoland/deno:latest
    command: deno run -A jsr:@glubean/worker/cli
    environment:
      GLUBEAN_CONTROL_PLANE_URL: http://api:3000
      GLUBEAN_WORKER_TOKEN: ${WORKER_TOKEN}
      GLUBEAN_LOG_LEVEL: debug
    deploy:
      replicas: 2
```

## Embedding in Applications

```typescript
import { ControlPlaneClient, createLogger, loadConfig, startWorkerLoop } from "@glubean/worker";

const config = loadConfig();
const logger = createLogger(config);
const client = new ControlPlaneClient({
  baseUrl: config.controlPlaneUrl,
  workerToken: config.workerToken,
  timeoutMs: config.controlPlaneTimeoutMs,
  maxRetries: config.controlPlaneMaxRetries,
});

const shutdown = await startWorkerLoop({ config, client, logger });

// Handle graceful shutdown
Deno.addSignalListener("SIGTERM", shutdown);
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Glubean ControlPlane                      │
│                   (Cloud API Server)                        │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │ HTTPS (outbound only)
                            │
┌─────────────────────────────────────────────────────────────┐
│                    @glubean/worker                          │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │   Client    │  │    Loop     │  │  Executor   │        │
│  │   (API)     │──│  (Claim→    │──│  (Tests)    │        │
│  │             │  │   Execute)  │  │             │        │
│  └─────────────┘  └─────────────┘  └─────────────┘        │
│                                           │                 │
│                                           ▼                 │
│                                   ┌─────────────┐          │
│                                   │ @glubean/   │          │
│                                   │   runner    │          │
│                                   └─────────────┘          │
└─────────────────────────────────────────────────────────────┘
```

### Tiered Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Task Queue                             │
│                  (Filtered by tags)                         │
└─────────────────────────────────────────────────────────────┘
        │                    │                    │
        │ tier:free          │ tier:pro           │ tier:enterprise
        ▼                    ▼                    │ team:acme
┌───────────────┐   ┌───────────────┐            ▼
│ Shared Pool   │   │ Priority Pool │   ┌───────────────┐
│ (HPA 2-20)    │   │ (Fixed 5)     │   │ Reserved Pool │
│ 256MB, 30s    │   │ 512MB, 60s    │   │ (Fixed 2)     │
└───────────────┘   └───────────────┘   │ 1GB, 5min     │
                                        └───────────────┘
```

## Key Features

- **Outbound-only connectivity**: No inbound ports required
- **Secure by default**: Task-scoped tokens, secret redaction
- **Event streaming**: Live test output to dashboard
- **Automatic retry**: Exponential backoff on failures
- **Graceful shutdown**: Clean task completion on SIGTERM
- **Tag-based routing**: Route tasks to specific worker pools
- **Kubernetes native**: HPA, resource limits, node selectors

## License

MIT
