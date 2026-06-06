# 08 · AST 提取器统一方案(用 acorn + acorn-typescript 100% 替代正则静态扫描)

状态:设计稿(待 codex 收敛 → owner 批准后实施)
作者:peisong + Claude
日期:2026-06-06
影响包:`@glubean/scanner`(主)、`vscode`(consolidation 目标)、间接 `@glubean/cli` / `@glubean/mcp`

---

## 1. 背景与动机

### 1.1 正则到了天花板

`packages/scanner/src/extractor-static.ts` 用**纯正则 + 手写字符扫描**从源码静态提取测试/合约元数据。在给 `test().poll` / `condition` / `switchOn` / `switchCond` 这些分支与轮询 builder 增加静态 step 提取时,正则方案连续 ~19 轮 codex review 都收敛不掉,每轮暴露一类新的 TS 词法/语义边缘:

- 字符串/模板/注释/**正则字面量**里的括号扰乱深度计数;
- regex-vs-division 歧义(`{n:1}/2`、`"6"/2`、`/a/ / n`、`schema.of/2`、`catch {} /re/`);
- 平衡泛型(`.poll<Array<{id}>>`、`<() => string>`、`<{a;b}>`、跨行);
- builder fragment 的回调 vs 非回调实参(predicate / 工厂 / `.meta` 实参);
- 甚至需要 **return-value 数据流**(`(b) => { b.poll("x"); return b.step("y") }` 只有返回的链才算 step)——正则**原理上**做不到。

结论:**静态提取要 100% 正确,必须有真正的 AST**。正则方案已被回退到 Phase 3 baseline(见 commit `cfe17e7`),runner 的真修复(out-mapper 逃逸 + 空 error)保留并已 codex 确认 sound。

### 1.2 团队其实已经选过型

VSCode extension(`vscode/src/`)**早就在用 AST**:
- `ast.ts` —— acorn + acorn-typescript 的薄封装,自带注释收集、`satisfies` 兼容、表达式 unwrap、对象/属性/方法链 helper。其文件头注释明确:*"Replaces the previous full `typescript` module with `acorn` + `acorn-typescript`(~600KB total bundled vs ~3MB for `typescript`)"* —— **团队试过 `typescript`,因体积换成了 acorn-typescript**,并刻意做成"换 parser 只改一个文件"。
- `contractAst.ts` —— 已用它做 contract / flow / bootstrap 标记的 AST 提取。
- `parser.ts` —— 但对 **test()/each/pick** 仍然**转头调用 `@glubean/scanner` 的正则 `extractFromSource`**。

也就是说:**glubean 已有两套 test 提取**(scanner 正则 + vscode 转调它),且 AST 基础设施(acorn)在 vscode 已生产验证。

### 1.3 目标(owner 决策:方案 B,consolidate)

把 AST 提取**收敛进 `@glubean/scanner`**,让 **CLI / MCP / VSCode 共用同一套 AST extractor**,删掉正则 `extractor-static.ts`,vscode 的 `ast.ts` / `contractAst.ts` 复用 scanner 的实现而非各持一份。

---

## 2. Parser 选型(已定)

**acorn + acorn-typescript + acorn-walk**(纯 JS)。

| 维度 | 结论 |
|---|---|
| TS 覆盖 | 全(acorn-typescript 用于 Svelte 等生产场景;测试/合约文件是普通 TS) |
| 形态 | **纯 JS,无原生二进制** → Node/Deno/Bun/各 CI arch 都稳(对 published `@glubean/scanner` 关键) |
| 体积 | ~600KB(vs `typescript` ~3MB bundled / 磁盘 ~23MB) |
| 验证 | vscode `ast.ts` 已生产使用 |
| 可换性 | 薄封装隔离,换 parser 只改一个文件 |

**已知坑 + 兜底**:acorn-typescript ≤1.4.x 不支持 `satisfies`。vscode `ast.ts` 已有 pre-normalization(逐字符扫描,把代码区的 `satisfies T` 替换为 `as T` + 等长填充,保留列号,且不误伤字符串/模板/注释里的 `satisfies`)。我们**原样继承**这段兜底,并加测试锁死。

被否方案:`typescript`(体积,团队已弃)、`oxc-parser` / `@swc/core`(原生二进制,Deno/冷门 arch/edge 风险;扫几百个小文件不需要这速度)、`acorn` 裸用 / `espree`(TS 不全)。

---

## 3. 范围(Scope)

### 3.1 In-scope —— 本设计**要替换**的:`extractor-static.ts` 全部静态文本分析

| 公开 API | 消费者 | 是否消费 `steps[]` |
|---|---|---|
| `extractFromSource(content, customFns?) → ExportMeta[]` | CLI `discoverTests`、MCP `discover_tests`、vscode `parser.ts` | 否(均丢弃 `steps[]`,只取 id/name/tags/meta;见 §3.3) |
| `extractAliasesFromSource(content) → string[]` | scanner Phase 1、vscode | — |
| `extractContractCases(content) → ContractStaticMeta[]` | scanner Phase 4 → `BundleMetadata.contracts` | — (**被消费**) |
| `extractPickExamples(content, opts?) → PickMeta[]` | vscode CodeLens / diagnose | — (**被消费**) |
| `isGlubeanFile(content, customFns?) → boolean` | 快速门控 | — |
| `createStaticExtractor(readFile, customFns?)` | scanner 注入 | — |

并 consolidate vscode 侧:`ast.ts`(helper)、`contractAst.ts`(contract/flow/bootstrap AST)、`parser.ts` 对 scanner 的依赖。

### 3.2 Out-of-scope —— **不动**的

- **运行时动态提取**:`contract-extraction.ts` 的 `extractContractFromFile` / `extractContractsFromProject`(通过 `import()` 读取 contract/flow 的运行时对象形状)。这条路本就不是正则,继续保留。AST 只替换**静态文本分析**层。
- **scanner 扫描骨架 / 路由**:`scanner.ts` 的 5 阶段、文件后缀路由、`ScanOptions` 默认值不变(见 §3.4)。**特别注意保留 contract/flow 的双向处理**(Phase 4 对 `contractFiles + flowFiles` 都跑合约提取;Phase 5 对 `flowFiles + contractFiles` 都跑 flow 提取),因为 `.flow.*` 可内联导出 contract、`.contract.*` 可导出 flow。AST 迁移**不得**退化成"按后缀单向路由",否则混合文件会丢元数据。
- **runner / sdk / 执行路径**:权威 step 结构来自 runtime `import()` → `Test.steps`(完整 `StepDefinition`,含 `branch`/`poll`),由 execution / upload gate / contracts 可视化使用;本设计不触碰。
- 公开**输出契约**(`ExportMeta` / `PickMeta` / `ContractStaticMeta` 等的字段语义)保持不变(§5)。

### 3.3 关于 `ExportMeta.steps[]`

澄清(纠正初稿)。`steps[]` 没有**代码消费者**做逻辑判断——CLI `discoverTests` / MCP `discover_tests` 在映射时都丢弃它(只取 id/name/tags/meta)。**但它是公开产物的一部分**:`Scanner.scan` 把 extractor 结果原样存进 `files[path].exports`,CLI 的 `buildMetadata`(`packages/cli/src/metadata.ts`)再把 `scanResult.files` 拷进 `metadata.json`(上传 bundle 的一部分)。所以 `ExportMeta.steps[]` **会随 `metadata.json` 输出**——它是 public 字段,删除属于 bundle schema 的破坏性变更。

设计决策:**保留并做对**。AST 版按 `flattenStepsForRegistry`(sdk `builder.ts`)的语义产出"扁平叶子(含 branch case/default 与 poll 展平)",一次做对——AST 让这件事变得平凡(不再有正则那 19 轮的边缘)。**不提供删除选项**;如确需删除,须按 `metadata.json` schema 迁移单独立项(见 §9.1)。

### 3.4 扫描骨架(事实,供对照,不改)

- `DEFAULT_EXTENSIONS = [".ts", ".js", ".mjs"]`;`DEFAULT_SKIP_DIRS = ["node_modules", ".git", "dist", "build"]`。
- 后缀**分桶**:`*.test.*` → 测试桶;`*.contract.*` → 合约桶;`*.flow.*` → 流桶。
- 但**提取是跨桶的**:Phase 4 合约提取跑 `[...contractFiles, ...flowFiles]`,Phase 5 flow 提取跑 `[...flowFiles, ...contractFiles]`(`.flow.*` 可内联 contract、`.contract.*` 可导出 flow)。后缀只决定进哪个桶,不决定跑哪种提取。
- 5 阶段:① 收别名(`extractAliasesFromSource`)② 收集并分桶文件 ③ 抽测试元数据(注入的静态 extractor)④ 抽合约元数据(对 contract+flow 文件跑运行时 `extractContractFromFile`;失败回退静态 `extractContractCases`)⑤ 抽 flow 元数据(对 flow+contract 文件跑运行时提取)。

---

## 4. 架构与模块划分

### 4.1 目标模块布局(`packages/scanner/src/`)

```
ast.ts              ← 新增:从 vscode/src/ast.ts 移入(acorn 薄封装 + helper 工具箱)
extractor-ast.ts    ← 新增:在 AST 上实现全部静态提取(替代 extractor-static.ts)
contract-ast.ts     ← 新增:从 vscode/src/contractAst.ts 移入(contract/flow/bootstrap 标记 AST)
extractor-static.ts ← 删除(parity 验证通过后)
static.ts           ← 不变:`@glubean/scanner/static` 子路径,re-export 公开 API(改为指向 extractor-ast)
index.ts            ← 不变的对外签名;内部 re-export 切到 AST 实现
```

新增子路径导出(`package.json` exports):
- `@glubean/scanner/ast` → `ast.ts`(给 vscode `dataDrivenRows.ts` / `contract-ast.ts` 复用 helper)
- `@glubean/scanner/static` → 现有,API 不变(`extractFromSource` / `extractAliasesFromSource` / `extractContractCases` / `extractPickExamples` / `isGlubeanFile` / `createStaticExtractor` / `PickMeta` / `ContractStaticMeta` …)

### 4.2 依赖变更

`@glubean/scanner/package.json`:`dependencies` 由 `{}` 增加 `acorn`、`acorn-typescript`(必要时 `acorn-walk`,但 `ast.ts` 已自带 `walk`,可不引)。这是 scanner 第一个运行时依赖;均纯 JS。

### 4.3 vscode consolidation(爆炸半径)

- vscode 删除自有 `ast.ts` / `contractAst.ts`;`import "./ast"` / `"./contractAst"` 改为 `"@glubean/scanner/ast"` / `"@glubean/scanner"`(或新子路径)。
- vscode `parser.ts` 的 `extractTests` 适配层(`ExportMeta → TestMeta`,`each:` / `pick:` 前缀路由、step 对象→字符串、行号)**保留在 vscode**(那是 VSCode 内部 UI 契约,不进 scanner)。
- `dataDrivenRows.ts` 改用 `@glubean/scanner/ast` 的 helper。
- 受影响 vscode 文件 ~10 个,基本是 import 重定向。vscode `parser.test.ts` 成为**跨仓 conformance**的一部分。

---

## 5. 兼容契约(必须 100% 匹配)

新 AST 实现对外**字段级、行为级**与正则版一致;**现有 138 个 scanner 单测 + vscode `parser.test.ts` 必须不改而全过**(它们就是 conformance 套件)。下表为 owner/codex 复核的硬契约。

### 5.1 数据形状(不变)

- `ExportMeta`(types.ts):`type:"test"` / `id` / `name?` / `tags?` / `requires?` / `defaultRun?` / `timeout?` / `skip?` / `only?` / `variant?:"each"|"pick"` / `groupId?` / `exportName` / `location?{line,col}` / `steps?{name,group?}[]` / `parallel?`。
- `PickMeta`:`testId` / `line` / `exportName` / `keys:string[]|null` / `dataSource?`(8 种:`inline` / `json-import` / `dir-merge` / `dir` / `dir-concat` / `yaml-map` / `json-loader` / `json-map`,带 `path`)。
- `ContractStaticMeta` / `ContractCaseStaticMeta` / `ContractVerifyRule`:字段保持(contractId/protocol/endpoint/description/feature/deprecated/cases;case 的 key/line/expectStatus/deferred/lifecycle/severity/requires/defaultRun/given/hasExample/hasVerify/verifyRules…)。

### 5.2 行为清单(AST 必须覆盖)

1. **test() 形态**:字符串 id;`TestMeta` 对象(id/name/tags(数组|单串→数组)/timeout/requires/defaultRun/skip/only)。
2. **builder**:`.meta()`(可在 `.step` 前后,字段优先)+ `.step()` 步骤抽取。
3. **test.each()**:字符串模板 id / 对象 meta / builder 链 / `{ parallel: true }` → `parallel`;`variant:"each"`;模板变量(`$id`)保留不解析。
4. **test.pick()**:`variant:"pick"`;`extractPickExamples` 的 8 种 dataSource + 路径解析(`filePath` 相对 vs `projectRoot` 裸路径 vs 绝对;仅一方提供时的保留规则;`../` 解析);无法解析 → `keys:null`。
5. **别名**:`extractAliasesFromSource` 发现 `export? const X = Y.extend(...)`(含链式、非约定名;注释内忽略);`customFns` 两层合并(构造时 + 运行时)。
6. **isGlubeanFile**:SDK import(`@glubean/sdk` / `jsr:@glubean/sdk`)+ 约定/别名命名(单词边界:`test`/`task`/`*Test`/`*Task`,不误中 `latestResult`/`attest`/`multitask`)。
7. **contract**:`extractContractCases` 抽 `contract.http/grpc/graphql(...)` 的 id/protocol/endpoint/description/feature + 每个 case 的 key/line/status→expectStatus/deferred/requires/defaultRun/given 等;多合约同文件;无 cases → `[]`。
8. **多导出**:按出现顺序;非 `export` 的 `const x = test(...)` 忽略。
9. **行号**:1-based,`location.line` / case line 精确。
10. **注释**:块/行注释内的 `test()`/`contract()` 不提取;字符串内的 `//`/`/*` 不算注释。

### 5.3 AST 带来的**修正**(正则做不到、现在会变正确)

下列是正则版**文档化的局限**或被我们 19 轮证明做不对的点,AST 版将正确处理。**凡可能影响既有输出的,以"现有 conformance 测试不变全过"为底线**,差异仅发生在正则版本来就**错/漏**的输入上:

- 深层/多行/复杂对象字面量(正则:可能解析不全)。
- `satisfies` / `as` / `!` / `<T>()` 泛型、跨行泛型、函数类型泛型(正则:词法炸)。
- 字符串/模板/正则字面量内的括号与关键字(正则:深度错乱)。
- branch/poll fragment 的 step 嵌套与"只算返回链"语义(正则:原理不可达)——AST 按 `flattenStepsForRegistry` 复刻。

> 注:§5.3 的修正若产生**与正则旧输出不同**的结果,且该输入在现实测试文件中真实存在,需在 PR 中显式列出并加测试;不得静默改变已被消费的输出(尤其 `ContractStaticMeta` 与 `PickMeta`)。

---

## 6. 逐 API 的 AST 实现要点

统一用 `ast.ts`:`parseSource(content)` → `forEachExportedConst` 遍历顶层 `export const`,对每个 init 表达式判别。

- **判别 test/each/pick**:从 init 的方法链根定位 callee:`test(...)` / `test.each(...)(...)` / `test.pick(...)(...)` / 别名同形;`findPropertyCall` 找 `.meta` / `.step` / `.poll` / `.group` / `.use` / `.condition` / `.switchOn` / `.switchCond`。
- **id / meta**:首参 `stringFromExpression`(字符串/无替换模板)或 `objectFromExpression` + `objectProperty` / `stringProperty` 读 id/name/tags/timeout/requires/defaultRun/skip/only;`tags` 单串归一为数组。
- **steps**:沿 builder 链收集 `.step`/`.poll` 的首参名;遇 `.group`/`.use`/`.condition`/`.switchCond`/`.switchOn` 的**回调实参**(`(b) => …` / `function(b){…}`)递归收集其返回链的叶子,按 `flattenStepsForRegistry` 展平(predicate/lens/工厂实参不计)。AST 上"哪个是回调、哪个是返回链"是结构信息,天然可判。
- **variant / parallel / groupId**:`each`/`pick` 由 callee 形态判;`parallel` 读 `.each(data, { parallel: true })`;`groupId` 规则同现状。
- **aliases**:遍历 `export? const X = <expr>.extend(...)`,取 `X`。
- **pick examples**:定位 `test.pick(<arg>)`,`<arg>` 为内联对象 → 取键;为标识符 → 回溯其 `import` / `const X = await fromXxx(...)` 绑定判 dataSource 与路径(`findImportPath` + 表达式匹配);解析不出 → `keys:null`。路径解析复用现有 `data-path.ts` 的 `resolveDataPath`。
- **contract cases**:复用/移入 `contract-ast.ts` 的 `contract.*(...)` 调用识别 + cases 对象遍历,产出 `ContractStaticMeta`。
- **isGlubeanFile**:import 声明 AST 判 SDK 来源;别名/约定判命名(单词边界由 AST 标识符天然保证)。
- **注释**:`parseSource` 的 `onComment` 收集;不再需要 `stripComments`——注释天然不在 AST 表达式里(标记类用 `hasLeadingMarker`)。

---

## 7. 迁移计划(分阶段)

**每阶段两道 review 闸(owner 2026-06-06 定的新规则)**:实现 → ① 先起 **review subagent(Opus 4.8,exhaustive/xhigh brief)反复收敛到干净** → ② 再 **`codex review` 收敛到零** → vitest 绿 → commit。与 [[condition_switch_unlimited_codex_rounds]] 一致:授权不限轮次。

- **P0 — 落地 parser 与 helper**:scanner 加 `acorn`/`acorn-typescript` 依赖;移入 `ast.ts`(+ `satisfies` 兜底)并补单测(移植 vscode `ast` 相关测试)。新增 `@glubean/scanner/ast` 子路径。**不改任何提取行为**(extractor-static.ts 原样保留),纯加基础设施 → 低风险。
- **P1a — sdk 导出 flatten 纯函数**(§9.4):把 `flattenStepsForRegistry` 抽成 sdk 导出函数,运行时内部改调它(行为不变 + 测试锁);scanner 后续 import 复用。
- **P1 — test 路径 AST 化**:实现 `extractor-ast.ts` 的 `extractFromSource` / `extractAliasesFromSource` / `isGlubeanFile` / `createStaticExtractor` / `extractPickExamples`(steps 用 P1a 的 sdk flatten);`static.ts` 切到它;**现有 138 测试不改全过** + 新增"正则做不到"的用例(§5.3,即 R2–R20 场景)。
- **P2 — contract 路径 AST 化**:移入 `contract-ast.ts`,实现 AST 版 `extractContractCases`;scanner Phase 4 conformance(`ContractStaticMeta` 输出对齐;有真实差异则显式列出 + 测试)。
- **P3 — consolidate vscode**:vscode 改 import 指向 `@glubean/scanner`,删自有 `ast.ts`/`contractAst.ts`;`dataDrivenRows.ts` 用共享 helper;vscode `parser.test.ts` 跨仓全过。需 scanner 发版 + vscode 升依赖(发版走 §8 风险4 的 `v*` tag CI)。
- **P4 — 删除正则**:parity 全绿后删 `extractor-static.ts`;清理死代码(`stripComments`/`findMatching` 等若无引用)。

每阶段独立可提交、可回滚;P1/P2 完成即拿到"100% 替代正则(scanner 侧)";P3/P4 完成"全仓单一来源"。

---

## 8. 风险与缓解

1. **acorn-typescript 维护性 / 新语法滞后**:薄封装隔离(换 parser 改一处);`satisfies` 兜底已有;锁版本 + 测试覆盖现实 TS。
2. **输出漂移**:既有 conformance 测试(scanner 138 + vscode parser.test)不改全过为硬底线;`ContractStaticMeta`/`PickMeta` 这类被消费的输出做 golden 快照。
3. **性能**:AST parse 比正则重,但 parse-only(不建 Program、不读 tsconfig、不碰 FS),量级是几百个小文件;P1 后跑一次基准(scan 一个真实 dogfood 项目)对比,设回归阈值。必要时按 `isGlubeanFile` 先门控再 parse。
4. **跨仓版本耦合**(P3):scanner 是已发布包,vscode 依赖它。发版走 repo 的**协调发布**:`.github/workflows/publish.yml` 由 `v*` tag 触发(workflow 内部用 `pnpm publish` 自动把 `workspace:*` 转真实版本),**不是本地手动 `pnpm publish`**。P3 需要 scanner 新版时,流程是:bump 版本 → commit → 打 `v*` tag → push(让 CI 发布),再升 vscode 依赖;P3 之前 vscode 维持现状,不阻塞 P1/P2。
5. **体积**:+~600KB 到 scanner 运行时依赖。consolidate 后 vscode **净减**(删掉自有 ~600KB 副本,改为共享),CLI/MCP 增 ~600KB(可接受,且远小于 typescript)。
6. **原生二进制**:无(纯 JS)。
7. **`ast.ts` 已知限制(P0 两道 review 发现)**:
   - **acorn-typescript 解析缺口(会抛)**:`<Foo>bar`(.ts 角括号类型断言)和 `<const T>`(TS 5.0 const 类型参数)acorn-typescript 都解析不了(前者当 JSX 抛 "Unterminated JSX",**无 plugin 选项可关**——实测 `jsx:false`/`dts:true` 无效)。Glubean 用 `expr as T`、几乎不用这两者,实际不踩。**硬要求:P1 的 `extractFromSource` 必须把 `parseSource` 抛错当"该文件不可解析 → 跳过 + warn",绝不 crash**(现 scanner 的正则 extractor 从不抛,所以这是 P1 新增的 crash 面,必须兜)。已加测试锁定。
   - **regex 字面量体**:`normalizeSatisfies`/`_doScan` 不跳过 regex body,体内字面 `satisfies` 会在归一化文本里被改写。**对提取不可见**(`parseSource` 保留原始 `text`;提取器读字符串实参/对象属性/调用结构,不读 regex `.pattern`/`.source`)。若将来要读 regex body,在 `_doScan` 加 regex-literal skip(按前一 significant token 做 regex-vs-division)。当前有依据 defer,代码内已留注释。
   - **已修(P0 codex)**:`forEachExportedConst` 现强制契约(跳过解构 declarator,callback 只见 Identifier);`export { satisfies as X }` 不再被 normalize 误改写。
8. **包级 nit(非本方案引入,出 P0 范围)**:`tsconfig.build.json` 的 `declarationMap`/`sourceMap` 让发布的 `.d.ts.map`/`.js.map` 引用未发布的 `src`(`files:["dist"]`)。全包共性,后续单独清理(给 `files` 加 `src` 或发布时去 map)。

---

## 9. 决策(owner 已定 2026-06-06)

1. **`ExportMeta.steps[]` — 保留并做对**。它在 `metadata.json` 公开产物里(§3.3),属公开字段。AST 版按 §6 / §9.4 的 sdk 规则正确产出;**不删除**(如将来要删,另立 `metadata.json` schema 迁移)。
2. **子路径布局 — helper 走 `@glubean/scanner/ast`**(vscode 直接 import);提取器走主入口 / `@glubean/scanner/static`(API 不变)。`contract-ast` 是否单独子路径在 P2 落地时定(默认并入主)。
3. **vscode `parser.ts` 适配层留在 vscode** —— `each:`/`pick:` 前缀、step 对象→字符串、`(data-driven)`/`(pick)` 名称后缀是 VSCode UI 契约;scanner 只产出中性 `ExportMeta`。
4. **flatten 规则由 sdk 导出纯函数**。`flattenStepsForRegistry`(目前在 sdk `builder.ts` 内部)抽成 sdk 的**导出纯函数**(输入 `StepDefinition[]` 或等价的轻量结构 → 输出扁平叶子 `{name, group?}[]`),scanner `import` 复用**同一份规则定义**,杜绝两处漂移。这给迁移加一个前置子步骤 **P1a**(sdk 导出 flatten)在 P1 之前。运行时 `flattenStepsForRegistry` 改为调用该导出函数(行为不变,有测试锁)。

---

## 10. 验收标准

- `extractor-static.ts` 删除;CLI / MCP / VSCode 全部走 AST 提取(单一来源)。
- scanner 138 + vscode parser.test 不改全过;新增 R2–R20 场景测试全过。
- `codex review` 在本工作线收敛到零 findings。
- 一个真实 dogfood 项目的 `scan` 输出与回退前(baseline)对齐(被消费字段:tests 的 id/name/tags/meta、`ContractStaticMeta`、`PickMeta`),性能无显著回归。
