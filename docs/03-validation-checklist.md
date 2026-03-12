# 验证清单：Node.js 迁移发布门禁

每个 P0 项必须通过才能发布。P1 项在首发后 2 周内完成。

---

## P0 — 发布阻断项

### 打包与安装

| # | 项 | 验收标准 | 状态 |
|---|-----|---------|------|
| P0-1 | 干净安装验证 | 在全新空目录 `npm/pnpm add @glubean/sdk @glubean/cli`，不依赖 monorepo/workspace/本地源码，`import "@glubean/sdk"` 成功 | ❌ |
| P0-2 | npm pack 产物验证 | 每个包 `npm pack` 后 tarball 只含 dist/、package.json、README；无 src/*.ts、绝对路径、workspace 软链 | ❌ |
| P0-3 | exports 可用性 | Node ESM 能 `import`；TypeScript 能拿到类型补全；CLI `gb` 命令可执行 | ❌ |
| P0-4 | Node 版本矩阵 | Node 20 (LTS) + Node 22 (LTS) 均通过。tsx 声称支持 18+，需实际验证 | ❌ |
| P0-5 | 无 Deno 残留 | 发布包内 grep 无 `Deno.`、`deno.json`、`--allow-*`、`@std/`、JSR import | ❌ |

### 端到端功能

| # | 项 | 验收标准 | 状态 |
|---|-----|---------|------|
| P0-6 | CLI 端到端 | 从用户视角 `gb run .`：发现测试、执行、正确 exit code、可读输出 | ✅ spike 验证 |
| P0-7 | SDK 最小用户链路 | 第三方项目 `import { test } from "@glubean/sdk"` 写测试并运行成功，不需要了解 monorepo 结构 | ❌ workspace 内通过，clean temp project 未验证 |
| P0-8 | 构建/类型检查闭环 | `tsc --noEmit` 全绿，构建产物可用，无缺失 @types/node | ⚠️ 指定 `-p` 通过，裸跑报 TS2688 (types resolve 不完整) |
| P0-9 | 文档与实际一致 | README 安装 + 首个示例可逐字复现成功 | ❌ (文档未写) |

### 功能覆盖

| # | 项 | 验收标准 | 状态 |
|---|-----|---------|------|
| P0-10 | 模块加载格式 | `.ts` `.mts` `.js` `.mjs` 均可加载执行 | ⚠️ 仅 `.ts` 已实测，其他格式仅代码支持未验证 |
| P0-11 | 测试发现 | `test()`、builder、`test.each`、`test.pick` 均能发现 | ⚠️ 仅 `test()` 已验证 |
| P0-12 | 执行模型稳定性 | 正常执行、失败、异常抛出、超时 — 都正确回传状态 | ⚠️ 仅正常执行已验证 |
| P0-13 | 退出码语义 | 全通过 → 0；有失败 → 非 0；skip → 不误报 | ⚠️ 仅全通过已验证 |
| P0-14 | 路径解析 | 从项目根目录和子目录启动，行为一致 | ❌ |

---

## P1 — 高优但非首发阻断

| # | 项 | 验收标准 | 状态 |
|---|-----|---------|------|
| P1-1 | 多步测试 | setup/step/teardown 行为正确，步骤事件完整，失败短路，teardown 必执行 | ❌ |
| P1-2 | test.each / test.pick | discover 到的 test id 与执行时定位逻辑一致 | ❌ |
| P1-3 | test.extend() | simple fixture 和 lifecycle fixture 正常，use() 只调用一次，清理生效 | ❌ |
| P1-4 | vars / secrets / configure() | 显式传值、环境变量回退、缺失报错 | ❌ |
| P1-5 | HTTP 能力 | ctx.http 请求、超时、错误、响应大小限制、trace 采集 | ❌ |
| P1-6 | 并发执行 | executeMany、fail-fast、fail-after、并发数受控、无串扰 | ❌ |
| P1-7 | 内存与超时控制 | NODE_OPTIONS heap 限制、timeout 终止、OOM 可理解错误 | ❌ |
| P1-8 | 跨平台 | macOS + Linux 均通过 (CI 覆盖) | ❌ |
| P1-9 | 包管理器兼容 | npm / yarn / pnpm 安装后均可正常使用 | ❌ |
| P1-10 | worker_threads 模式 | VSCode 场景：worker 执行冷启动 < 50ms，崩溃不拖垮 host，resourceLimits 生效 | ❌ |
| P1-11 | spawn/worker 结果一致性 | 同一个测试文件在 spawn 和 worker 两种模式下产生相同的事件序列和最终状态 | ❌ |

---

## Spike 已验证 vs 未验证

### ✅ Spike 已证明

- tsx 可以执行 glubean 测试文件 (SDK test builder + ctx.*)
- child_process.spawn 替代 Deno.Command 的子进程模型可行
- stdin/stdout JSON 事件流协议在 Node 下正常工作
- pnpm workspace monorepo 结构可行
- tsx 路径解析 (createRequire) 在 pnpm 严格模式下可行
- 最小 CLI `gb run` 端到端跑通
- tsc 类型检查通过

### ❌ Spike 未覆盖

- npm pack 后的真实产物可用性
- 非 monorepo 环境的 clean install
- 复杂测试形态 (multi-step, each, pick, extend, fixture)
- HTTP client (ctx.http) 完整链路
- 失败/超时/OOM 场景
- Node 20/22 版本兼容性
- 多包管理器兼容性
- VSCode extension 集成 (冷启动时间、内存占用)

---

## 自动化验证方案

### CI 矩阵 (GitHub Actions)

```yaml
strategy:
  matrix:
    node: [20, 22]
    os: [ubuntu-latest, macos-latest]
```

### Smoke Test 脚本 (P0-1 干净安装)

```bash
# 在 CI 中执行
dir=$(mktemp -d)
cd "$dir"
npm init -y
npm add @glubean/sdk @glubean/cli
cat > hello.test.ts << 'EOF'
import { test } from "@glubean/sdk";
export const hello = test("smoke", async (ctx) => {
  ctx.assert(true, "works");
});
EOF
npx gb run .
# exit code 必须为 0
```

### Pack 验证脚本 (P0-2)

```bash
for pkg in sdk runner scanner cli; do
  cd "packages/$pkg"
  npm pack --dry-run 2>&1 | grep -E '\.(ts)$' && echo "FAIL: .ts in pack" && exit 1
  cd ../..
done
```

### Deno 残留检查 (P0-5)

```bash
for pkg in sdk runner scanner cli; do
  cd "packages/$pkg/dist"
  grep -rn 'Deno\.\|deno\.json\|--allow-\|jsr:' . && echo "FAIL: Deno remnant" && exit 1
  cd ../../..
done
```
