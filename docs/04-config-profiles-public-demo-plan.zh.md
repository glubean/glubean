# 配置 Profiles 与 Public Demo 执行计划

日期：2026-05-25

## Revisions

**2026-05-25 (post-author priority decision)**: 启动时间推迟到 **2026-W23+** (≥ 2026-06-01)。W22 期间 plan 文件冻结，不再扩 scope；review feedback 走 issue/branch，W23 启动时一并 fold 入。

启动时 scope 切片建议：先做 Phase 1+3+4 一起 ship (canonical `glubean.yaml` + `resolveRunPlan` + `glubean ci run` + resolved plan printout 杀手 feature + init 模板迁移到新 config，~6-7d)。**Phase 3 跟 4 必须同 slice / 同 PR** — Phase 3 删 `--ci` 但 Phase 4 才迁 init templates，分开 ship 会让新 init 项目立刻断（template 还引用已删 flag）。Phase 2/5/6 排后续 sprint。

Review notes (2026-05-25 review 后总结的 nail-before-Phase-1)：

- **reporter override 语义需精确**：CLI flag 覆盖 profile reporters 时，应只替换对应 channel（如 `--reporter detailed` 只改 console），不要整套替换 reporters dict（不然 junit/resultJson 输出意外丢）
- **Phase 3+4 顺序风险**：Phase 3 删 `--ci` 后老项目若没 `profiles.ci` 立刻断；必须 Phase 3+4 同 PR 或加 transition warning，不能分次 ship
- **Phase 5 跨 repo 改动遗漏**：Phase 5 文件范围只列 CLI，但 "Cloud 能按 profile/suite 展示" 实际要扩 server `IngestRunDto` + 后台展示 UI；要在 Phase 5 验收里加显式 cross-repo dependency
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

Public/demo 项目可以额外声明 suite：

```yaml
suites:
  demo-evals:
    target: ./demo/evals
    kinds: [test]
    data: ./demo/data
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

### Phase 1：配置模型重写

文件范围：

- `packages/cli/src/lib/config.ts`
- `packages/cli/src/lib/config.test.ts`
- `packages/cli/src/main.ts`

任务：

1. 定义 `GlubeanProjectConfigV1`、`SuiteConfig`、`ProfileConfig`、`ResolvedRunPlan`。
2. `loadConfig()` 默认只读 `glubean.yaml`。
3. `--config <path>` 只选择一个 config 文件；不再主推多文件 merge。
4. unknown keys 从 warning 改成 hard error。
5. 删除 `package.json.glubean` 自动读取。
6. 新增 `resolveRunPlan(config, profileName, cliOverrides)`。
7. 让 `runCommand` 接收 resolved plan，而不是自己拼散落 options。

验收：

- `glubean run --profile ci` 能解析 suites、selection、execution、reporters。
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

1. Contract case discovery 透传最终 `tags`。
2. Flow discovery 透传 `tags`、`only`、`deferred/skip`。
3. Contract case discovery 补 `name`，格式与 runtime 一致。
4. 统一 `test()` 与 contract 的 `requires/defaultRun` selection 行为。
5. 修复 CLI run contract static fallback：与 scanner/MCP 一样 fail-closed。
6. `--tag` / profile `selection.tags` 对 `test`、`contract`、`flow` 行为一致。

验收：

- `glubean run --profile contract-smoke` 能按 contract tag 只跑 smoke。
- `glubean run --profile ci` 同时发现并运行 contracts、flows、tests。
- test-level `requires: "browser"` 与 contract case-level `requires` 行为一致。
- 混合协议 contract import 失败时不会静态抽取半真 inventory。

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

### Phase 5：Demo/Public Project 路径

文件范围：

- `packages/cli/src/commands/init.ts`
- `packages/cli/templates/demo/**`
- `packages/cli/templates/demo-ai-evals/**`
- Cloud upload metadata payload 如需要扩展：`packages/cli/src/lib/upload.ts`

任务：

1. 新增 `glubean init --template demo`。
2. 新增 `glubean init --template demo-ai-evals`。
3. Demo 模板生成 `profiles.public-demo`。
4. Result payload 增加 profile/suite 信息，Cloud 能按 profile/suite 展示。
5. Public demo run 带 `tags: [public-demo]`，并带 capability/eval metadata。
6. 文档把 “public project” 讲成 demo result 的公开展示，不是新的 authoring abstraction。

验收：

- demo 项目 clone 后能直接 `npm test`。
- `glubean run --profile public-demo` 产生可上传 result。
- public-demo result 中能看出 profile、suite、tags、capability/eval metadata。

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

1. 先做 `glubean.yaml` schema + `resolveRunPlan()`，不碰 Cloud。
2. 再修 contract/test discovery 对齐，否则 profiles 的 `tags` 对 contracts 仍然不可用。
3. 再加 `glubean ci run` 和 plan 输出，替换 `--ci`。
4. 再改 init/templates/README。
5. 最后做 demo/public project metadata 和 Cloud 展示对接。

这条顺序能先解决当前最伤产品可信度的问题：用户从配置和 CI log 看不到真实运行计划。
