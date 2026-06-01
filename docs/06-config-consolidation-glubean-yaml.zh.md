# 配置收敛：全部迁到 glubean.yaml，下线 package.json `glubean` 字段

日期：2026-05-29
状态：**已定稿（owner 2026-05-29 拍板 D1–D4）— 待排期实施**

## 动机

目前一个项目的配置散在**两套模型**里：

- **legacy flat-shape**：`package.json` 的 `glubean` 字段（或 `--config xxx.json`）→ `loadConfig()` 读出 `{run, redaction, cloud, thresholds}`。
- **v1**：`glubean.yaml`（`version/defaults/suites/profiles`）→ `loadProjectConfigV1` + `resolveRunPlan`。

两套并存导致：

1. **可配置位置太多易混淆**（owner 原话）——同一个东西（redaction、failFast）能在两处配，优先级链（defaults → package.json → CLI；`--config` 合并）还得记。
2. **维护成本高**——两套 loader、两套 merge、两套校验、两套测试。
3. **半迁移状态**——v1 是 canonical + scaffold 默认，但 `loadConfig` 仍在 `run.ts:758` **无条件**跑，给每次 run（含 profile 模式）当 baseline，profile plan 往上叠。

**目标**：glubean.yaml 成为**唯一**配置来源，删除 package.json `glubean` 字段支持。将来真有需求再加回（可逆）。

## 原则（红线）

> **glubean.yaml 只放声明式配置；凭证只在 env / `.env.secrets` / `glubean login`。**

- 把 secret/config 边界钉死：`cloud.token`、`apiUrl` 这类**绝不进** commit 进 git 的 yaml。
- glubean.yaml 承载：suites、profiles、selection、execution、reporters、redaction（含扩展规则）、thresholds、`upload.projectId`（+ 可选 `upload.tokenEnv`，per-profile token 引用，值在 `.env.secrets`）。

> **2026-06-01 修正**：原定用 `upload.projectAlias` 承载 cloud project，已改为 `upload.projectId`（+ `tokenEnv`）。原因：per-profile alias 暗示"一个 repo 多 project 上传"但又只能换 project 不能换 token、且静默盖过 `GLUBEAN_PROJECT_ID`。现模型：`upload.projectId`（id 或 alias，可选；缺省回落 `GLUBEAN_PROJECT_ID`/`--project`）+ `upload.tokenEnv`（指向 `.env.secrets` 的 var 名，secret 不进 yaml）。`projectAlias` 留作 deprecated 同义词（warn）。已实现于 `packages/cli`（config/auth/main/print-plan）。

## 现状矩阵：四个 section 各自归属

| section | 字段 | v1 现有对应 | 收敛动作 |
|---|---|---|---|
| **run** | verbose/pretty/logFile/emitFullTrace/inferSchema/truncateArrays/envFile/failFast/failAfter/perTestTimeoutMs/concurrency | profile.execution + reporters（基本全覆盖） | 下线 package.json 读取，CLI flag + profile 即够 |
| **run** | **testDir / exploreDir** | ❌ 无（v1 用 per-suite `suites.target`） | 见决策 D3（无参数 run 去向） |
| **redaction** | replacementFormat | ✅ `defaults.redaction.replacementFormat` | 已覆盖 |
| **redaction** | **sensitiveKeys / customPatterns** | ❌ schema 无 | **新增**到 `defaults.redaction`（见 D1） |
| **cloud** | projectId | `upload.projectId`（+`tokenEnv` 多 project）/ `GLUBEAN_PROJECT_ID` | 用 projectId（2026-06-01 改：原定 alias，见上注）；下线 package.json |
| **cloud** | **token / apiUrl** | ❌（且不该有） | **不迁** → env/login（红线） |
| **thresholds** | metric 阈值（ThresholdConfig） | ❌ 完全无 | **新增** v1 schema（见 D2） |

> 关键：`thresholds` 当前**只有** package.json 这一条路，连 profile 模式都靠 `loadConfig` 拿它。直接删 = 阈值评估功能消失。必须先在 v1 建家。

## 设计决策（owner 2026-05-29 拍板）

### D1 — redaction 扩展字段放哪？　**→ `defaults.redaction`（全局）**
`sensitiveKeys` / `customPatterns` 进 `defaults.redaction`，全局一份，所有 profile 继承。最贴近现状（package.json 也是全局一份）。暂不做 per-profile 覆盖（无需求，将来可加）。

### D2 — thresholds 放哪？　**→ per-profile + `defaults.thresholds`**
`DefaultsConfig.thresholds`（全局默认）+ `ProfileConfig.thresholds`（profile 覆盖）。CI profile 可比 local 严。阈值本就是 run 策略的一部分，语义最自然。

### D3 — 无参数 / 无 profile 的 `glubean run`？　**→ 删 testDir/exploreDir，落到 local profile**
- `glubean run <target>`（给了 target，没 profile）：**保留**，用 RUN_DEFAULTS + CLI flag + 默认全 redaction 跑。快速 ad-hoc 路径，无需项目配置。
- `glubean run`（无 target 无 profile）：若存在 `local` profile 就用它（scaffold 必建）；否则报错提示「指定 --profile 或 target」。删 `testDir/exploreDir`。
- `--explore` flag：**废弃**，改用 `--profile explore`（scaffold 已建 explore profile）。

### D4 — 迁移策略？　**→ 纯文档化 breaking change + 启动 warn**
不做自动迁移工具（用户少，不值当）。只：① 文档/README/GLUBEAN.md 说明从 package.json `glubean` 迁到 glubean.yaml 的字段对照；② `run` 启动时若检测到 package.json 仍有 `glubean` 字段，warn 一次「已废弃且不再读取，请迁到 glubean.yaml」。**不扩展 `glubean migrate`。**

## 实施分阶段（依赖顺序）

> 顺序关键：**先在 v1 建家（P1），再下线 legacy（P2）**，否则中间态丢功能。

### P1 — v1 schema 扩展（建家，纯增量、不破坏）
1. `DefaultsConfig.redaction` 加 `sensitiveKeys` / `customPatterns`（D1）；`resolveRunPlan` 把它们 resolve 进 `ResolvedRunPlan.redaction`（`resolveRedactionConfig` 已是共享 helper，接上即可）。
2. v1 schema 加 `thresholds`（D2）：`DefaultsConfig.thresholds` + `ProfileConfig.thresholds`，resolve 进 `ResolvedRunPlan.thresholds`。
3. `run.ts:2041` 阈值评估改读 `resolvedPlan.thresholds`（profile 模式）。
4. 校验函数（`validateDefaults`/`validateProfile`）加新字段；加测试。
5. scaffold 模板（init.ts）按需展示新字段（redaction 扩展 / thresholds 示例，注释说明）。

### P2 — 下线 legacy 读取（破坏性，但 P1 已补齐功能）
1. `loadConfig` 停止读 package.json `glubean` 字段 + standalone JSON `--config`；run/redact 改走 v1 resolve 或 RUN_DEFAULTS（非 profile target 模式）。
2. 删 `readSingleConfig` / `mergeConfigInputs` / `validateConfigInput` / `isPackageConfig` / `warnUnknownKeys` / `GlubeanConfigInput` 等纯 legacy 符号。
   - **保留**共享符号：`resolveRedactionConfig`、`GlubeanRedactionConfigInput`（v1 也用）、`RUN_DEFAULTS`、`mergeRunOptions`、`toSharedRunConfig`。
3. `run.ts:758` 的无条件 `loadConfig` baseline 改为：profile 模式用 resolvedPlan；非 profile target 模式用 RUN_DEFAULTS + 默认 redaction。
4. cloud auth（`run.ts:839/2258`）的 `cloudConfig` source 去掉 package.json 来源，保留 env/flag/login。
5. `glubean redact` 的 redaction 改读 glubean.yaml `defaults.redaction`（无则默认全 redaction）。
6. 删 `config.test.ts` 中 ~15 个 loadConfig package.json 测试；补 v1 等价测试。
7. `--explore` 废弃 + 无参数 run 去向（D3）。

### P3 — 文档化 breaking change + 启动 warn（D4）
1. `run` 启动时检测 package.json 残留 `glubean` 字段 → warn 一次「已废弃且不再读取，请迁到 glubean.yaml」。
2. 字段对照表（package.json `glubean.*` → glubean.yaml 对应位置）写进 README / docs / GLUBEAN.md 模板。
3. 扫全仓库残留 package.json `glubean` 引用 + 示例。
4. **不**扩展 `glubean migrate`（owner D4 决策：用户少，不做自动迁移）。

## 风险 / 注意

- **中间态丢功能**：P1 必须先 ship（或与 P2 同 PR），否则 thresholds/redaction 扩展无家。建议 P1+P2 同一个 sprint，甚至同 PR（参照 Phase 5 «server 只持久化 files» 的教训——拆开 ship 会 silently drop）。
- **凭证误入 yaml**：无自动迁移工具，靠文档把红线讲清——`cloud.token`/`apiUrl` **永远**放 `.env.secrets`/login，glubean.yaml 不接受凭证字段（schema 不设这些 key，误写会被 v1 校验拒绝）。
- **测试基线**：P2 改 config loader 前，先用当前 CLI 跑 dogfood 完整 fixture 存 baseline，P2 后 diff testId+tags（参照 04 plan first-slice pre-flight 做法）。
- 每个 sub-task 走 converge gate（vitest + codex review + P1 fix to 0）。

## 与 04 plan 的关系

本计划是 04 plan §Phase 6 cleanup 残余「legacy `loadConfig` flat-shape 删除」的**正式升级**——调查发现它不是 housekeeping（thresholds/cloud/redaction扩展 在 v1 无家），需先迁移再删除，故独立成 product 任务。backlog Nx5 的该子项应替换为本计划链接。
