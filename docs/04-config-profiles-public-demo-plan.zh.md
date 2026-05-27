# 配置 Profiles 与 Public Demo 执行计划

日期：2026-05-25

## Revisions

**2026-05-27 (post-first-slice ship — re-sliced Phase 5+6 by audience/coupling)**:

First slice (Phase 1+2+3+4 + multi-suite execution + `--ci` removal) shipped 2026-05-27 (14 atomic commits, 266 cli vitest, dogfood zero-delta). 之后重新审视 Phase 5/6 边界，按"受益人 + 配对依赖"重切，原 plan §Phase 5 的 4 块拆开:

- **Phase 5 (新分块)**: `5a` CLI emit metadata + cloud server persist + `5b` query endpoint + `5c` dashboard UI。受益人 = **任何走 `--upload` 的项目**（agent 用 5b 工具，人浏览 5c）。**不依赖 demo backend**。跨 cli + cloud 2 repo 一个 sprint。`5a` 仍然 cross-repo 一个 PR（server 现状只持久化 `metadata.files` — 单独 ship CLI 等于丢数据）。`5b`/`5c` 在 5a 之后可独立。
- **Phase 6 (新分块)**: Nx2 demo backend (独立 repo `glubean-demo-backend`, Hono + Fly.io) + 原 5d `glubean init --template demo` 配对 ship。受益人 = **新用户体验 / 演示故事**。两者强配对 — backend 没起 template init 出来 connection refused; template 没 ship 没人能 clone+run。
- **原 plan §Phase 6 (cleanup) 残余 3 条** 排为独立 housekeeping row (backlog Nx5), 不再编入 product phase 编号。Phase 4 已经做掉 ci-config 模板删除 + README `--ci` 示例。剩下: legacy `loadConfig` flat-shape 删除 + AI-INSTRUCTIONS.md 旧命令清理 + 全仓库 `--ci` 残留扫。

切完后:

| Phase | 内容 | 受益人 | 跨 repo? | 配对 |
|---|---|---|---|---|
| 5 | cloud-side metadata 端到端 (5a+5b+5c) | 所有 profile 上传项目 | cli + cloud | 5a 内部强配对 |
| 6 | demo 故事 (Nx2 demo backend + Nx4 demo init template) | 新用户 / 演示 | cli + glubean-demo-backend (新 repo) | 强配对 |
| — | legacy cleanup (housekeeping, backlog Nx5) | 维护者 | cli only | 不依赖 |

**5+7 合并旧规则**: 仅约束 5a 本身（CLI emit + server persist 必须同 PR）。其余拆。

**2026-05-26 (post-W22 owner consolidation, ready-to-implement state)**:

- **Phase 5 + Phase 7 合并** 成单一 "Phase 5: Demo/Public end-to-end (CLI + cloud server + dashboard)"，一个 sprint ship。原 Phase 7 拆分被 codex round-5 catch 证明不安全（server 只持久化 `metadata.files`，其余 silently dropped，Phase 5 单独 ship 等于丢数据）。合并后 sequencing 问题消失。
- **excludeTags** 全实施 (resolver + runner filter) 进 Phase 1。原计划"resolver 在 1, filter 在 2"被 codex round-2 catch 不安全：first slice (1+3+4) ship 后 Phase 4 init 模板会写 `excludeTags: [manual, destructive]` 进 CI profile，但 Phase 2 runner filter 还没实施 → 用户 CI 看似排除 manual/destructive 实际还在跑。所以 excludeTags **必须跟 Phase 4 模板同时或更早 ship**，最自然就是 Phase 1 全做完。
- **First slice 扩到 Phase 1+2+3+4** (~9-10d, 原 ~6-7d): codex round-4 catch — first slice 的 CI template 含 `suites: [contracts, tests]`，但 contract case 的 tag 元数据透传在 Phase 2 才做；如果 Phase 1+3+4 单独 ship，excludeTags filter 对 contract case 不生效 (phantom UX 第二种)。解法是 Phase 2 也并进 first slice，contract/flow tag propagation + excludeTags filter 一起就位。代价是 first slice 多 ~3d, 但避免"看起来 exclude 实际跑"的 release bug。
- **First slice pre-flight (在 Phase 1 启动前)**: Phase 1 改 config loader 后老 `ci-config/*.yaml` 跑不了，所以**必须在动任何 phase 1 代码前**用当前安装的 `@glubean/cli` 跑一次 dogfood 完整 fixture, 存 `.glubean/last-run.result.json` 作 `pre-firstslice` baseline。Phase 2 完成后再用 local-build CLI 跑一次 `post-firstslice` 版本, **只 diff testId + tags 列表** (不 diff status — fixture 含 synthetic flaky 不稳)。详见 Phase 2 任务 #0 完整命令。
- **Demo backend 实施栈拍板** (跟进 05 plan §"开放问题"):
  - Tech: **Hono** (轻量，> Express 在 Fly.io free tier 256MB 内更舒服)
  - Deploy: **Fly.io free tier** (sleep-on-idle, $0/mo, owner-controlled)
  - Repo: **独立 repo `glubean-demo-backend`** (跟产品代码边界清，跟 demo project 也独立，便于将来 fork 给用户作 reference)

**2026-05-25 (post-author priority decision)**: 启动时间推迟到 **2026-W23+** (≥ 2026-06-01)。W22 期间 plan 文件冻结，不再扩 scope；review feedback 走 issue/branch，W23 启动时一并 fold 入。

启动时 scope 切片建议：先做 **Phase 1+2+3+4 一起 ship** (canonical `glubean.yaml` + `resolveRunPlan` + excludeTags runtime filter + contract/test discovery 对齐 + `glubean ci run` + resolved plan printout 杀手 feature + init 模板迁移到新 config，~9-10d)。Phase 2 必须含在 first slice 里 — contract case tag 元数据透传在 Phase 2 才做，缺它 excludeTags filter 对 contract case 不生效。Phase 3 跟 4 也必须同 PR — Phase 3 删 `--ci` 但 Phase 4 才迁 init templates。Phase 5 (CLI + server + dashboard 端到端, 含原 Phase 7) / Phase 6 cleanup 排后续 sprint。Phase 5 现在是 cross-repo, 一个 sprint 一起 ship。

Review notes (2026-05-25 review 后总结的 nail-before-Phase-1)：

- **reporter override 语义需精确**：CLI flag 覆盖 profile reporters 时，应只替换对应 channel（如 `--reporter detailed` 只改 console），不要整套替换 reporters dict（不然 junit/resultJson 输出意外丢）
- **Phase 3+4 顺序风险**：Phase 3 删 `--ci` 后老项目若没 `profiles.ci` 立刻断；必须 Phase 3+4 同 PR 或加 transition warning，不能分次 ship
- ~~Phase 5 跨 repo 改动遗漏~~ → 已修 (2026-05-26): Phase 5 现在是 cross-repo 端到端单 phase (CLI emit + cloud server 持久化 + dashboard 展示)，一个 sprint 一起 ship。原"5+7 分两段"被 codex 验证不安全，已合并。
- **`tagMode: or` default**：改 default 前 audit 当前 `--tag a --tag b` 实际语义 (AND 还是 OR)，错的话改 default 是隐性 breaking
- **Phase 2 高风险**：scanner + sdk + contract-core 一起改，建议启动前 snapshot dogfood baseline，Phase 2 完成后 diff 验证零回归

---

## 目标

把 Glubean CLI 的运行配置从分散的 `--ci`、`ci-config/*.yaml`、`package.json.glubean` 改成一个可读的项目运行计划：

- 一个项目一个 canonical `glubean.yaml`。
- `profiles` 明确表达“跑什么、怎么跑、产出什么”。
- `contracts`、`flows`、`tests` 是并列的一等 suite。
- CLI flags 继续保留，作为临时覆盖；不再把长期策略藏在 flags 里。
- `--ci` 不再作为隐藏 preset；CI 入口改成可解释的 `glubean ci run`。
- Demo project 和 public project/dashboard 进入同一套 profile 模型，但不把 demo/evals 强行写成 contract-first。

本计划可以做破坏性变更：当前没有真实外部用户，不需要兼容旧 config 文件格式。

## 非目标

- 不保留旧 `ci-config/*.yaml` 模板。
- 不保留 `package.json` 里的 `glubean` config 自动读取。
- 不继续主推多 config 文件 merge。
- 不把 public demo 设计成新的 contract protocol；它是 suite、data、metrics、dashboard 的组合。

## 新配置文件

默认文件名：`glubean.yaml`。

```yaml
version: 1

defaults:
  envFile: .env
  selection:
    tagMode: or
  execution:
    timeoutMs: 30000
    concurrency: 4
    failFast: false
    failAfter: null
    noSession: false
  capabilities:
    browser: false
    outOfBand: false
    optIn: false
  reporters:
    console: detailed
  redaction:
    replacementFormat: simple

suites:
  contracts:
    target: ./contracts
    kinds: [contract, flow]

  tests:
    target: ./tests
    kinds: [test]

  explore:
    target: ./explore
    kinds: [test]

profiles:
  local:
    suites: [contracts, tests]
    execution:
      failFast: false
    reporters:
      console: detailed
      resultJson: .glubean/results/local.result.json

  ci:
    suites: [contracts, tests]
    selection:
      excludeTags: [manual, destructive]
      tagMode: or
    execution:
      failFast: true
      concurrency: 2
    reporters:
      console: summary
      junit: .glubean/results/junit.xml
      resultJson: .glubean/results/ci.result.json

  contract-smoke:
    suites: [contracts]
    selection:
      tags: [smoke]
      tagMode: or
    execution:
      failFast: true
    reporters:
      console: summary
      junit: .glubean/results/contracts-smoke.junit.xml
      resultJson: .glubean/results/contracts-smoke.result.json

  explore:
    suites: [explore]
    execution:
      failFast: false
    reporters:
      console: detailed
```

Demo 项目在 canonical config 之上**合并**（不是替换）下面这块——在自己的 `suites:` 和 `profiles:` block 里追加对应条目：

```yaml
suites:
  demo-evals:
    target: ./demo/evals
    kinds: [test]
    data: ./demo/data

profiles:
  public-demo:
    suites: [demo-evals]
    selection:
      tags: [public-demo]
      tagMode: or
    execution:
      failFast: false
      concurrency: 3
    reporters:
      console: summary
      resultJson: .glubean/results/public-demo.result.json
    upload:
      enabled: true
      projectAlias: glubean-public-demo
```

## 配置语义

### `suites`

`suites` 定义 runnable inventory 的来源。

| 字段 | 说明 |
|---|---|
| `target` | 文件、目录或 glob。 |
| `kinds` | 允许值：`test`、`contract`、`flow`。 |
| `data` | 可选，给 demo/eval/project docs 使用，不直接影响 runner discovery。 |

同一个 profile 可以跑多个 suite。`contracts` 和 `tests` 不再靠目录默认值隐式区分。

### `profiles`

`profiles` 定义运行计划。

| 字段 | 说明 |
|---|---|
| `suites` | 要跑哪些 suite。 |
| `selection` | `tags`、`excludeTags`、`filter`、`pick`、`tagMode`。 |
| `execution` | `failFast`、`failAfter`、`timeoutMs`、`concurrency`、`noSession`。 |
| `capabilities` | `browser`、`outOfBand`、`optIn`。 |
| `reporters` | `console`、`junit`、`resultJson`、trace 输出。 |
| `upload` | Cloud 上传开关和目标 project alias/id。 |

### 优先级

```text
built-in defaults
-> glubean.yaml defaults
-> selected profile
-> CLI flags
```

CLI flags 是临时覆盖，不是长期配置来源。

## CLI 目标形态

### 主命令

```bash
glubean run --profile local
glubean run --profile contract-smoke
glubean ci run
glubean ci run --tag smoke
glubean run --profile public-demo
```

`glubean ci run` 等价于读取 `profiles.ci`。如果没有 `profiles.ci`，直接失败并提示创建 profile，不回退到隐藏默认。

### 保留的显式 flags

保留 primitive flags：

- `--tag`
- `--tag-mode`
- `--filter`
- `--pick`
- `--env-file`
- `--fail-fast`
- `--fail-after`
- `--reporter`
- `--result-json`
- `--emit-full-trace`
- `--infer-schema`
- `--truncate-arrays`
- `--include-opt-in`
- `--include-browser`
- `--include-out-of-band`
- `--upload`
- `--project`
- `--token`
- `--api-url`
- input/debug flags：`--input-json`、`--bootstrap-json`、`--force-standalone`

删除或不再暴露隐藏 preset flag：

- `--ci`

### 可见 plan 输出

每次 profile run 前打印 resolved plan：

```text
Profile: ci
Config:  glubean.yaml

Suites:
  contracts -> ./contracts [contract, flow]
  tests     -> ./tests [test]

Selection:
  excludeTags: manual, destructive
  tagMode: or

Execution:
  failFast: true
  failAfter: none
  concurrency: 2
  timeoutMs: 30000

Reporters:
  console: summary
  junit: .glubean/results/junit.xml
  resultJson: .glubean/results/ci.result.json
```

这个输出是产品要求，不是 debug 细节。用户必须能从 CI log 第一屏看懂实际跑了什么。

## Public Project 与 Demo Project

### 概念边界

| 概念 | 归属 | 说明 |
|---|---|---|
| Demo project | 本地 repo / template | 可 clone、可运行、无 secrets 的示范项目。 |
| Public project | Cloud | 公开可读的项目页面，展示 demo runs、趋势、对比和失败样例。 |
| Public dashboard | Cloud | Public project 的默认展示视图。 |
| Public demo profile | `glubean.yaml` | 本地 demo 项目上传到 public project 的运行计划。 |

Demo project 负责生成可信样例；public project 负责让用户看到价值。

### Demo project 模板

新增或重做 init 模式：

```bash
glubean init --template demo
glubean init --template demo-ai-evals
```

Demo project 内容：

```text
glubean.yaml
tests/
contracts/
demo/
  evals/
  data/
  README.md
```

要求：

- 默认可跑，不需要私有 token。
- 只能使用公开 API、mock client、fixture data，或明确的 fake provider。
- 用 `tags: [public-demo]` 标记公开展示用例。
- AI/capability evals 使用 `test()`、datasets、judge metadata、metrics，不默认写成 contract。
- Demo README 只解释“这个项目证明什么能力”，不解释 CLI 内部实现。

### Public project 上传

第一阶段可以不做完整 Cloud project 管理，只让 profile 指向 project alias/id：

```yaml
profiles:
  public-demo:
    suites: [demo-evals]
    upload:
      enabled: true
      projectAlias: glubean-public-demo
```

后续再补 Cloud 命令：

```bash
glubean project create --alias glubean-public-demo --public
glubean project publish --profile public-demo
```

Public dashboard 展示重点：

- capability pass/fail，不只是 raw test pass rate。
- 最近一次失败的输入、输出、judge reason 或 assertion reason。
- profile、suite、tag、commit、provider/model 维度过滤。
- “怎么复现”命令：`glubean run --profile public-demo --filter ...`。

## 实施阶段

### Phase 1：配置模型重写 + Selection 全字段（含 excludeTags 实施）

文件范围：

- `packages/cli/src/lib/config.ts`
- `packages/cli/src/lib/config.test.ts`
- `packages/cli/src/main.ts`
- `packages/cli/src/commands/run.ts`（task 7 让 runCommand 接收 resolved plan，需改这里）
- `packages/runner/src/selection.ts`（或等价 — 实施 excludeTags runtime filter 的位置）

任务：

1. 定义 `GlubeanProjectConfigV1`、`SuiteConfig`、`ProfileConfig`、`ResolvedRunPlan`。SelectionConfig 字段含 `tags`、`excludeTags`、`tagMode`、`filter`、`pick`。
2. `loadConfig()` 默认只读 `glubean.yaml`。
3. `--config <path>` 只选择一个 config 文件；不再主推多文件 merge。
4. unknown keys 从 warning 改成 hard error。
5. 删除 `package.json.glubean` 自动读取。
6. 新增 `resolveRunPlan(config, profileName, cliOverrides)`。resolved plan 必须正确含 `selection.excludeTags`（即使值为 undefined 也保留字段）。
7. 让 `runCommand` 接收 resolved plan，而不是自己拼散落 options。
8. **excludeTags runtime filter 实施**: runner selection 在 `tags` matching 之后再过 `excludeTags`，任何 test/contract/flow 带 excludeTags 列出的 tag 都从最终 inventory 排掉。`tagMode` 不影响 excludeTags（exclude 永远是 OR — 任意 tag 命中即排掉）。这条原属 Phase 2 但前移到 1，保证 Phase 4 模板 ship 时 CI profile 里的 `excludeTags: [manual, destructive]` 是真生效的（不是 phantom UX）。

验收：

- `glubean run --profile ci` 能解析 suites、selection、execution、reporters。
- resolved plan 的 `selection.excludeTags` 数组跟 `glubean.yaml` profile 内的一致。
- **runtime 验证**: 跑 `glubean run --profile ci` (含 `excludeTags: [manual]`)，对一个带 `manual` 标签的 test 文件，resolved plan printout 显示 "N excluded by tag"，该 test 不出现在执行结果里。
- `glubean run --profile missing` 失败并提示可用 profiles。
- unknown config key 失败。
- 没有 `glubean.yaml` 时，`glubean run` 给出明确 init/config 提示。

### Phase 2：Contract/Test Discovery 对齐

文件范围：

- `packages/cli/src/commands/run.ts`
- `packages/scanner/src/contract-extraction.ts`
- `packages/sdk/src/contract-core.ts`
- 相关 CLI runner tests

任务：

0. **Pre-flight discovery inventory snapshot — 必须在 Phase 1 启动前就采**:
   - 因为 Phase 1 改 config loader 为 hard-error on unknown keys + 默认只读 `glubean.yaml`，dogfood 现有 `ci-config/*.yaml` 在 Phase 1 后会直接 fail，跑不出 baseline。
   - 采 baseline 时**用当前安装的** `@glubean/cli` (`cd /Users/peisong/glubean/dogfood && npm run test:upload`)，把生成的 `.glubean/last-run.result.json` 复制到 `/tmp/dogfood-inventory-pre-firstslice-2026-Wxx.json`。**这步必须在动任何 phase 1 代码前完成**。
   - Phase 2 完成后 (含 dogfood `glubean.yaml` migration — 见 Phase 4 init 模板)：从 dogfood 目录用**本地链好的 @glubean/cli** (`cd /Users/peisong/glubean/glubean/packages/cli && pnpm build && pnpm link --global` 然后 `cd /Users/peisong/glubean/dogfood && pnpm link --global @glubean/cli && npm test`) 再跑一次保留 `post-firstslice` 版本。
   - **只 diff `testId` 集合 + 每个 test 的 `tags` 数组**。**不 diff status** (fixture 含 synthetic flaky 故意不稳)。可选 `mongodump test_stats` 备份留底，但不参与 diff。
1. Contract case discovery 透传最终 `tags`（含 `excludeTags` 已能正确过滤 contract case — runner filter 在 Phase 1 已建好，这里保证 discovery 阶段也产生足够元数据给 filter 用）。
2. Flow discovery 透传 `tags`、`only`、`deferred/skip`。
3. Contract case discovery 补 `name`，格式与 runtime 一致。
4. 统一 `test()` 与 contract 的 `requires/defaultRun` selection 行为。
5. 修复 CLI run contract static fallback：与 scanner/MCP 一样 fail-closed。
6. `--tag` / profile `selection.tags` 对 `test`、`contract`、`flow` 行为一致 (positive matching 在 Phase 2 统一; excludeTags filter 在 Phase 1 已实施)。

验收：

- `glubean run --profile contract-smoke` 能按 contract tag 只跑 smoke。
- `glubean run --profile ci` 同时发现并运行 contracts、flows、tests。
- `glubean run --profile ci`（含 `excludeTags: [manual, destructive]`）跑时 manual / destructive 标签的 case **不**被执行 — Phase 2 让 contract case 也带 tags 元数据给 Phase 1 实施的 filter 用 (Phase 1 first slice ship 时 filter 已能工作于 test，Phase 2 ship 后扩到 contract/flow)。
- test-level `requires: "browser"` 与 contract case-level `requires` 行为一致。
- 混合协议 contract import 失败时不会静态抽取半真 inventory。
- **Discovery inventory baseline diff** (Phase 2 完成后): 不是直接 diff test_stats (那个 reducer 每跑都会动 counters/timestamps，不可比)。正确做法: Phase 2 前 + 后**各跑一次 dogfood 完整 fixture**，分别保留每次的 `runResult.tests` 列表，**只 diff `testId` 集合 + 每个 test 的 `tags` 数组**。**不 diff status** (fixture 含 synthetic flaky 故意不稳, status 比对会假阳性)。简单说: discovery 改动可以改 reducer 的 counters，但不能让某个 testId 凭空消失/多出来，也不能让某个 testId 的 tags 数组变。

### Phase 3：CLI 命令面调整

文件范围：

- `packages/cli/src/main.ts`
- `packages/cli/src/commands/run.ts`
- 新增 `packages/cli/src/commands/ci.ts` 或等价模块

任务：

1. 增加 `--profile <name>`。
2. 增加 `--suite <name>` 临时覆盖，支持 repeatable。
3. 增加 `glubean ci run`，固定默认 profile 为 `ci`。
4. 删除 `--ci` 或让 help 中不再出现；内部不再依赖它。
5. 所有 run 前打印 resolved plan。
6. `--reporter`、`--result-json` 等 flags 覆盖 profile reporters。

验收：

- `glubean ci run` 输出 profile plan 并执行 `profiles.ci`。
- `glubean ci run --tag smoke` 只覆盖 selection，不改变 suites。
- `glubean run --profile local --suite contracts` 只跑 contracts suite。
- CLI help 不再把 CI 表达成 `run --ci`。

### Phase 4：Init 模板重做

文件范围：

- `packages/cli/src/commands/init.ts`
- `packages/cli/templates/**`
- `packages/cli/src/commands/init.test.ts`
- `packages/cli/README.md`
- root `README.md`

任务：

1. 新项目生成 `glubean.yaml`。
2. 删除 `ci-config/default.yaml`、`ci-config/ci.yaml`、`ci-config/staging.yaml`、`ci-config/explore.yaml` 模板。
3. package scripts 改成：

   ```json
   {
     "scripts": {
       "test": "glubean run --profile local",
       "test:ci": "glubean ci run",
       "explore": "glubean run --profile explore",
       "contract:smoke": "glubean run --profile contract-smoke"
     }
   }
   ```

4. GitHub Actions 模板改成 `npx glubean ci run`。
5. contract-first init 默认 suites 包含 `contracts` 和 `tests`，CI profile 同时跑两者。
6. 非 contract-first init 也可以生成空 `contracts` suite，但默认 local/ci 是否启用由模板决定。

验收：

- `glubean init --contract-first --github-actions` 不再生成 `ci-config/`。
- 新项目第一眼能在 `glubean.yaml` 里看懂 CI 跑什么。
- GitHub Actions log 第一屏显示 resolved plan。

### Phase 5：Demo/Public end-to-end (CLI + cloud server + dashboard)

**Cross-repo phase**, 一个 sprint 一起 ship。原 Phase 5（CLI emit only）跟 Phase 7（cloud server + dashboard）合并成本节，因为 codex 验出 server 当前只持久化 `metadata.files`、其余 silently dropped — Phase 5 单独 ship 就丢数据，必须 server 持久化先 / 一起 ship 才有意义。

文件范围跨 2 repo：

**CLI repo (`glubean`)**:
- `packages/cli/src/commands/init.ts`
- `packages/cli/templates/demo/**`
- `packages/cli/templates/demo-ai-evals/**`
- `packages/cli/src/lib/upload.ts`（往**现有** `IngestRunPayload.metadata` 对象里 emit profile/suite/capability/eval 字段）

**Cloud repo (`cloud`)**:
- `cloud/apps/server/src/cli-runs/cli-runs.service.ts`（ingestRun 把 `metadata.profile` / `metadata.suite` / `metadata.capability` / `metadata.eval` 投射到 `runs` collection 顶层字段）
- `cloud/apps/server/src/tasks/schemas/run.schema.ts`（顶层加投射字段 + 索引视查询需要而加）
- `cloud/apps/server/src/cli-runs/cli-runs.controller.ts`（或新 query endpoint：`GET /open/v1/runs?profile=X&suite=Y&capability=Z`）
- Public dashboard 路由 + UI 组件（按 profile/suite/tag/capability 过滤；展示 capability pass/fail 而非 raw test pass rate）

任务：

**CLI 端**:
1. 新增 `glubean init --template demo`。
2. 新增 `glubean init --template demo-ai-evals`。
3. Demo 模板生成 `profiles.public-demo`。
4. Result payload 在**现有 `metadata` 对象内**新增 profile/suite/capability/eval 字段（不要加 top-level 新字段——cloud server 现用 `ValidationPipe({ forbidNonWhitelisted: true })`，未知 top-level 字段直接 400 reject；nested under metadata 是已经 accept 的 generic bucket）。
5. Public demo run 带 `tags: [public-demo]`，capability/eval metadata 也走同一 `metadata` 对象。
6. 文档把 "public project" 讲成 demo result 的公开展示，不是新的 authoring abstraction。

**Cloud server 端**:
7. ingestRun 读取 `metadata` 内 profile/suite/capability/eval 并投射到 run document 顶层字段（保持 metadata 原值不动，便于历史追溯）。
8. `GET /open/v1/runs` 支持 profile/suite/capability filter query。
9. Run detail 页展示 profile/suite/capability/eval metadata。
10. Public project 页加 capability pass/fail 总览 + 复现命令 hint (`glubean run --profile public-demo --filter ...`)。

**Cross-repo 验证**:
11. Cloud 端 e2e 验证：CLI 步骤 1-6 产生的 result 在 dashboard 可见 + 可过滤。

**Demo backend (独立 repo `glubean-demo-backend`, 不在本 plan phase 范围)**:
12. 必须先 deploy 起来才能让 Phase 5 demo project 真跑出 narrative 数据。Tech 栈见 05 plan 修订 (Hono / Fly.io free tier / 独立 repo)。

验收：

- demo 项目 clone 后能直接 `npm test`（走 local profile, 跳过 flaky suites）。
- `glubean run --profile public-demo` 产生可上传 result（含 metadata.profile/suite/capability/eval）。
- 上传到 prod cloud server：HTTP 200 + 服务端**真持久化** profile/suite 到 runs collection 顶层（不是仅接受 + 丢弃）。
- public-demo run 在 public project dashboard 上 profile/suite/capability metadata 可见。
- `GET /open/v1/runs?profile=public-demo` 能按 profile 筛选。
- 老 client（无新字段）仍然能正常上传，dashboard 退化为 "未标 profile/suite" 而不是失败。
- public-demo run 在 public project 页能按 capability 维度过滤展示。

**为什么不分两个 phase 一前一后 ship**: codex round-5 验过, server 当前 `ingestRun` 只持久化 `metadata.files`、其余 silently dropped。Phase 5 单独 ship → CLI emit 的 metadata 全丢，即使后续 Phase 7 上线也 recover 不了历史数据。合并成单一 phase 强制 CLI + server + dashboard 同步演化。

### Phase 6：清理旧模式

任务：

1. 删除旧 config loader 对 `{ run, redaction, cloud, thresholds }` flat shape 的默认路径。
2. 删除 `ci-config` 模板与相关测试。
3. 删除 README 中 `glubean run --ci` 示例。
4. 删除或重写 `packages/cli/templates/AI-INSTRUCTIONS.md` 中旧命令。
5. 搜索全仓库 `--ci`、`ci-config`，只允许迁移说明中出现。

验收：

- `rg -- "--ci|ci-config"` 只剩历史/迁移说明，或完全没有。
- CLI tests 不再依赖旧 config fixture。
- 新 README 的 CI 入口只有 `glubean ci run` 或 profile 命令。

<!-- 原 Phase 7（Cloud 服务端 + Dashboard）已合并进 Phase 5 (2026-05-26 revisions)。
     合并理由: server 当前 `ingestRun` 只持久化 `metadata.files`、其余 silently
     dropped — Phase 5 单独 ship 等于丢数据。合并后变成 cross-repo 单一 sprint。 -->

## 风险与决策点

### `glubean run` 默认跑什么

建议：

- 有 `profiles.local` 时，`glubean run` 默认等价于 `glubean run --profile local`。
- 没有 `profiles.local` 时失败，提示可用 profiles。

理由：保留简单入口，但不制造隐藏 CI/default 行为。

### 是否保留 `--config`

建议保留，但语义变窄：

```bash
glubean run --config ./glubean.yaml --profile ci
```

它只用于选择 config 文件，不再是多文件 merge 方案。

### Public visibility 是否放进本地 config

建议本地 config 只写目标 alias/id，不让 `glubean.yaml` 单独改变 Cloud visibility。

Cloud public/private 应由显式命令或 Cloud UI 控制：

```bash
glubean project create --alias glubean-public-demo --public
```

理由：公开权限是高风险操作，不应该由一次普通 run 隐式改变。

## 推荐落地顺序

**说明**: First slice 已 ship (2026-05-27)。下方顺序反映 2026-05-27 Revisions 重切后的 Phase 5/6 边界。

1. ✅ **First slice (~9-10d): Phase 1+2+3+4 + multi-suite + `--ci` removal** — shipped 2026-05-27 (14 commits, 266 vitest, dogfood zero-delta):
   - Phase 1: `glubean.yaml` schema + `resolveRunPlan` + `excludeTags` runtime filter
   - Phase 2: contract/test discovery 对齐 (contract case + flow tags 透传)
   - Phase 3: `glubean ci run` + resolved plan printout + `--suite` override
   - Phase 4: init 模板迁移 + `--ci` flag 删除 + multi-suite execution foundation
2. **Phase 5 (新分块, ~3-5d cross-repo, backlog Nx3)**: cloud-side metadata 端到端 (5a CLI emit + server persist 必须同 PR; 5b query endpoint + 5c dashboard UI 5a 之后可独立)。受益人 = 任何 profile-driven 上传项目。**不依赖 demo backend**。
3. **Phase 6 (新分块, ~2-2.5d, backlog Nx2 + Nx4)**: demo 故事 (Nx2 demo backend 独立 repo deploy + Nx4 `glubean init --template demo` 模板) 配对 ship。受益人 = 新用户体验 / 演示故事。强配对 — 任一缺位另一边没意义。
4. **legacy cleanup (housekeeping, backlog Nx5, ~1d)**: 原 plan §Phase 6 残余 3 条 (legacy `loadConfig` flat-shape 删除 / AI-INSTRUCTIONS.md 旧命令 / 全仓库 `--ci` 残留扫). 跟 Phase 5/6 不冲突，独立可做。

这条顺序能先解决当前最伤产品可信度的问题：用户从配置和 CI log 看不到真实运行计划 — first slice 已解决。Phase 5 解决"上传完看不到 capability 维度数据"；Phase 6 解决"新用户没有上手故事"。
