---
name: mode-b-agent-qa-experiment
status: protocol + judging criteria drafted for GLU-211 (scaffold step) — NOT a hypothesis verdict
date: 2026-07-05
relates: contract-browser-two-tier(母提案 §8 P0) · agent-qa-report-v1.zh.md(输出契约)·
  test-project/auth.browser.ts(实验用 fixture)· test-project/agent-qa-report.ts(validator + diff)·
  internal/acceptance-evidence/modeb-agent-qa-2026-07-03/(2026-07-03 的先验实验,详见 §5)
---

# Mode B(agent 自主 QA)稳定输出实验 —— 怎么跑 + 怎么判

> **本文档只做两件事：给一个一键可跑的实验协议，给一套客观的、能自动算出来的判定标准。**
> 它**不**替 owner 下"contract.browser 的 Mode B 产品假设是否成立"这个最终结论——那是产品判断，
> 见文末 §6"交给 owner 的判断"。GLU-211 这一步的任务是把判定标准和脚手架做到位，让 owner 一眼能看
> 结果、owner 或任何后续 agent 能一键重跑。

## 0. 待检验的假设（原文，母提案 §8 P0）

> 同一份 `contract.browser`，连续 N 轮**独立**的 agent（轮间互不可见彼此的报告），对 staging
> 做 QA，能不能产出**结构一致、expect 逐条有证据、可 diff、可回流**的报告。

## 1. 材料（本次 GLU-211 scaffold 提供的资产）

| 资产 | 路径 |
|---|---|
| 旅程 contract（P0 窄面，无 action） | `test-project/auth.browser.ts` |
| 输出契约（schema 定稿） | `docs/agent-qa-report-v1.zh.md` |
| Validator + diff 工具（有单测） | `test-project/agent-qa-report.ts` / `test-project/agent-qa-report.test.ts` |
| 实验协议 + 判定标准（本文档） | `docs/mode-b-agent-qa-experiment.zh.md` |

## 2. 一键跑一轮的 Prompt 模板

对任何独立 session/agent（Codex、claude subagent、cron 定时任务皆可）逐字给出：

```
你在执行 Mode B（agent 自主 QA）第 <N> 轮。这是独立执行——不许读同目录下其它轮次的
round-*.report.json，不许假设其它轮次的结论。

输入（先全部读完再动浏览器）：
1. 旅程 contract：test-project/auth.browser.ts
   —— steps[].intent 是执行指令（按顺序）；expect[] 是必须逐条回答的固定问卷（注意 expect
      数组里写明的求值顺序：先 url，再 dom/calls/console）；agentNotes 是附加注意力（发现只
      进 extraFindings，严禁影响 expect verdict）。
2. 输出契约：docs/agent-qa-report-v1.zh.md（严格遵守，尤其 §3 的 evidence 格式红线——网络证据
   禁止贴 request/response body 原文）。
3. BASE_URL 与凭证：读 glubean-dogfood 项目的 .env（BASE_URL）与 .env.secrets
   （TEST_LOGIN_EMAIL/TEST_LOGIN_PASSWORD）。密码可进你的上下文，但不得进报告任何字段。

执行：
- 新开自己的浏览器 page，按 steps 顺序执行 intent；只操作/关闭自己开的 page。
- 每个 completed step 必须留 ≥1 条证据（URL 原文 / DOM 摘录 / 截图之一）。
- 旅程结束后逐条自查 expect，按 auth.browser.ts 里每条 expect 的 assert 文本判定
  （文本已经把求值顺序、DOM landmark 绑定、console 噪音边界等规则写死，照做即可，不需要自由裁量）。
- agentNotes 观察写进 extraFindings（不影响 expect verdict）。

输出：
- 报告写 round-<N>.report.json，严格符合 agent-qa-report/v1；
- contractRevision：对 test-project/auth.browser.ts 的语义子集
  （entry + agentNotes + steps[].{id,intent} + expect）做 canonical hash（沿用
  internal/acceptance-evidence/modeb-agent-qa-2026-07-03/revision.mjs 的算法，或等价实现）；
- executor = { kind: "agent", model: "<精确 model id>", round: <N>, startedAt/finishedAt }；
- provenance = "agent-judged"；密码明文零出现；
- 用 test-project/agent-qa-report.ts 的 validateAgentQaReport() 校验（配合
  specFromBrowserContract(loginJourney, "happyPath") 取 spec），INVALID 就修报告直到 VALID
  （不许改 validator 本身来迁就报告）。

最终回复：validator 结果（valid/errors）+ 执行摘要（每步怎么做的、遇到的歧义、contract 哪里写
得还不够清楚）。环境不可用/staging 不可达 → 如实全 blocked + note，不编造。
```

## 3. 汇总方式（跑完 N 轮之后）

对每一对报告跑 `diffAgentQaReports(a, b)`（`test-project/agent-qa-report.ts`），或者写一个几行的
脚本对所有轮两两比较。产出一张表：

| 检查项 | 怎么算 | 来自 |
|---|---|---|
| 每轮 validator 是否 VALID | `validateAgentQaReport(report, spec).valid` | 自动 |
| 跨轮 step id 集合是否一致 | `diff.sameStepIdSet` | 自动 |
| 跨轮 expect id 集合是否一致 | `diff.sameExpectIdSet` | 自动 |
| 逐 expect verdict 是否一致 | `diff.disagreements`（为空 = 完全一致） | 自动 |
| 分歧的 verdict 是否有独立证据支撑 | 人工看 `evidence` 字段，判断是否指向真实环境差异 | 人工，≤5 分钟/次分歧 |
| extraFindings 差集 | `diff.extraFindingsOnlyInA/B` | 自动 |
| 报告全文密码/token 明文 | `validateAgentQaReport(report, spec, { knownSecrets: [...] })` | 自动 |

## 4. 判定标准（客观、可自动算出大半）

**成立信号（全部满足 → 支持假设成立）**：

1. **结构 100%**：N/N 报告 `valid === true`（validator 零豁免）；
2. **对齐键一致**：N 份报告的 `contractRevision` 全部相同（若不同，说明轮间跑的不是同一版
   contract，直接不可比，不算入样本）；
3. **问卷覆盖 100%**：`diff.sameExpectIdSet` 与 `diff.sameStepIdSet` 在所有两两组合上都是
   `true`（这条其实被 validator 间接保证——只要都 VALID，这条必然成立；单独列出是因为它是
   假设里"结构一致"四个字的直接算子）；
4. **无环境解释的 verdict 分歧 = 0**：`diff.disagreements` 非空的每一条，都能在 `evidence`
   字段里找到独立可核的理由说明"这是环境真实差异"（如某轮命中了一个真实的间歇性 404），而不是
   "两个 agent 对同一句话理解不同"。后者才是需要回去改 contract 措辞的信号；
5. **零泄漏**：N 份报告全部通过 `knownSecrets` 检查；
6. **可回流字段齐备**：每份报告都能被 `specFromBrowserContract` + `validateAgentQaReport`
   在不改代码的情况下解析（= "可被下一个 agent/脚本消费"的操作性定义）。

**不成立/需要回炉的信号**：

- 任何一轮无法通过 validator 收敛到 VALID（多次修改报告仍 INVALID，说明 schema 或 contract
  本身有歧义，agent 填不出结构正确的答案）；
- 同一 `contractRevision` 下出现 expect id 集合不一致（说明 agent 没有把 expect 当固定问卷，
  在自由发挥）；
- verdict 分歧找不到环境证据支撑，纯粹是措辞理解分歧，且经过一轮 contract 措辞修订后仍复现
  （说明问题不在措辞，可能是任务本身对 agent 来说有效执行下限不够）。

**灰色地带（不直接判定，记录留给 owner）**：

- `extraFindings` 数量/深度的方差——附录本来允许方差，但如果方差大到"某条 agentNotes 从来没人
  覆盖"，是 agentNotes 该升级成 agentNotes 显式化或 expect 的信号（棘轮方向，见母提案 §2.6-pre），
  不是假设本身不成立的信号；
- 单轮成本（tokens/时间）——commit gate 场景下是否可负担，是产品/成本判断，不属于本文档的
  结构性判定标准范畴。

## 5. 先验数据（2026-07-03，已存在，方向性参考——不是本轮 GLU-211 的正式记录）

在 GLU-211 开票前，母提案的可行性验证阶段已经跑过一轮 4 轮独立 sonnet-5 实验，材料落在
`internal/acceptance-evidence/modeb-agent-qa-2026-07-03/`（`PROTOCOL.md`/`RESULT.md`/
`round-1..4.report.json`）。摘要：

- 4/4 轮 validator 最终 VALID；
- `contractRevision` 4 轮一致；
- `url-dashboard`/`dom-welcome`/`calls-signin` 三条 verdict 3 轮有效样本 100% 一致；
- `console-clean` 出现 1 次 fail，证据链指向真实环境差异（一次冷加载触发的 404 竞态），不是
  agent 间理解分歧；
- 密码明文 0 泄漏；
- 识别出的全部不稳定源都在 spec 措辞层（§9 变更记录已列出并吸收进本次的 fixture/schema 定稿）。

**这批数据不能直接算作 GLU-211 的正式记录**，原因：跑的是 review 6 之前的旧措辞版 fixture 和旧
（硬编码单文件用途的）ad-hoc validator，不是本次 GLU-211 定稿的 `test-project/auth.browser.ts` +
`test-project/agent-qa-report.ts`。**建议**：按本文档 §2 协议，用定稿后的资产至少再跑一批独立轮
次（3 轮起），把结果正式记进 GLU-211（issue comment 或新的 acceptance-evidence 目录），再连同
2026-07-03 的先验数据一起交给 owner 做最终产品判断。

## 6. 交给 owner 的判断

即便 §4 的客观标准全部满足，以下问题仍是产品判断，本文档不代为回答：

1. §4 的标准满足到什么程度算"好到可以投入 P1"（如"1/12 条 verdict 有环境解释的分歧"算不算
   可接受噪音）；
2. 下限（sonnet 5）已经通过是否足够，还是必须验证上限模型（opus/fable）后才拍板；
3. 两个先验实验中发现的真 bug 线索（proj_default targets 404、get-session ERR_ABORTED）是否现在
   报 Linear，还是等 P0 正式收尾一起报；
4. P0 假设成立与否，以及是否按母提案排 P1（Mode A 最小支撑 + `glubean qa` 记录器）。
