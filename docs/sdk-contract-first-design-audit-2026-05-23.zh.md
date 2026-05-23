# SDK / Contract-First 设计审计报告

日期：2026-05-23

范围：`@glubean/sdk` contract core、HTTP/GraphQL/gRPC contract adapters、scanner、CLI、MCP 相关 contract-first 链路。

## 结论

Contract-first 的核心方向是成立的，但当前不能宣传成“高可用地覆盖绝大多数场景”。更准确的判断是：

- 对 HTTP request/response、GraphQL query/mutation、gRPC unary 这类同步调用，当前 SDK 已经具备可执行 contract、可投影 metadata、可组合 flow 的基础。
- 跨协议能力是真实存在的，但不是“任意协议自动覆盖”。每个协议必须实现 `project()`、`normalize()`、`executeCase`、`executeCaseInFlow`、failure classification、artifact producers 等一整套 adapter 能力，否则只能得到部分能力。
- 作为 source-of-truth 的 contract-first 还差几道高可用闸门：协议能力矩阵、投影质量门禁、consumer fail-closed 一致性、schema/verify/bootstrap 可解释性、streaming/async 场景建模。

所以当前应定位为：**同步 API 行为契约的高上限方案，已经能跨 HTTP/GraphQL/gRPC 的核心路径，但还不是覆盖绝大多数真实系统交互的完整协议平台。**

## 主要证据

### 已经做对的部分

1. SDK core 已经从 HTTP 专用设计转成协议注册模型。

`contract.register(protocol, adapter)` 动态注册协议，并把 `contract[protocol]` dispatcher 挂到 namespace 上。核心只依赖 adapter 的 `project()` / `normalize()` / execution hooks，不直接 import HTTP 类型。见 `packages/sdk/src/contract-core.ts:202`、`packages/sdk/src/contract-core.ts:215`、`packages/sdk/src/contract-core.ts:228`、`packages/sdk/src/contract-core.ts:265`。

2. Contract projection 有统一 carrier。

`ProtocolContract` 同时携带 runtime `_projection` 和 JSON-safe `_extracted`。scanner / MCP / CLI 可以读取 adapter normalize 后的结构，而不是深挖 live object。见 `packages/sdk/src/contract-core.ts:641`、`packages/sdk/src/contract-core.ts:645`、`packages/sdk/src/contract-core.ts:649`。

3. 跨协议 flow 不是空话。

`contract.flow()` 的 step 接收 `ContractCaseRef`，运行时通过 `ref.protocol` 找 adapter，并要求 adapter 实现 `executeCaseInFlow`。这证明跨协议 flow 的抽象边界在 core 里，而不是 HTTP 特判。见 `packages/sdk/src/contract-core.ts:810`、`packages/sdk/src/contract-core.ts:818`、`packages/sdk/src/contract-core.ts:825`、`packages/sdk/src/contract-core.ts:1013`。

4. HTTP / GraphQL / gRPC 三个 adapter 已经迁移到 v10 logical input 模型。

HTTP 的 `body/params/query/headers`、GraphQL 的 `variables/headers`、gRPC 的 `request/metadata` 都接收 `needs` 解析后的 logical input。见 `packages/sdk/src/contract-http/adapter.ts:609`、`packages/graphql/src/contract/adapter.ts:493`、`packages/grpc/src/contract/adapter.ts:433`。

5. 插件化投影的方向正确。

artifact registry 把 `markdown`、`openapi` 等输出从 adapter interface 中剥离出来，支持能力枚举和 skip summary。OpenAPI 明确只支持 HTTP，Markdown 有通用 fallback。见 `packages/sdk/src/contract-artifacts.ts:24`、`packages/sdk/src/contract-artifacts.ts:240`、`packages/sdk/src/contract-artifacts.ts:430`、`packages/sdk/src/contract-artifacts.ts:493`。

## 设计漏洞 / 不完善点

### P0：CLI run discovery 的 fallback 策略与 scanner/MCP 不一致，可能破坏 fail-closed 可信度

scanner 在 runtime import 失败时，只允许 HTTP-only 文件走 static fallback；只要检测到非 HTTP 协议，就 fail-closed，避免“混合文件里 GraphQL/gRPC 丢了，但 HTTP 仍被静态抽出来”的半真状态。见 `packages/scanner/src/scanner.ts:317` 到 `packages/scanner/src/scanner.ts:345`。

MCP 也有同样的 mixed-protocol fail-closed 保护。见 `packages/mcp/src/index.ts:474` 到 `packages/mcp/src/index.ts:479`。

但 CLI run 的 `discoverTests()` 在 `.contract.` / `.flow.` 文件 runtime extraction 失败后，直接调用 `extractContractCases(content)`，没有 non-HTTP guard。见 `packages/cli/src/commands/run.ts:310` 到 `packages/cli/src/commands/run.ts:328`。

风险：同一份 contract-first 项目，在 `scan` / MCP 里 fail-closed，在 `glubean run` discovery 里可能退回静态 regex，导致 AI/CI 看到的是部分 contract inventory。对“contract first 作为 source of truth”来说，这是高优先级可信度漏洞。

建议：把 scanner/MCP 的 `hasHttp && !hasNonHttp` fallback gate 抽成共享函数，CLI run discovery 必须复用。混合协议 runtime import 失败时，应暴露结构化错误，不应静态抽取任何 case。

### P0：跨协议覆盖不是能力矩阵驱动，用户无法提前知道哪些协议能力完整

adapter interface 写清了很多能力是 optional：`executeCase`、`executeCaseInFlow`、`classifyFailure`、artifact producers、`renderTarget`、`describePayload`、`validateCaseForFlow`。见 `packages/sdk/src/contract-types.ts:448`、`packages/sdk/src/contract-types.ts:498`、`packages/sdk/src/contract-types.ts:518`、`packages/sdk/src/contract-types.ts:563`。

这让协议扩展灵活，但也意味着“支持一个协议”不是布尔值。一个 adapter 可能可以投影但不能 flow，能 markdown 但不能 OpenAPI，能 run 但 failure classification 弱。

建议：增加 protocol capability manifest，例如：

- `execution: standalone | flow`
- `projection: metadata | schema | examples | security`
- `artifacts: markdown | openapi | sdl | proto | asyncapi`
- `failureClassification: none | transport | protocol | semantic`
- `knownLimitations`

CLI/MCP/Cloud 必须按能力矩阵显示 “supported / partial / unsupported”，而不是用“协议已注册”暗示完整支持。

### P1：GraphQL 和 gRPC 仍是 Phase 1，不能支撑“绝大多数场景”

GraphQL 明确只支持 query + mutation，subscription / streaming deferred。见 `packages/graphql/src/contract/adapter.ts:27`、`packages/graphql/src/contract/types.ts:37`、`packages/graphql/src/contract/types.ts:209`。

gRPC 明确只支持 unary RPC，streaming deferred。见 `packages/grpc/src/contract/adapter.ts:27`、`packages/grpc/src/contract/types.ts:14`。

这些缺口不是小边角。真实系统中常见的 SSE、WebSocket、GraphQL subscription、gRPC streaming、Kafka/webhook/event-driven flows 都还没有 first-class contract protocol。当前 flow 能串多个同步调用，但不能表达长连接、事件流、重试窗口、最终一致性、乱序事件、幂等消费等语义。

建议：不要把“覆盖绝大多数场景”建立在 HTTP/GraphQL/gRPC 三个同步 adapter 上。下一阶段应优先补一个 event/stream contract family，而不是继续只扩 HTTP projection。

### P1：`verify()` 和 bootstrap 仍然是黑盒，source-of-truth 会出现语义盲区

SDK 已经承认 `verify()` 是 opaque code，无法可靠推导，必须靠 `verifyRules` 做 projectable companion。见 `packages/sdk/src/contract-types.ts:68` 到 `packages/sdk/src/contract-types.ts:80`、`packages/sdk/src/contract-types.ts:184` 到 `packages/sdk/src/contract-types.ts:189`。

bootstrap 的 body 也是 opaque，只投影 `params` schema；scanner 目前还写着 structured-form params extraction deferred。见 `packages/sdk/src/contract-types.ts:223` 到 `packages/sdk/src/contract-types.ts:228`、`packages/scanner/src/contract-extraction.ts:298` 到 `packages/scanner/src/contract-extraction.ts:302`。

风险：如果关键业务语义藏在 `verify()` 或 bootstrap `run()` 里，投影、review、Cloud、agent repair 都只能看到 “has verify()”，不能知道真实断言是什么。这会削弱 contract-first 作为 owner-readable truth 的价值。

建议：生成/审核 contract 时强制质量门禁：

- 有 `verify()` 必须有 `verifyRules`，且每条 rule 有稳定 id。
- 有 `needs` 必须尽量有可投影 schema；opaque validator 允许但要被标记为 degraded。
- 有 bootstrap structured params 时必须能出现在 attachment inventory。
- AI 生成的 contract 必须满足 “description + expect/verifyRules/deferred 三选一”。

### P1：schema normalization 是 best-effort，投影完整性没有硬失败策略

HTTP、GraphQL、gRPC 都通过 `.toJSONSchema()` 做 best-effort 转换，失败时返回 `null` / `undefined`。见 `packages/sdk/src/contract-http/adapter.ts:201` 到 `packages/sdk/src/contract-http/adapter.ts:225`、`packages/graphql/src/contract/adapter.ts:59` 到 `packages/graphql/src/contract/adapter.ts:72`、`packages/grpc/src/contract/adapter.ts:75` 到 `packages/grpc/src/contract/adapter.ts:89`。

SDK 的 case meta 已经把 `hasNeeds` 和 `needsSchema` 分开，说明它知道 “有 needs 但 schema 不可投影” 是合法状态。见 `packages/sdk/src/contract-types.ts:307` 到 `packages/sdk/src/contract-types.ts:325`。

风险：运行时可以严密，但投影不完整。对 Cloud、docs、OpenAPI/SDL/proto 生成、AI review 来说，这就是降级状态。如果没有质量门禁，用户会误以为 contract-first 已经提供完整 spec。

建议：把 projection quality 变成显式等级：

- `complete`: runtime validation + projectable schema 都存在。
- `runtime-only`: 可执行但不可完整投影。
- `metadata-only`: 只能看描述/状态。
- `invalid`: adapter normalize 失败或 required projection missing。

`glubean contracts` / MCP 应输出这些等级。

### P1：OpenAPI 路径跨协议是刻意不支持，但产品文案容易误导

artifact registry 明确 OpenAPI 没有 defaultRender，非 HTTP 协议会被 skip。见 `packages/sdk/src/contract-artifacts.ts:430` 到 `packages/sdk/src/contract-artifacts.ts:445`。

CLI `contracts --format openapi` 也注释说明只有 HTTP contract 贡献，非 HTTP 会被跳过。见 `packages/cli/src/commands/contracts.ts:479` 到 `packages/cli/src/commands/contracts.ts:483`。

这本身合理，但如果产品叙述说“contract-first 跨协议”，用户可能以为所有协议都能投影为同一类 spec。事实是：Markdown 可以 generic，OpenAPI 只能 HTTP，GraphQL 未来应是 SDL，gRPC 应是 proto/service docs，event protocol 可能是 AsyncAPI。

建议：文档和 CLI 输出中区分：

- cross-protocol execution / flow
- cross-protocol inventory
- protocol-specific artifact
- generic human projection

不要把 OpenAPI 作为 contract-first projection 的代表。

### P2：类型安全仍依赖 case factory，plain object authoring 仍有漂移风险

HTTP 类型文件已经说明：TypeScript 不能从同一个 case literal 的 `needs` 推导并约束 sibling function fields，必须用 `defineHttpCase<Needs>()` 才能锁住输入。见 `packages/sdk/src/contract-http/types.ts:125` 到 `packages/sdk/src/contract-http/types.ts:143`、`packages/sdk/src/contract-http/types.ts:167`。

compile-only test 里仍保留了 plain object drift 会编译的说明；后续用 `defineHttpCase` 才补上。见 `packages/sdk/src/attachment-model.test-d.ts:130` 到 `packages/sdk/src/attachment-model.test-d.ts:180`、`packages/sdk/src/attachment-model.test-d.ts:283` 之后。

GraphQL / gRPC 也提供了 `defineGraphqlCase` / `defineGrpcCase`。见 `packages/graphql/src/contract/types.ts:245` 到 `packages/graphql/src/contract/types.ts:259`、`packages/grpc/src/contract/types.ts:142` 到 `packages/grpc/src/contract/types.ts:159`。

风险：如果 AI 或用户直接写 plain object，输入 schema 与 function-valued request builder 可能漂移，runtime 只验证输入，不会验证 builder 有没有读错字段。

建议：skill、docs、templates、migration 输出都默认使用 `define*Case`。如果 case 有 `needs` 且 action field 是 function，但没有 factory 包裹，scanner/CLI 应给 warning。

### P2：MCP project-contracts 仍有 HTTP legacy view 债务

MCP 把新 shape 转成 `LegacyHttpContract`，注释明确这是 transitional shim，非 HTTP legacy fields undefined。见 `packages/mcp/src/index.ts:45` 到 `packages/mcp/src/index.ts:57`。

`projectContracts` 虽然输出 `protocol`，但仍走 legacy HTTP flattening，再 group / summary。见 `packages/mcp/src/index.ts:1434` 到 `packages/mcp/src/index.ts:1435`、`packages/mcp/src/index.ts:1472` 到 `packages/mcp/src/index.ts:1493`。

风险：AI 通过 MCP 理解项目 contract 时，会拿到“看似统一但实际 HTTP-shaped”的视图；跨协议细节丢失或变成 opaque blob。

建议：MCP 应增加 protocol-native contract view，直接返回 `ExtractedContractProjection`，legacy HTTP view 只用于 OpenAPI 或 backcompat。

### P2：README / docs 存在状态漂移

README 的插件表仍写 `@glubean/grpc` 是 “coming soon”，但当前 repo 已有 gRPC adapter、tests、package version `0.2.4`。见 `README.md:70` 到 `README.md:75`，以及 `packages/grpc/src/contract/adapter.ts:1` 到 `packages/grpc/src/contract/adapter.ts:28`。

风险：用户和 agent 会误判当前能力边界，尤其是“跨协议是否真实存在”这个问题。

建议：README 改成 “gRPC unary contract support; streaming deferred”，GraphQL 改成 “query/mutation; subscription deferred”。

## 对三个核心问题的直接回答

### contract-first 真的高可用吗？

**核心 runtime 层正在接近可用，但端到端还不能称为高可用。**

理由：

- core dispatcher、needs validation、bootstrap overlay、flow execution、adapter normalize 的主路径有较多测试覆盖。
- scanner/MCP/CLI 之间仍有 fail-closed 不一致。
- 投影质量仍可能 best-effort 降级。
- 关键语义可藏在 opaque `verify()` / bootstrap。
- gRPC live tests 在当前沙箱不能验证，说明这类协议对环境依赖更敏感，CI 需要明确隔离 live transport 与 pure adapter tests。

### 真的可以覆盖绝大多数场景吗？

**不能。当前覆盖的是“绝大多数同步 API contract 场景”的一部分，而不是绝大多数系统交互场景。**

比较稳的范围：

- HTTP REST/JSON APIs
- GraphQL query/mutation
- gRPC unary
- 多步骤同步 flow
- 需要 bootstrap 的前置状态准备

明显不足的范围：

- GraphQL subscription
- gRPC streaming
- WebSocket / SSE
- Kafka / queue / event bus
- webhook eventually-consistent flows
- browser/OAuth/captcha 强人机交互场景
- 数据库/文件系统/外部 worker 等非 request-response 操作

### 真的可以跨协议吗？

**可以跨协议，但跨的是 SDK 抽象，不是统一 artifact，也不是无 adapter 成本。**

已经成立的跨协议层：

- unified contract registry
- unified case lifecycle / severity / requires / defaultRun
- unified `needs` / `given` / `verifyRules`
- unified flow step model
- unified Markdown baseline

不成立或未完整成立的层：

- OpenAPI 不是跨协议 artifact
- streaming/event semantics 没有统一模型
- protocol-native projection 需要各 adapter 自己实现
- failure classification 没有统一强约束和质量等级
- MCP/CLI 对非 HTTP 仍有 legacy/shim 债务

## 建议路线

### 立即修

1. 修 CLI run discovery fallback：混合协议 runtime import 失败必须 fail-closed。
2. 增加 capability matrix，并在 `glubean contracts --format list-formats`、MCP、Cloud 显示协议能力。
3. README / docs 更新当前协议边界：GraphQL query/mutation、gRPC unary、streaming deferred。

### 下一阶段

1. 引入 projection quality gate：complete / runtime-only / metadata-only / invalid。
2. 强制 AI-authored/generated contract 的 `verifyRules` 和 description 质量。
3. MCP 返回 protocol-native projection，legacy HTTP view 限定给 OpenAPI/backcompat。
4. scanner warning：有 `needs` + function-valued action field 但未使用 `define*Case`。

### 中长期

1. 增加 event/stream contract family，覆盖 SSE/WebSocket/GraphQL subscription/gRPC streaming。
2. 增加 AsyncAPI / SDL / proto 等 protocol-native artifacts。
3. 把 flow 从同步 step orchestration 扩展到 temporal/eventual consistency semantics，例如 wait/retry/window/idempotency/event assertion。

## 验证记录

本次审计运行过：

- `pnpm --filter @glubean/sdk test`：通过，12 files / 476 tests。
- `pnpm --filter @glubean/scanner test`：通过，4 files / 136 tests。
- `pnpm --filter @glubean/graphql test`：通过，4 files / 101 tests，随后 `tsc --noEmit` 通过。
- `pnpm --filter @glubean/grpc test`：adapter/matcher 通过，但 live/index 测试在当前沙箱因 `listen EPERM: operation not permitted 127.0.0.1` 失败，不能作为产品失败结论。
- `pnpm --filter @glubean/cli test -- --run ...`：包脚本实际跑了整包 CLI 测试；`bootstrap-integration`、`contracts`、`run-discovery` 通过，其余大量子进程用例因 `tsx` IPC `listen EPERM` 失败。

