# 迁移问题记录

迁移过程中发现的问题和调用方分歧，供后续包迁移参考。

## SDK 迁移 (已完成)

### 已修复

| 问题 | 文件 | 说明 |
|------|------|------|
| `import("./expect.ts")` 未转 `.js` | types.ts:347 | inline type import 路径遗漏，会导致 Node ESM 解析失败 |
| `deno-lint-ignore` 残留 | types.ts:826, 2085 | 已替换为 eslint-disable 注释 |
| JSDoc 丢失 | data.ts | spike 阶段丢了 275 行文档注释，已恢复 |

### 调用方 import 模式 (无分歧)

所有调用方使用的 SDK sub-path 都已在 package.json exports 中声明：
- `@glubean/sdk` → `./src/index.ts`
- `@glubean/sdk/data` → `./src/data.ts`
- `@glubean/sdk/expect` → `./src/expect.ts`
- `@glubean/sdk/plugin` → `./src/plugin.ts`
- `@glubean/sdk/internal` → `./src/internal.ts`

### 调用方需要注意的变化

| 调用方 | 影响 | 说明 |
|--------|------|------|
| runner/harness.ts | 无 | 已在 spike 中同步迁移 |
| runner/executor.ts | 无 | 只用 type import |
| runner/resolve.ts | 无 | 只用 type import |
| runner/thresholds.ts | 无 | 只用 type import |
| scanner | 待迁移 | 用 `@glubean/sdk/internal` 的 `getRegistry`/`clearRegistry`，Node 下无分歧 |
| auth | 待迁移 | 用 `ConfigureHttpOptions`, `HttpClient`, `TestBuilder`, `TestContext` — 纯类型，无分歧 |
| graphql | 待迁移 | 用 `definePlugin` from `@glubean/sdk/plugin` + 类型 — 无分歧 |
| redaction | 待迁移 | 不直接依赖 SDK |
| cli | 待迁移 | 通过 runner 间接依赖 SDK |
| vscode | 待重构 | 当前用 scanner/static，迁移后改为直接 import runner（内嵌执行） |

## Runner 迁移 (spike 完成，待正式化)

### 已知问题

| 问题 | 说明 |
|------|------|
| harness 打包策略 | harness.ts 需要作为独立文件被 executor spawn。npm pack 后路径要稳定 |
| `as unknown as TestContext` | harness.ts:753 用了 double cast 绕过缺少 http 字段的类型错误，正式迁移需修正 |
| tsx 路径发现 | 用 `createRequire` 解析 tsx dist/cli.mjs，依赖 tsx 内部结构，可能在 tsx 升级时断裂 |

## 通用注意事项

### .ts → .js 扩展名转换

Node ESM 要求 import 路径带扩展名。所有 `.ts` 内部 import 需要写 `.js`：
```ts
// Deno
import { foo } from "./bar.ts";
// Node
import { foo } from "./bar.js";
```

**容易遗漏的地方：**
- inline type import: `import("./foo.ts").SomeType`
- re-export: `export { x } from "./foo.ts"`
- 动态 import: `await import(url)` (url 如果是硬编码的 .ts 路径)

### deno-lint 注释清理

批量替换：
```
deno-lint-ignore no-explicit-any → eslint-disable-next-line @typescript-eslint/no-explicit-any
```
或直接删除（如果 eslint 没有配置对应规则）。

### Deno API 替换清单

每个包迁移时检查：
- `Deno.readTextFile` → `readFile(path, "utf-8")`
- `Deno.readDir` → `readdir(dir, { withFileTypes: true })`
- `Deno.cwd()` → `process.cwd()`
- `Deno.env.get(key)` → `process.env[key]`
- `Deno.exit()` → `process.exit()`
- `Deno.Command` → `child_process.spawn`
- `@std/yaml` → `yaml` npm
- `@std/path` → `node:path`
- `@std/cli` parseArgs → `node:util` parseArgs (注意 API 不同)
