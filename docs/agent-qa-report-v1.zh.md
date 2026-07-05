---
name: agent-qa-report-v1
status: v1 (finalized for GLU-211 scaffold)
date: 2026-07-05
supersedes: internal/40-discovery/proposals/agent-qa-report-v1.md (draft, 2026-07-03)
relates: contract-browser-two-tier(母提案 §2.4/§2.6) · agent-finding-v1(extraFindings 的通用 schema) ·
  test-project/agent-qa-report.ts(本文档的 validator 参考实现)· test-project/auth.browser.ts(首份 fixture)
---

# agent-qa-report/v1 — Mode B(agent 自主 QA)输出契约

> 定位:**这份报告 schema 是 Mode B 的产品本体，不是附录。** contract.browser 提案的核心假设是
> "同一份 contract，连续多轮独立 agent 做 QA，能产出结构一致、可 diff、可回流的报告"——
> 这份文档就是那个"结构"的正式定义。母提案见
> `internal/40-discovery/proposals/contract-browser-two-tier.md` §2.4/§2.6；本文件把 2026-07-03
> 的 draft 版正式定稿，并把同日 4 轮 sonnet-5 实验（`internal/acceptance-evidence/
> modeb-agent-qa-2026-07-03/RESULT.md`）暴露出的收敛点写死成规则（见 §3 evidence 格式、§9 变更记录）。

## 1. 顶层结构与必填字段

```jsonc
{
  "kind": "agent-qa-report/v1",            // 必填，字面量
  "contract": "auth.login.journey",         // 必填，contract id
  "case": "happyPath",                      // 必填，case key
  "contractRevision": "3f9a1c20b4d7",       // 必填：语义子集（entry + agentNotes + steps[].{id,intent} +
                                            // expect）canonical JSON 的 sha256 前 12 位。注释/排版/示例
                                            // action 变化不断开 diff 序列。
  "executor": {                             // 必填
    "kind": "agent",
    "model": "claude-sonnet-5",             // 必填，精确 model id（不许写 "sonnet"/"claude" 之类模糊值）
    "round": 1,                              // 实验轮次/gate 轮次，可选
    "startedAt": "2026-07-05T08:00:00Z",
    "finishedAt": "2026-07-05T08:04:00Z"
  },
  "steps": [ /* §2 */ ],                    // 必填，必须覆盖 spec 全部 step id
  "expect": [ /* §3 */ ],                   // 必填，必须逐条覆盖 spec 全部 expect id，顺序与 spec 一致
  "extraFindings": [ /* §4 */ ],            // 必填（可为空数组）
  "provenance": "agent-judged"              // 必填，字面量。永不与 runtime 判定混淆
}
```

## 2. `steps[]`

```jsonc
{ "id": "submit",                           // 必须与 spec step id 一致
  "status": "completed",                    // completed | blocked | skipped
  "note": "用 role=button[name=Sign in] 定位",  // 可选：执行注记
  "evidence": ["step2-after-submit.png"] }  // completed 时必填
```

- spec 里每个 step 必须出现一条；`blocked` 必须带 `note` 说明卡在哪；
- **`completed` 必须带 ≥1 条 evidence**（截图 / URL 原文 / DOM 摘录之一）——没有证据的 `completed`
  只是 attested 不是 observed，report INVALID。这条规则的由来见 §9：4 轮实验里 3 轮独立在"证据可选"
  时省略了 step 证据，验证了"可选证据=没有证据"，所以这里钉死为强制。

## 3. `expect[]`（固定问卷，核心）

```jsonc
{ "id": "calls-signin",                     // 必须与 spec expect id 一致
  "verdict": "pass",                        // 枚举见下
  "evidence": "POST https://api.staging.glubean.com/api/auth/sign-in/email → 200",
  "reason": null }                          // unverified 时必填
```

**verdict 四值枚举（封闭，不许自造）**：

| verdict | 语义 | 约束 |
|---|---|---|
| `pass` | 检查了，符合 | `evidence` 必填非空 |
| `fail` | 检查了，不符合 | `evidence` 必填非空（fail 的证据价值最高） |
| `blocked` | 旅程没走到能检查的位置 | 对应 step 应为 blocked |
| `unverified` | 走到了但检查不了（如拿不到网络 trace） | `reason` 必填 |

**evidence 引用格式（v1）**：字符串，两种形态——

- 内联摘录：URL 原文 / 网络请求一行摘要（method + url + status）/ DOM 文本摘录 / console 消息原文，
  ≤500 字符；
- 文件引用：与报告同目录的相对路径（截图等），命名 `<round>-<step或expect id>-<自述>.png`。

**红线（定稿新增，2026-07-05）**：

- **evidence 不得包含原始 request/response body。** 网络类证据只允许 `method + url + status` 摘要，
  或对 body 存在性/形状的描述（如"body 含 user.email 字段"）——不允许贴出 body 原文。这条来自
  2026-07-03 实验后续反馈：body 原文里可能带密码、session token 等敏感字段，早期几轮 prompt 靠
  agent 自觉规避，这里升级为 schema 层强制规则。
- evidence 与全报告任何字段不得出现密码/token 明文（email 可以）。

## 4. `extraFindings[]`（自由观察附录）

内嵌元素结构收敛为 [`agent-finding/v1`](../../internal/40-discovery/proposals/agent-finding-v1.md)
（通用 agent 发现 schema，Mode B 只是进水口之一）：

```jsonc
{ "category": "layout",                     // functional | layout | perf | a11y | copy | console-noise | data | security | other
  "severity": "P3",                         // P1-P4
  "title": "dashboard 首屏卡片重叠",
  "note": "1280px 下轻微重叠，不遮挡内容",
  "evidence": ["extra1-dashboard-overlap.png"],
  "source": { "attention": "agentNotes[0]" },   // 或 "unprompted"
  "surface": { "url": "https://app.staging.glubean.com/dashboard", "repo": "cloud", "mod": "dashboard" } }
```

- 与 expect 结论**严格分离**：spec 外的观察只进这里，不许影响 expect verdict；
- `agentNotes` 引导但不限定；没有发现就 `[]`（字段本身必须存在——"看了没发现"和"没看"要可区分）；
- 内嵌元素只携带 `category / severity / title / note / evidence / source.attention / surface`；
  `source.producer`（由报告 kind 推导 = `"modeb-qa"`）、`source.model`/`source.date`（取
  `executor`）由报告级继承，`status` 由收集管道赋 `new`——内嵌形态不携带这三个字段，validator
  只校验内嵌字段。

## 5. Validation 规则（报告级判定）

以下任一 → **report INVALID = automation failure**（既不是 test failure 也不是 finding）：

1. `kind` / `provenance` 字面量不符；
2. `contract` / `case` / `contractRevision` / `executor.model` 缺失；
3. **漏答任何一条 spec expect**（固定问卷必须答满——这是最重要的一条）；
4. verdict 不在四值枚举内；
5. `pass`/`fail` 而 `evidence` 空；`unverified` 而 `reason` 空；
6. steps 未覆盖 spec 全部 step id，或 status 不在枚举内，或 `completed` step 无 evidence；
7. `extraFindings` 字段缺失（空数组合法，缺失不合法）；
8. 报告任何字段含已知 secret 明文。

参考实现：`test-project/agent-qa-report.ts`（`validateAgentQaReport()`）+
`test-project/agent-qa-report.test.ts`。

## 6. 失败语义对照

| 情形 | 语义 |
|---|---|
| expect verdict = fail | agent-attested **finding**，不是 test failure |
| report INVALID | **automation failure** |
| verdict = blocked | **QA incomplete** |
| gate 据 finding 挡 merge | gate 的 policy，不是 runner assertion |

## 7. Cloud / 本地字段分层（v1 立场）

- **P0 的"可回流"口径** = 可被 validator 解析 + 落本地 evidence 目录归档 + extraFindings 进 finding
  管道 + 回流所需字段齐备。**Cloud 上传不在 P0 内**；
- **v1 全部本地**（报告 + 截图落 repo/evidence 目录），不上传；
- 回流形态（agent-attested run vs 独立报告工件）P1 定；届时 `expect[]`/`extraFindings`/`steps[]`
  （去 evidence 文件引用）可上云，**截图文件经 PII policy（母提案 §5-②）前不上云**；
- `provenance: agent-judged` 在 Cloud 渲染里必须显性（不许渲染成红色 test failure）。

## 8. 对齐键与跨轮 diff

- 同 `contract + case + contractRevision` 的报告集合 = 一个可 diff 序列；
- `contractRevision` 变了 → 序列断开重新起算（旅程语义变了，fail 不可跨版本比）；
- diff 的最小单位是 expect id 的 verdict 变化 + extraFindings 的集合差（category+title 聚簇）；
- 参考实现：`test-project/agent-qa-report.ts`（`diffAgentQaReports()`）——比较两份报告的
  step id 集合、expect id 集合、逐 expect verdict 差异、extraFindings 标题差集。

## 9. 定稿变更记录（相对 2026-07-03 draft）

来自 `internal/acceptance-evidence/modeb-agent-qa-2026-07-03/RESULT.md` 的收敛发现，本次定稿吸收：

1. `completed` step 强制 ≥1 evidence（原 draft 已是这个规则，本次确认保留，未再放松）；
2. **新增**：evidence 禁止内嵌 request/response body 原文（§3），只许 method+url+status 摘要；
3. fixture 侧（`test-project/auth.browser.ts`）把三处"隐含默契"写成显式规则：
   - `url-dashboard` 从"不再是 /login"改成显式 pattern；
   - `dom-welcome` 绑定 landmark（heading level=1）+ 要求含用户名 + 要求"必须是提交后终态页面"；
   - `console-clean` 的"产品域名 vs 第三方噪音"边界从agent自由裁量改成显式规则；
   - expect 的隐含求值顺序（先 url 后 dom）写成显式注释。
4. 这些改动都是**措辞层**，schema 结构本身（字段/枚举/validation 规则）未变——4 轮实验的结论是
   "不稳定源全部在 spec 措辞层，不是模型能力问题"，所以定稿只收紧了 fixture 与本文档的措辞，没有
   改 schema 形状。
