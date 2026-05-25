# Demo Project + Mock Backend 设计

日期：2026-05-25

## 这份文档是什么

是 [04-config-profiles-public-demo-plan.zh.md](./04-config-profiles-public-demo-plan.zh.md)（以下简称 04 plan）里 "Public Project 与 Demo Project" 章节的展开。04 plan 描述了 demo project / public project / public dashboard 的概念边界与上传链路；本文档回答两个具体问题：

1. Demo project 跑什么 tests？测试目标用什么？
2. 怎么让 public dashboard 上的"实时检测 flaky"等叙事真实可信而不是为 demo 强造？

结论先行：**专用 demo project + 自家 mock backend（"narrative engine"）+ in-process synthetic canary** 三者组合。第三方公开 API（httpbin / jsonplaceholder）做不了 flaky 叙事——它们故意稳，给 demo 用要么 contrived 要么失去说服力。

本文档**不**重复 04 plan 已有的内容（profile schema / 上传链路 / Cloud DTO 约束等），只补 demo project 的具体形态与 mock backend 设计。

## 三种数据来源的分工

| 模式 | 实现位置 | 数据来源 | 叙事作用 |
|---|---|---|---|
| **synthetic in-process canary** | demo project test 文件里 `Math.random()` | test 进程内 | 永远在的 sanity probe，证明 reducer pipeline 自身活着，不依赖任何外部 |
| **mock-backend driven 故意故障** | 调 self-hosted demo backend | 自家 HTTP service，env-controlled 故障模式 | 真 HTTP 调用，narrative "Glubean 监控这个 API 自动发现它 30% 时间挂了"——可信 |
| **mock-backend driven 回归** | 同上，但 backend 用 `BROKEN_SINCE=YYYY-MM-DD` env 模式 | 同上 | narrative "5/20 这个 API 回归，Glubean 5 个 run 内 catch 到 stable→flaky transition" |

三种并存，各自独立叙事，互不依赖。任何一种坏掉都不影响其他两种。

## Demo project 结构

承袭 04 plan §"Demo project 模板"的目录，具体填充：

```text
demo-projects/glubean-public-demo/        # 或长成 glubean/templates/demo/ reference
├── glubean.yaml
│   suites:                                  # profile 引用的 suites 必须在此定义
│     api-stable:        { target: ./tests/api-stable,        kinds: [test] }
│     api-flaky:         { target: ./tests/api-flaky,         kinds: [test] }
│     contracts-stable:  { target: ./tests/contracts/stable,  kinds: [contract] }
│     contracts-drift:   { target: ./tests/contracts/drift,   kinds: [contract] }  # 故意会漂移, 只给 public-demo
│     canary:            { target: ./tests/canary,            kinds: [test] }
│   profiles:
│     local:                                 # `npm test` 走这个, 只跑确定性 suite
│       suites: [api-stable, contracts-stable]
│                                            #   故意不含 api-flaky / contracts-drift / canary
│     public-demo:                           # `npm run test:public-demo` 走这个, 含 flaky / drift
│       suites: [api-stable, api-flaky, contracts-stable, contracts-drift, canary]
│       upload:
│         enabled: true
│         projectAlias: glubean-public-demo
│   # package.json scripts:
│   #   "test": "glubean run --profile local"            ← 永远绿 (clone 后能 npm test 跑通)
│   #   "test:public-demo": "glubean run --profile public-demo --upload"
│   #                                                     ← 含 flaky, 退出码间歇性 non-zero by design
│
├── tests/
│   ├── api-stable/                       # 5-10 个稳定 pass test, 打 mock backend stable 端点
│   │   ├── get-users.test.ts             # GET /api/stable/users 返 200 + 固定 shape
│   │   └── ...
│   ├── api-flaky/                        # 调 mock backend flaky 端点, 30% 概率 fail
│   │   ├── search-flaky.test.ts          # GET /api/flaky/search?rate=0.3
│   │   └── ...
│   ├── contracts/
│   │   ├── stable/                       # 永远绿, 守 stable API 的 contract
│   │   │   └── users-contract.contract.ts    # 期望 /api/stable/users 返 { id, name, email }
│   │   └── drift/                        # public-demo only, 故意 catch schema drift
│   │       └── drift-detector.contract.ts    # 期望 /api/contract-drift/* 保持 schema (会失败 by design)
│   └── canary/
│       └── synthetic-50pct-flaky.test.ts # 100% in-process, Math.random()
│
└── demo/
    ├── data/                             # fixture
    ├── evals/                            # AI capability evals (per 04 plan demo-ai-evals)
    └── README.md                         # 解释每个 suite 在叙事里的角色
```

Demo project 自己只是 test 与 fixture；它不实现 mock backend。Mock backend 是独立 service。

## Mock Backend ("narrative engine") 设计

### 角色

一个你完全控制的小 HTTP service，**故意**提供几种典型故障模式，让 demo project tests 自然 catch 到。区别于"故意造 demo 假象"的关键：故障模式是**真实存在的产品场景的模拟**，不是为 demo 编出来的怪异路径。

### 端点矩阵

| 路径前缀 | 行为 | demo 叙事 |
|---|---|---|
| `/api/stable/*` | 永远 200，deterministic 返回 | "stable 测试群保持绿" |
| `/api/flaky/*?rate=N` | 概率 N (0-1) 返 5xx，否则 200 | "实时检测 flaky" |
| `/api/latency/*` | 高斯分布延迟 (mean=200ms, σ=80ms) | "p99 latency 跳点 / latency assertion 失败" |
| `/api/recently-broken/*` | env `BROKEN_SINCE=YYYY-MM-DD` 之后改返 5xx | "回归捕获 + stable→flaky transition" |
| `/api/contract-drift/*` | 周期性改 response schema（加字段 / 改类型） | "contract 守护抓 schema 漂移" |
| `/api/auth-required/*` | 没 token 返 401 | "auth flow demo" |

所有故障模式 **config-driven**：env / 启动参数 / runtime admin endpoint 来开关。你想 demo 什么故事，改环境变量 + 重启 mock backend 即可，不动 demo project tests。

### 实施栈

- **语言/框架**: Node + Hono（或 Express，看团队偏好；Hono 更小更快）。
- **代码量预估**: ~50-150 行（6 路由 + middleware + 配置加载）。
- **部署**: Fly.io free tier（256MB / sleep-on-idle）或 Vercel Functions / Cloudflare Workers。月成本 $0 起。
- **域名**: 单独 subdomain（如 `demo-backend.<your-domain>`），不混在主站。
- **观测**: 自带 `/admin/metrics` Prometheus 端点（可选，方便我们自己 dogfood Glubean metrics 集成到这个 backend）。

## Rate Limit 与滥用防护

mock backend 一旦公开 reachable，**必须**做 rate limit 与最低限度的认证，否则会变成"免费公开 API"被随机人当后端用，把你的 Fly.io quota 吃光、把 demo metrics 污染。

### 风险面

| 滥用形式 | 影响 |
|---|---|
| 个人/爬虫当免费 mock API 用 | quota / 流量超额；demo metrics 被污染（dashboard 上 "GET /api/stable/users" 显示一天 10k call 不是你 demo 跑出来的） |
| DDoS 放大 | mock backend 宕机 → demo dashboard 全红 → 你产品看起来挂了 |
| 故障模式 endpoint 被外部触发 | `/api/flaky/?rate=1` 会被人故意调成 100% 失败干扰你 demo |

### 防护层

1. **基础 rate limit（默认开）**: 单 IP 60 req/min。超过 429 + `Retry-After`。
2. **故障模式参数 lockdown**: `?rate=` 等可调参数需 query token（环境变量 `DEMO_ADMIN_TOKEN`），不带 token 走 default rate (e.g., 0.3 固定)。
3. **可选 demo project signing key**: demo project tests 调 mock backend 时，**在调 mock backend 的 HTTP 请求上**带 `X-Demo-Caller: glubean-demo` header + 共享 secret（不是在 result upload 到 Glubean Cloud 的请求上——那是另一条链路，跟 mock backend 无关）。让 mock backend 区分"我自家 demo 在调"vs"陌生流量"。陌生流量走更严 rate limit（10 req/min）+ 跳过 fault-injection 参数。实施上 demo project 在共享的 HTTP client wrapper (e.g. `demo/lib/mock-backend-client.ts`) 里统一注入这两个 header，secret 走 env `DEMO_BACKEND_CALLER_KEY`。
4. **CORS 白名单**: 只允许 Glubean 自家 demo / dashboard 域名做 browser-origin 调用。
5. **Fly.io / Vercel quota alert**: 超 80% quota 推 Slack/Email，防止 silent 烧到上限。
6. **Mock backend 自己的健康自检**: `/healthz` + `/readyz` 区分；rate limit middleware 不算进健康检查。

### 不做的

- **不要**真做完整 OAuth / API key 体系——mock backend 不是产品。
- **不要**记录调用方 IP 到任何 persistent log（demo backend 不收 PII）。
- **不要**把 admin token 暴露到 demo project repo（用 GitHub Actions secret 注入）。

## 与 04 plan 的对接

- 04 plan §Phase 5（CLI 端 demo template）`glubean init --template demo` 应该生成上面的 demo project 结构。Template 文件可以 hardcode `https://demo-backend.<your-domain>` 作为默认 mock backend URL，用户 fork 后想换自家 mock 改 env 即可。
- 04 plan §Phase 7（Cloud 端 dashboard）展示 public-demo profile 上传的 result 时，**不要**在 dashboard 上暴露 mock backend 自身的 admin endpoint / token / failure mode 配置——dashboard 是给观众看的，不是 mock backend 的 control panel。
- Mock backend 本身的代码 + 部署**不在** 04 plan 的 phase 范围内（它是独立 service），但 demo project 真要工作必须它先 deploy。建议作为 04 plan §Phase 5 启动前的 prerequisite。

## 落地顺序建议（独立于 04 plan phase 编号）

1. 先起 mock backend MVP（3 endpoint：stable / flaky / recently-broken；rate limit + 基本认证；deploy 到 Fly.io）。**不依赖 04 plan 任何 phase**，可独立 ship 验证。~1-1.5d。
2. demo project 雏形（5-10 test、1 contract、1 canary；指向 step 1 的 backend；本地 `npm test` 能跑通）。~0.5-1d。
3. 跟 04 plan Phase 5（CLI 端 demo template）合并 ship 时机：把 step 2 的成果固化进 `glubean init --template demo` 模板。
4. mock backend 扩展（latency / contract-drift / auth-required 3 个高级 endpoint）。Phase 5 ship 后 dashboard 上看真实数据时再补，避免一上来就 over-engineer。
5. 等 04 plan §Phase 7 真正上 dashboard 后，再 audit 一遍 mock backend 暴露面（是否需要 IP allow-list / 更严 rate limit / 切到付费 tier）。

## 开放问题

1. **Mock backend repo 在哪**：独立 repo (`glubean-demo-backend`) 还是 monorepo 子目录 (`glubean/demo-backend/`)？独立 repo 利于"它跟产品代码无关"边界清；子目录利于跟 demo project 共享 deploy/CI。倾向独立 repo。
2. **Mock backend 用什么域名**：自家根域子域 vs 完全独立域。子域 narrative 强（"Glubean 监控自家 demo backend"），但暴露主域 surface；独立域更干净但要新买/续费。
3. **Demo backend 自己要不要被 Glubean 测**（meta-dogfood）：如果 demo backend 本身有 Glubean 测试套件守护它，narrative 更深（"我们用自己的产品测试我们的 demo 后端"）。但增加循环复杂度。建议先不做，第一版稳定后再考虑。
4. **AI demo-ai-evals 套件用什么 provider**：OpenAI / Anthropic 真 API（要 key + 计费）vs mock LLM provider（fake responses）。mock 更安全但缺真实感。建议第一版用 mock，等 dashboard 验证后再考虑加真 provider 一条 suite（带 spending cap）。
