# 技术方案：Deno → Node.js 运行时迁移

## 动机

1. **安装摩擦** — 用户反馈 Deno 是 Glubean 最大的采用障碍，大部分人连 `deno install` 都不知道。
2. **VSCode 零安装** — Deno 时代 VSCode 插件必须依赖外部 CLI（Deno + glubean CLI），用户装完插件还要配环境。Node 迁移后，runner 可以直接内嵌到 VSCode 扩展中（同一个 Node 运行时），用户装完插件即可跑测试，**安装步骤从 5 步降到 3 步**。
3. **开发体验** — JSR 依赖在 VS Code 里无法跳转、代码导航差，Deno 插件不稳定。
4. **生态局限** — gRPC、Playwright、原生数据库驱动、N-API 模块在 Deno 里要么不可能，要么不稳定。
5. **时机** — 零用户阶段，迁移成本最低。Node 24+ 原生支持 TypeScript（部分语法），tsx 补齐剩余。

### 用户旅程对比

**Deno 时代 (5 步)：**
1. 安装 Deno runtime
2. 安装 glubean CLI (`deno install`)
3. 安装 VS Code 插件
4. 配置 deno.json + import map
5. 写测试

**Node 时代 (3 步)：**
1. 安装 VS Code 插件 (内嵌 runner + tsx)
2. `npm add -D @glubean/sdk`
3. 写测试

CLI 变为可选工具 — CI 环境和命令行用户按需安装，不再是必须前置步骤。

## 核心决策

| 维度 | Deno (现状) | Node.js (目标) |
|------|-------------|----------------|
| TS 执行 | 原生 | tsx (Node 24 原生仅支持部分语法) |
| 包管理 | JSR + import maps | npm/pnpm + node_modules |
| 模块系统 | ESM only | ESM (type: module) |
| 权限系统 | `--allow-*` 沙箱 | 无 (本地执行可接受) |
| HTTP 客户端 | ky (npm compat) | ky (原生 npm) |
| 子进程隔离 | `Deno.Command` | `child_process.spawn` |
| 测试文件格式 | `.test.ts` only | `.test.ts/.js/.mts/.mjs` |

## 执行模型：双模式架构

Node.js 迁移解锁了 Deno 做不到的执行优化 — **worker_threads**。最终架构是双模式：

### CLI 模式：child_process.spawn

CLI (`gb run`) 和 Cloud 执行使用子进程隔离，和 Deno 时代一致：

```
CLI / Cloud
  └─ executor.spawn("node", [tsx, harness.ts, ...args])
       ├─ stdin  ← JSON context (vars, secrets, test metadata)
       └─ stdout → NDJSON events (assertions, logs, traces, status)
```

- 每个测试文件一个独立进程，完全隔离
- 进程崩溃不影响主进程
- OOM / 超时可通过 kill 信号强制终止

### VSCode 模式：内嵌 runner (架构革新)

**Deno 时代**，VSCode 插件必须 spawn 外部 CLI 子进程来跑测试：
```
VSCode Extension (Node.js) → spawn deno → spawn glubean CLI → 执行测试
```
这要求用户机器上有 Deno + CLI 安装，且每次执行有双重进程开销。

**Node 时代**，runner 和 VSCode 插件跑在同一个 Node 运行时里，可以直接内嵌：
```
VSCode Extension Host (Node.js)
  └─ import { TestExecutor } from "@glubean/runner"
       └─ executor.execute(file, testId, context)
            └─ spawn 或 worker_threads 执行 harness
```

这意味着：
- **用户不需要安装任何外部依赖** — runner + tsx 作为 extension 的 bundled dependency
- **测试发现 + 执行都在进程内** — scanner 和 runner 都是 npm 包，直接 import
- **worker_threads 优化成为可能** — explore 模式可以用 worker 替代 spawn，冷启动从 ~200ms 降到 ~20-50ms

### worker_threads 执行 (未来优化)

VSCode explore 模式点击即出结果，spawn 子进程的 ~200ms 冷启动不可接受。内嵌 runner 后可以用 worker_threads：

```
executor.execute(file, testId, context, { mode: "worker" })
  └─ new Worker(harness-worker.js, { workerData: context })
       ├─ parentPort.postMessage(event)  ← 替代 stdout NDJSON
       └─ parentPort.on("message")       → 控制信号 (cancel, timeout)
```

- 冷启动 ~20-50ms（无进程 fork 开销，模块缓存复用）
- 每个 worker 有独立 V8 isolate，崩溃不拖垮 extension host
- `resourceLimits: { maxOldGenerationSizeMb }` 控制内存
- CLI 可通过 `--worker` flag 启用

**实现策略：**
- harness 核心逻辑抽取为共享模块，spawn 和 worker 两种入口复用同一份代码
- executor 统一接口 `execute(file, testId, context, { mode: "spawn" | "worker" })`
- CLI 默认 spawn，VSCode 默认 worker

### 为什么 Deno 做不到

1. **运行时不统一** — VSCode 跑在 Node (Electron)，Deno CLI 是独立运行时，不可能内嵌。
2. **worker 模型不同** — Deno 的 Web Worker 是独立 runtime，冷启动更慢，不支持 `workerData`/`parentPort`/`resourceLimits`。
3. **模块缓存不共享** — Deno worker 不能复用主线程的模块缓存。

## 架构不变量

迁移保持以下架构不变：

- **事件流协议** — harness 输出结构化事件（spawn 用 NDJSON stdout，worker 用 postMessage），executor 收集聚合。
- **SDK 公开 API** — `test()`, `ctx.*`, `configure()`, `definePlugin()` 接口不变。
- **SPEC_VERSION 2.0** — SDK/Scanner/Runner 契约不变。

## 关键技术替换

### Deno API → Node API

| Deno | Node |
|------|------|
| `Deno.readTextFile` | `fs.readFile` (node:fs/promises) |
| `Deno.readDir` | `fs.readdir` (withFileTypes) |
| `Deno.cwd()` | `process.cwd()` |
| `Deno.env.get(key)` | `process.env[key]` |
| `Deno.env.toObject()` | `{ ...process.env }` |
| `Deno.memoryUsage()` | `process.memoryUsage()` |
| `Deno.resolveDns` | `dns.resolve4` (node:dns/promises) |
| `Deno.exit()` | `process.exit()` |
| `Deno.Command` + spawn | `child_process.spawn` |
| `globalThis.addEventListener("error")` | `process.on("uncaughtException")` |
| `parseArgs` (@std/cli) | `parseArgs` (node:util) |

### 依赖替换

| JSR / Deno | npm / Node |
|------------|------------|
| `@std/yaml` | `yaml` |
| `@std/path` | `node:path` |
| `@std/fs` | `node:fs/promises` |
| `@std/assert` | (内置 expect，或 node:assert) |
| `@std/crypto` | `node:crypto` |
| `@std/encoding` | `node:buffer` / native |
| `@std/archive` | `tar` (npm) |
| `@cliffy/command` | `commander` 或 `yargs` |
| `@cliffy/prompt` | `enquirer` 或 `prompts` |

### tsx 路径解析 (pnpm 严格模式)

pnpm 不把 tsx 放到 PATH 里。用 `createRequire` 动态解析：

```ts
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const tsxPath = resolve(dirname(req.resolve("tsx/package.json")), "dist/cli.mjs");
// spawn: node [tsxPath] [harness.ts] [args...]
```

## 新能力 (Deno 做不到的)

- **`.test.js` 支持** — 纯 JavaScript 用户零配置写测试
- **gRPC 插件** — `@grpc/grpc-js` 直接可用
- **Playwright 插件** — browser testing 成为可能
- **原生数据库驱动** — pg, mysql2, redis 直接可用
- **N-API 模块** — 任何 Node 原生模块都能用

## 放弃的能力

- **Deno 权限沙箱** — 本地执行场景可接受。Cloud 执行有独立的容器隔离。
- **JSR 发布** — 改为 npm registry 发布。
- **Deno import maps** — 改为 package.json exports。
