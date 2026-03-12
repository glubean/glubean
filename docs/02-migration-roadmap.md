# 实现路线：OSS Node.js 迁移

## 迁移范围

8 个 OSS 包，按依赖顺序迁移：

```
Phase 1: sdk → runner → scanner → cli (核心链路)
Phase 2: redaction → auth → graphql (插件)
Phase 3: worker → mcp (执行器)
```

## Phase 1: 核心链路 (发布阻断)

### 1.1 @glubean/sdk

| 项 | 状态 | 说明 |
|----|------|------|
| 类型定义 (types.ts) | ✅ spike 完成 | 纯类型，无 Deno 依赖 |
| test builder (index.ts) | ✅ spike 完成 | `Deno.env.get` → `process.env` |
| data loaders (data.ts) | ✅ spike 完成 | `Deno.readTextFile` → `node:fs/promises`, `@std/yaml` → `yaml` npm |
| expect API (expect.ts) | ✅ spike 完成 | 纯逻辑，去掉 deno-lint 注释 |
| configure (configure.ts) | ✅ spike 完成 | 纯逻辑 |
| plugin system (plugin.ts) | ✅ spike 完成 | 纯逻辑 |
| internal (internal.ts) | ✅ spike 完成 | 纯逻辑 |
| **npm pack 验证** | ❌ 未做 | 需要构建产物，不能发布源码 .ts |
| **exports/types 策略** | ❌ 未做 | 需要 tsup/unbuild 构建 .js + .d.ts |

### 1.2 @glubean/runner

| 项 | 状态 | 说明 |
|----|------|------|
| executor.ts | ✅ spike 完成 | `Deno.Command` → `child_process.spawn` |
| harness.ts | ✅ spike 完成 | 全面替换 Deno API，parseArgs 改为 node:util |
| resolve.ts | ✅ spike 完成 | 纯逻辑 |
| config.ts | ✅ spike 完成 | 权限模型简化 |
| network_policy.ts | ✅ spike 完成 | 纯逻辑 |
| network_budget.ts | ✅ spike 完成 | 纯逻辑 |
| thresholds.ts | ✅ spike 完成 | 纯逻辑 |
| **npm pack 验证** | ❌ 未做 | |
| **harness 打包策略** | ❌ 未做 | harness 需要作为独立文件被 executor spawn，打包方式需确认 |
| **worker_threads 模式** | ❌ 未做 | VSCode 关键路径。harness 逻辑抽取为共享模块，spawn/worker 双入口 |
| **executor 双模式接口** | ❌ 未做 | `execute(file, id, ctx, { mode: "spawn" \| "worker" })`，CLI 默认 spawn，VSCode 默认 worker |

### 1.3 @glubean/scanner

| 项 | 状态 | 说明 |
|----|------|------|
| 静态模式 (regex) | ❌ 未迁移 | 纯逻辑，预计简单 |
| 运行时模式 (import) | ❌ 未迁移 | 需要 tsx 动态 import |
| hash 计算 | ❌ 未迁移 | `@std/crypto` → `node:crypto` |

### 1.4 @glubean/cli

| 项 | 状态 | 说明 |
|----|------|------|
| `gb run` (最小版) | ✅ spike 完成 | discover + execute + 输出 |
| `gb init` | ❌ 未迁移 | @cliffy/prompt → enquirer |
| `gb scan` | ❌ 未迁移 | 依赖 scanner |
| `gb sync` | ❌ 未迁移 | Cloud upload |
| `gb trigger` | ❌ 未迁移 | Cloud remote execution |
| `gb login` | ❌ 未迁移 | OAuth flow |
| `gb upgrade` | ❌ 未迁移 | 自更新 (npm 有原生方案) |
| output formats | ❌ 未迁移 | JSON, JUnit XML, per-file logs |
| env file loading | ❌ 未迁移 | .env support |

## Phase 2: 插件

### 2.1 @glubean/redaction
- 纯 TypeScript + regex，预计零改动。
- 无外部依赖。

### 2.2 @glubean/auth
- 依赖 sdk。`@std/encoding` → `node:buffer`。
- 其余纯逻辑。

### 2.3 @glubean/graphql
- 依赖 sdk。纯 TypeScript，预计零改动。

## Phase 3: 执行器

### 3.1 @glubean/worker
- 子进程 fork、lease 协议、系统信息采集。
- `@std/tar` → `tar` npm。其余类似 runner。

### 3.2 @glubean/mcp
- 依赖 runner + scanner。
- 纯逻辑 orchestration，预计简单。

## 构建与发布策略

### 当前 spike 状态
- package.json `exports` 直接指向 `.ts` 源码 — 仅在 monorepo + tsx 环境下可用。

### 正式迁移需要
1. **构建工具**: tsup 或 unbuild
   - 输出: ESM `.js` + `.d.ts` 类型声明
   - 每个包独立构建
2. **package.json exports**:
   ```json
   {
     "exports": {
       ".": {
         "import": "./dist/index.js",
         "types": "./dist/index.d.ts"
       }
     }
   }
   ```
3. **harness 特殊处理**: executor 需要知道 harness.js 的绝对路径，打包后路径要稳定。
4. **npm publish**: 每个包独立版本，`workspace:*` 在发布时转为实际版本号 (pnpm 自动处理)。

## 消费者更新

迁移完成后，以下消费者需要同步更新：

| 消费者 | 改动 |
|--------|------|
| glubean-v1 (Cloud) | runner import 路径更新 |
| vscode extension | 从 Deno subprocess → Node subprocess |
| collections | import 从 JSR → npm |
| cookbook | 示例更新 |
| docs | 安装说明、依赖要求更新 |
