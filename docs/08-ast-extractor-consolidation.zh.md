# 08 · AST 提取器统一方案(用 @babel/parser 100% 替代正则静态扫描)

> 选型更新 2026-06-06:初稿定 acorn + acorn-typescript,后因其停更 2.5 年/不支持 `satisfies` 改用 **`@babel/parser`**(见 §2)。下文 acorn 相关段落多为背景/历史,实现以 §2 为准。

状态:**scanner 侧完成(P0–P2+P1-pick+P4)+ 合约检测放宽(opt-in)+ 已发布 `@glubean/scanner@0.5.2`**(159 + cli 291 + mcp 31 全绿,各阶段 codex 零)。owner 已决策**放宽**:`extractContractCases(content, { broad: true })` 鸭子类型认任意 `<factory>("id",{cases})`(`.with()` scoped + 自定义 `*Api` 工厂),供 **VSCode 发现**用;**默认仍窄口径**(`contract.<protocol>`),保住 CLI/scanner 的"对 scoped/custom 形式 fail-closed"既定纪律(graphql README/RFR 背书)。**P3 vscode 落地(改用 `{broad:true}` + 去 marker + 删自有 ast/contractAst + 迁移 vscode 测试)仍待做**(跨仓 + vscode 测试需按新行为迁移),详见 §12。vscode 当前在工作态(99 测试全绿,scanner 0.3.0)。
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

## 2. Parser 选型(已定:`@babel/parser`)

**`@babel/parser`**(纯 JS)。

| 维度 | 结论 |
|---|---|
| TS 覆盖 | **全且现役**:`satisfies` / `const` 类型参数 / 装饰器 / `.ts` 角括号断言 `<Foo>bar` / import attributes(`with {}`)/ `using` —— 全部原生解析,**无需任何源码预处理 hack** |
| 形态 | **纯 JS,无原生二进制** → Node/Deno/Bun/各 CI arch 都稳(对 published `@glubean/scanner` 关键) |
| 体积 | ~2–3MB(比 `typescript` ~23MB 小 ~10×) |
| 维护 | **活跃**(月级发布,~1.8 亿/wk);AST = `StringLiteral`/`ObjectProperty` + `TSAsExpression`/`TSSatisfiesExpression` 等 |
| 可换性 | 薄封装(`ast.ts`)隔离,换 parser 只改一个文件 |

**选型修正记录(2026-06-06)**:初稿选了 acorn + acorn-typescript(因 vscode 在用 + 体积 ~600KB)。实测发现 **acorn-typescript 自 2024-01 起停更(~2.5 年)、周下载仅 38 万、解析不了 `satisfies`/`const T`** —— 它逼出一个脆弱的 `normalizeSatisfies` 字符 hack,P0 codex 连开多轮都在补这个 hack 的边缘(`satisfies` 作标识符在各位置被改坏)。一个停更、跟不上 TS 演进的 parser,用来扫**任意用户 TS** 是长期负债。改用 `@babel/parser`:hack 整个删除,角括号/const-T 限制消失,且未来 TS 新语法跟得上。

被否方案:`typescript` 裸用(~23MB + AST 啰嗦)、`@typescript-eslint/typescript-estree`(改动最省但内部拉 typescript ~23MB)、`oxc-parser` / `@swc/core`(原生二进制,published 库的 Deno/冷门 arch/edge 风险;扫几百个小文件不需要这速度)、`acorn` 裸用 / `espree`(TS 不全)、~~acorn-typescript~~(停更)。

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
ast.ts              ← 新增:@babel/parser 薄封装 + helper 工具箱(API 沿用 vscode/src/ast.ts,内部改写到 babel;无 satisfies hack)
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

`@glubean/scanner/package.json`:`dependencies` 由 `{}` 增加 `@babel/parser`(~2–3MB,纯 JS,无原生二进制)。这是 scanner 第一个运行时依赖。`ast.ts` 自带 `walk`,不需 `@babel/traverse`/`@babel/types`。

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

- **P0 — 落地 parser 与 helper**:scanner 加 `@babel/parser` 依赖;新增 `ast.ts`(babel 薄封装 + helper,API 沿用 vscode)+ 单测。新增 `@glubean/scanner/ast` 子路径。**不改任何提取行为**(extractor-static.ts 原样保留),纯加基础设施 → 低风险。
- ~~**P1a — sdk 导出 flatten**~~:**取消**(§9.4 修正)——会违反 scanner 的零-sdk-依赖原则;flatten 留 scanner 本地。
- **P1 — test 路径 AST 化**:实现 `extractor-ast.ts` 的 `extractFromSource` / `extractAliasesFromSource` / `isGlubeanFile` / `createStaticExtractor` / `extractPickExamples`(`steps[]` 用 scanner 本地 flatten,镜像 sdk 规则 + 测试锁);`static.ts` 切到它;**现有 138 测试不改全过** + 新增"正则做不到"的用例(§5.3 + 现代 TS 语法)。`extractFromSource` 必须 try/catch `parseSource`(§8.7:不可解析 → 跳过 + warn,绝不 crash)。
- **P2 — contract 路径 AST 化**:移入 `contract-ast.ts`,实现 AST 版 `extractContractCases`;scanner Phase 4 conformance(`ContractStaticMeta` 输出对齐;有真实差异则显式列出 + 测试)。
- **P4 — 删除正则**(✅ 已完成,在 P3 之前做):正则提取函数全删,`extractor-static.ts` 瘦成 guards+types(1130→280)。AST 是 scanner 唯一提取路径。
- **P3 — consolidate vscode**(⏳ 未做,跨仓 + 需发版):见 §12 执行手册。

**P0–P2+P1-pick+P4 已完成**(scanner 侧 100% 替代正则,scanner 151 + cli 291 + mcp 31 全绿,各阶段 codex 零)。P3 是跨仓 + 发版门控的独立后续。

---

## 8. 风险与缓解

1. **parser 维护 / 新语法**:`@babel/parser` 活跃维护、跟得上 TS;薄封装(`ast.ts`)隔离,换 parser 改一处。锁主版本 + 测试覆盖现实 TS。
2. **输出漂移**:既有 conformance 测试(scanner 138 + vscode parser.test)不改全过为硬底线;`ContractStaticMeta`/`PickMeta` 这类被消费的输出做 golden 快照。
3. **性能**:AST parse 比正则重,但 parse-only(不建 Program、不读 tsconfig、不碰 FS),量级是几百个小文件;P1 后跑一次基准(scan 一个真实 dogfood 项目)对比,设回归阈值。必要时按 `isGlubeanFile` 先门控再 parse。
4. **跨仓版本耦合**(P3):scanner 是已发布包,vscode 依赖它。发版走 repo 的**协调发布**:`.github/workflows/publish.yml` 由 `v*` tag 触发(workflow 内部用 `pnpm publish` 自动把 `workspace:*` 转真实版本),**不是本地手动 `pnpm publish`**。P3 需要 scanner 新版时,流程是:bump 版本 → commit → 打 `v*` tag → push(让 CI 发布),再升 vscode 依赖;P3 之前 vscode 维持现状,不阻塞 P1/P2。
5. **体积**:`@babel/parser` ~2–3MB 到 scanner 运行时依赖(CLI/MCP +~2–3MB,远小于 typescript ~23MB)。P3 后 vscode 把自有 acorn(~600KB)换成共享 babel → bundle 约 +1.5–2MB,换来"现役维护 + 全 TS + 单一来源",可接受。
6. **原生二进制**:无(纯 JS)。
7. **`ast.ts` 解析能力(@babel/parser)**:`satisfies` / `const` 类型参数 / 装饰器 / `.ts` 角括号断言 `<Foo>bar` / import attributes / `using` **全部原生解析**——acorn-typescript 时代的那一整类限制(以及 `normalizeSatisfies` 字符 hack)**全部消失**。残留:`parseSource` 仍可能在**真正非法的 TS** 或极冷门、未启用 babel plugin 的语法上抛错 → **P1 的 `extractFromSource` 仍须 try/catch 当"不可解析 → 跳过 + warn"**(现正则 extractor 从不抛,这是 P1 新增 crash 面,无论如何要兜)。已加测试锁定 satisfies/角括号/const-T/装饰器/import-attrs/using 都解析通过。
   - **helper 契约(P0 codex 修)**:`forEachExportedConst` 跳过解构(callback 只见 Identifier);`hasLeadingMarker` 能跨过夹在 marker 与节点间的其它注释、且拒绝把上一句**行尾注释**当本节点 leading marker(P2 marker 依赖)。
8. **包级 nit(非本方案引入,出 P0 范围)**:`tsconfig.build.json` 的 `declarationMap`/`sourceMap` 让发布的 `.d.ts.map`/`.js.map` 引用未发布的 `src`(`files:["dist"]`)。全包共性,后续单独清理。

---

## 9. 决策(owner 已定 2026-06-06)

1. **`ExportMeta.steps[]` — 保留并做对**。它在 `metadata.json` 公开产物里(§3.3),属公开字段。AST 版按 §6 / §9.4 的 sdk 规则正确产出;**不删除**(如将来要删,另立 `metadata.json` schema 迁移)。
2. **子路径布局 — helper 走 `@glubean/scanner/ast`**(vscode 直接 import);提取器走主入口 / `@glubean/scanner/static`(API 不变)。`contract-ast` 是否单独子路径在 P2 落地时定(默认并入主)。
3. **vscode `parser.ts` 适配层留在 vscode** —— `each:`/`pick:` 前缀、step 对象→字符串、`(data-driven)`/`(pick)` 名称后缀是 VSCode UI 契约;scanner 只产出中性 `ExportMeta`。
4. **flatten 规则留在 scanner 本地(修正:不走 sdk 导出)**。原计划让 sdk 导出 `flattenStepsForRegistry`、scanner import 复用,但实测发现 **scanner 刻意"零 @glubean/sdk 依赖、全鸭子类型"**(`contract-extraction.ts:5` 明文原则)。为一个 8 行规则给 scanner 引入 sdk 运行时依赖、且二者输入不同(sdk 是 `StepDefinition[]`,scanner 是 AST),不划算且违反原则。**改为**:scanner 在 P1 自持一份 ~8 行 flatten(镜像 sdk `flattenStepsForRegistry`:递归 branch `cases[].steps` + `default`、传播 `group`、叶子产 `{name, group?}`),用测试锁定预期输出。漂移风险低(规则稳定;`steps[]` 是 best-effort、无代码消费者)。**P1a 取消**。
5. **去掉 `// @contract` / `// @flow` magic-comment marker(P2/P3)**。AST 已能**结构化识别** contract/flow:`readContractCall` 鸭子类型 `export const X = <factory>("id", { …cases… })`(认带 `cases` 的对象,`contract.http/grpc/graphql`/自定义 factory 通吃),flow 认 `.flow("id")`。marker 现在只是 **vscode 独有的 opt-in 门**,且与 CLI/MCP(动态 import 发现**所有** contract/flow,从不看 marker)、scanner 静态正则(也不看)**不一致**——没标记的 contract `glubean run` 照跑、vscode 测试树却不显示。consolidate 时去掉强制 marker,vscode 改纯结构化识别 → **与 CLI 对齐**,用户少写 magic 注释。**行为变化(owner 已认可方向)**:vscode 将自动发现所有 contract/flow 导出(本就是 CLI 的行为)。`hasLeadingMarker` helper 若无其它用途可一并清理(`contract.bootstrap` 是结构识别,不依赖注释)。
6. **CodeLens 是一等消费者,不得破坏(贯穿 P1/P2/P3)**。vscode 在每个 test/contract/flow 上方渲染 Run/Debug lens、并对 `test.pick` 的**每个 example key** 渲染独立运行 lens。它消费:① `extractPickExamples` → `PickMeta`(`keys` / `line` / 8 种 `dataSource` + 路径解析,见 §5.2-4)——P1 必须 AST 化且保持该形状;② 各 test/contract/flow 导出的**精确 1-based 行号**(放置 lens 的锚点)——AST `lineOf` 提供,比正则更准。**去 marker(§9.5)不影响 CodeLens**:lens 靠"结构识别 + 行号"定位,两者 AST 都给,且去 marker 后 lens 覆盖**所有** contract/flow(更全)。conformance:vscode `codeLensProvider.ts` / `diagnose.ts` / `parser.test.ts` 对 `PickMeta` + 行号的断言必须不改全过(纳入 §5 硬底线)。

---

## 10. 验收标准

- **正则提取函数删除**(`extractFromSource`/`extractContractCases`/`extractPickExamples`/`createStaticExtractor` + 私有 helper);`extractor-static.ts` 瘦身为 **guards + types**(`isGlubeanFile`/`extractAliasesFromSource` 仍正则——§9.x perf 决策——加 `PickMeta`/`Contract*StaticMeta` 类型),1130→280 行。CLI / MCP 经公开 API(`@glubean/scanner/static`,已 AST-backed)自动走 AST。**P0–P2+P1-pick+P4 done。**
- VSCode 走 AST 属 **P3**(跨仓 `/Users/peisong/glubean/vscode` + 需 scanner 发版 `v*` tag);独立后续,不阻塞已完成部分。
- scanner conformance(test/contract/pick 90+ 用例)repoint 到 AST 后**不改全过** + 现代 TS 用例全过(151 绿);vscode parser.test 在 P3 落地。
- `codex review` 在本工作线收敛到零 findings(P0–P4 各阶段已达成)。
- 一个真实 dogfood 项目的 `scan` 输出与回退前(baseline)对齐(被消费字段:tests 的 id/name/tags/meta、`ContractStaticMeta`、`PickMeta`),性能无显著回归。

---

## 11. 未来能力:静态(零执行)投影 —— 本迁移解锁的 payoff

本迁移本身只"AST 替换正则"(不改投影行为)。但它**铺好了静态投影的地基**:

- **现状两条路**:运行时投影(动态 `import()` 执行用户代码 → 完整 `NormalizedFlowMeta`,**权威但要执行**);静态(旧正则)只能凑 id/name/tags + 扁平 `.step`,**没有结构**。
- **AST 解锁**:从源码、**不执行**地抽出**结构**——`.step`/`.poll`/`.group`/`.condition`/`switchOn`/`switchCond` 的嵌套 + case/default 分支、contract case 明细、控制流形状。→ no-exec、快、安全的投影:VSCode 测试树展开嵌套结构、CodeLens 标注分支/轮询、coverage/可视化不跑就能画。
- **边界**:AST 只看语法,看不到运行时值;运行时计算的 id/schema、循环/spread 生成的 cases 投影不了(这正是 contract/flow 走动态 import 的原因)。定位:**静态投影 = 快/安全的"大多数情况";运行时投影仍是动态部分的权威 fallback**,二者互补。
- **落点**:届时 `ExportMeta.steps[]`(目前"只写不读")可升级成真正的结构化静态投影,第一个真实消费者是 VSCode 结构展示 / 可视化。**这是建立在本迁移之上的独立 feature,不在 P0–P4 范围**。

---

## 12. P3 执行手册(consolidate vscode + 去 marker)—— 尝试后回退,卡在一个 owner 决策

> 背景:vscode 仓在 `/Users/peisong/glubean/vscode`,**不是**本 monorepo 的 workspace 成员,通过**已发布的 npm `@glubean/scanner`**(现 `^0.3.0`)依赖。它已把 test/pick 提取委托给 `@glubean/scanner/static`,只有 contract/flow 还在自有 `contractAst.ts`(acorn)。

### 🚧 阻塞:scanner 窄口径 vs vscode 宽口径合约检测(需 owner 拍板)

P3 在本 session 实做过一遍(vscode 升 0.5.1、删自有 ast.ts、contractAst 改指 `@glubean/scanner/ast`、contract/flow 改 scanner 结构提取、去 `@contract`/`@flow` marker),`tsc` 通过,但 **vscode 测试暴露真实回退**,已**全部回退**(vscode 恢复 0.3.0 + 99 测试全绿)。根因:

- **vscode `readContractCall` 是宽口径鸭子类型**:任意 `<factory>("id", { …cases… })` 都认——`contract.http(...)`、`contract.http.with(defaults)(...)`(scoped 实例)、自定义工厂 `stableApi(...)`/`orderApi(...)`/`graphqlApi(...)`。**cookbook/demo 实际大量用**(`.with(` 遍布 dummyjson/attachment-model/notifications;自定义 *Api 工厂多处)。
- **scanner `extractContractCases` 是窄口径**:忠于旧正则,只认字面 `contract.<protocol>(...)`。
- 直接让 vscode 用 scanner 的窄提取 → **漏掉所有 `.with()`/自定义工厂合约**,vscode 测试树合约发现回退。

**决策点(owner)**:是否把 scanner 静态合约检测**放宽到鸭子类型**(任意 `<factory>(string, {cases})`)?牵涉:① CLI/MCP 静态 fallback 会发现更多合约(其实更贴近 runtime import 路径,算对齐);② 自定义工厂**没有字面 `protocol`**(`ContractStaticMeta.protocol` 会缺,CLI buildMetadata 消费它);③ 与此前 codex 提的 "拒绝 computed-protocol" 冲突(宽口径不看 callee 名)。这几条要一起定。

### 决策后的执行步骤(scanner 前置已就绪:0.5.1 含 `/ast` + AST 提取器 + `extractFlows`(string|FlowMeta 两重载)+ 案例级 `deprecated`)

- **若 owner 选"放宽"**:在 scanner 加一个宽口径合约提取(或给 `extractContractCases` 加 `{ broad?: true }` 档,见 [[project_contract_progressive_strictness]] 渐进严格度思路),补 conformance + codex;发 0.6.0;再做下面 vscode 步骤。
- **若 owner 选"保持窄口径"**:vscode 的 contract 提取**不 consolidate**(保留自有 `contractAst`),P3 缩小为"仅 test/pick/flow + ast.ts helper consolidate"。

vscode 步骤(去 marker + 改结构,§9.5):
1. 升依赖到发布版;`extractMarkedContracts`→scanner 合约提取、`extractMarkedFlows`→scanner `extractFlows`;删 `@contract`/`@flow` 强制。
2. 删 vscode 自有 `src/ast.ts`;`contractAst`(保留 bootstrap/import/findContractId)+ `dataDrivenRows` 改 `import ... from "@glubean/scanner/ast"`。**注意 babel 节点形状**:vscode `readCases` 用 `"Property"`、`findImportPath` 用 `"Literal"`,babel 是 `"ObjectProperty"`/`"StringLiteral"`——迁移时必须改(否则 readCases 静默返回空)。`dataDrivenRows` 已验证只用共享节点名(安全)。
3. **vscode 测试需迁移**(本 session 实测会红):marker-required 用例、acorn-shape 用例、"nested generic 丢 dataSource(已知限制)"等都编码了旧行为——按新结构/babel 行为改断言。
4. **保 CodeLens(§9.6 硬底线)** + vscode `parser.test.ts` 全过 + vscode 仓 `codex review` 收敛到零。

### 验收
- contract/flow/test/pick 全经 `@glubean/scanner`(单一来源);vscode 自有 ast/contractAst marker 部分删除;CodeLens 行为不变或更全;vscode 测试 + codex 全绿。
