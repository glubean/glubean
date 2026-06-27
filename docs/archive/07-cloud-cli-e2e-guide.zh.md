# Glubean CLI + Cloud E2E 测试指南

更新日期：2026-05-29

## 目标

这套 e2e 用来验证一条真实链路：

1. 在 dogfood 项目里执行 Glubean CLI 测试。
2. CLI 通过 `--upload` 上传 run 结果和 artifacts 到 Cloud。
3. CLI 通过 `--upload-receipt-json` 在本地写出可判定的 upload receipt。
4. Agent 用 Cloud API 验证同一个 `runId` 已经进入 data plane。
5. Agent 用 Chrome 验证 Cloud UI 能看到同一个 run、详情、日志、测试列表和可选 artifacts。

这个测试不需要新 repo。执行项目是 `/Users/peisong/glubean/dogfood`，Cloud 服务来自 `/Users/peisong/glubean/cloud`，CLI 来自当前 OSS repo `/Users/peisong/glubean/glubean`。

## 所有权边界

- CLI 负责本地执行、上传结果、写出 upload receipt。
- Cloud API 负责 run/read-model/test registry/artifact 可读性验证。
- Cloud UI 负责真实用户可见性验证。
- Agent 负责把三段串起来并保存证据；token、id 和浏览器登录状态由 owner 手动配置。

## 前置条件

Cloud 本地服务：

```bash
cd /Users/peisong/glubean/cloud
pnpm dev:server
pnpm dev:app
```

默认端口：

- API server: `https://api.glubean.test` -> `127.0.0.1:4100`
- App: `https://app.glubean.test` -> `127.0.0.1:4001`
- Landing/login: `https://glubean.test` -> `127.0.0.1:4000`
- Console: `https://console.glubean.test` -> `127.0.0.1:4002`，本 e2e 默认不需要

本地默认通过 Caddy 访问 `https://*.glubean.test`。关键是 dogfood、Cloud server、Cloud app 三者的 URL 要一致。

dogfood fixture：

```bash
cd /Users/peisong/glubean/dogfood
node scripts/bootstrap-token.mjs
```

这个脚本会直接写入 dogfood 的 `.env` 和 `.env.secrets`。如果不用脚本，也可以手动填下面的配置清单。

本地 CLI：

```bash
cd /Users/peisong/glubean/glubean
pnpm --filter @glubean/cli build
```

执行 e2e 时建议直接调用本地构建产物，避免 dogfood 里安装的发布版 CLI 还没有 `--upload-receipt-json`：

```bash
node /Users/peisong/glubean/glubean/packages/cli/bin/gb.js --version
```

## 手动配置清单

dogfood `.env`：

```env
CLOUD_API_URL=https://api.glubean.test
GLUBEAN_API_URL=https://api.glubean.test
PROJECT_ID=proj_...
GLUBEAN_PROJECT_ID=proj_...
TEAM_ID=team_...
USER_ID=usr_...
```

dogfood `.env.secrets`：

```env
PROJECT_TOKEN=gpt_...
GLUBEAN_TOKEN=gpt_...
API_KEY=gb_...
```

关系约定：

- `PROJECT_ID` 和 `GLUBEAN_PROJECT_ID` 通常是同一个 project。
- `PROJECT_TOKEN` 和 `GLUBEAN_TOKEN` 通常是同一个 project token。
- `PROJECT_TOKEN` / `GLUBEAN_TOKEN` 用于 CLI upload 和 open ingest，要求 `runs:write`。
- `API_KEY` 是 personal API key，用于 API readback 和管理面读操作。
- 如果 agent 需要用 `POST /auth/token-login` 进入 Cloud UI，这个 `API_KEY` 必须带 `automation:login` scope。`dogfood/scripts/bootstrap-token.mjs` 会为 bootstrap key 写入该 scope。

Cloud app `.env`，如果需要手动配置：

```env
VITE_API_URL=https://api.glubean.test
VITE_LOGIN_URL=https://glubean.test
VITE_CONSOLE_URL=https://console.glubean.test
```

Cloud server `.env`，本 e2e 依赖的最小项：

```env
MONGODB_URI=mongodb://localhost:27017/glubean
PORT=4100
FRONTEND_APP_URL=https://app.glubean.test
CORS_ALLOWED_ORIGINS=https://glubean.test,https://app.glubean.test,https://console.glubean.test
CORS_ALLOWED_ORIGIN_REGEX=^https?://([a-z0-9-]+\.)?glubean\.test(:\d+)?$
SESSION_SECRET=<local-dev-secret>
JWT_SECRET=<local-dev-secret>
```

如果使用 OAuth 登录 Cloud UI，还需要配置对应的 `GOOGLE_*` 或 `GITHUB_*` OAuth 变量。Agent 不应读取或保存这些 secret，只验证变量是否存在。

Chrome/UX：

- Owner 需要在 Chrome 里登录 Cloud app，或者提供一个已经登录的本地开发会话。
- Agent 只使用浏览器会话验证 UI，不负责创建 OAuth app 或处理真实账号 secret。

## Agent 执行流程

### 1. 环境健康检查

```bash
cd /Users/peisong/glubean/dogfood
set -a
. ./.env
. ./.env.secrets
set +a

curl -fsS "$CLOUD_API_URL/health"
curl -fsS -H "Authorization: Bearer $PROJECT_TOKEN" "$CLOUD_API_URL/open/v1/whoami"
curl -fsS -H "Authorization: Bearer $API_KEY" "$CLOUD_API_URL/open/v1/whoami"
```

必须确认：

- API server 可访问。
- project token 可用于 open ingest 身份。
- personal API key 可用于 readback 身份。

### 2. CLI 真实执行并上传

```bash
cd /Users/peisong/glubean/dogfood
mkdir -p .glubean/e2e
node /Users/peisong/glubean/glubean/packages/cli/bin/gb.js run \
  --config ci-config/default.yaml \
  --upload \
  --upload-receipt-json .glubean/e2e/upload-receipt.json
```

验收 upload receipt：

```bash
node -e '
const fs = require("fs");
const receipt = JSON.parse(fs.readFileSync(".glubean/e2e/upload-receipt.json", "utf8"));
if (receipt.schemaVersion !== "glubean.upload-receipt.v1") throw new Error("bad schemaVersion");
if (receipt.resultUpload.status !== "uploaded") throw new Error(JSON.stringify(receipt.resultUpload));
if (!receipt.runId || !receipt.url) throw new Error("missing runId/url");
console.log(JSON.stringify({ runId: receipt.runId, url: receipt.url, artifactUpload: receipt.artifactUpload }, null, 2));
'
```

这个 `runId` 是后续 API 和 UX 验证的唯一锚点。不要用“最新一条 run”代替。

### 3. Cloud API readback

```bash
cd /Users/peisong/glubean/dogfood
RUN_ID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(".glubean/e2e/upload-receipt.json", "utf8")).runId)')
set -a
. ./.env
. ./.env.secrets
set +a
PROJECT_ID="${PROJECT_ID:-$GLUBEAN_PROJECT_ID}"

curl -fsS -H "Authorization: Bearer $API_KEY" \
  "$CLOUD_API_URL/data-plane/runs/$RUN_ID" > .glubean/e2e/api-run.json

curl -fsS -H "Authorization: Bearer $API_KEY" \
  "$CLOUD_API_URL/data-plane/runs/$RUN_ID/report" > .glubean/e2e/api-report.json

curl -fsS -H "Authorization: Bearer $API_KEY" \
  "$CLOUD_API_URL/data-plane/runs/$RUN_ID/events?limit=20" > .glubean/e2e/api-events.json

curl -fsS -H "Authorization: Bearer $API_KEY" \
  "$CLOUD_API_URL/data-plane/tests?projectId=$PROJECT_ID&limit=20" > .glubean/e2e/api-tests.json
```

必须断言：

- `api-run.json.runId === upload-receipt.json.runId`
- `api-run.json.projectId === PROJECT_ID`
- `api-report.json.tests.length > 0`
- `api-events.json.events.length > 0`，除非 run 本身没有事件写入
- `api-tests.json.tests` 至少包含本次 run 的 test ids

如果 `upload-receipt.json.artifactUpload.status === "uploaded"`，还要验证：

```bash
curl -fsS -H "Authorization: Bearer $API_KEY" \
  "$CLOUD_API_URL/open/v1/cli-runs/$RUN_ID/artifacts" > .glubean/e2e/api-artifacts.json
```

### 4. Cloud UI / Chrome 验证

Chrome 验证必须使用上一步的 `RUN_ID`。

推荐打开：

- `${CLOUD_APP_URL}/projects/${PROJECT_ID}/runs`
- `${CLOUD_APP_URL}/projects/${PROJECT_ID}/runs/${RUN_ID}`
- `${CLOUD_APP_URL}/projects/${PROJECT_ID}/tests`
- `${CLOUD_APP_URL}/projects/${PROJECT_ID}/analytics`

必须确认：

- runs list 有本次 `RUN_ID` 或能点击进入同一条 run。
- run detail 显示 status、summary、test results。
- logs/events tab 能显示事件。
- tests page 能看到本次上传注册或更新过的 tests。
- 如果 artifacts 上传成功，run detail 能看到 artifacts 区域或 API 至少能列出 artifacts。

Agent 应保存截图到 `.glubean/e2e/screenshots/`，并在最终报告里列出截图路径。

### 5. 最终 e2e 报告

Agent 的最终报告至少包含：

```json
{
  "ok": true,
  "runId": "run_...",
  "projectId": "proj_...",
  "receiptPath": ".glubean/e2e/upload-receipt.json",
  "apiEvidence": {
    "run": ".glubean/e2e/api-run.json",
    "report": ".glubean/e2e/api-report.json",
    "events": ".glubean/e2e/api-events.json",
    "tests": ".glubean/e2e/api-tests.json"
  },
  "uxEvidence": {
    "screenshots": [
      ".glubean/e2e/screenshots/runs-list.png",
      ".glubean/e2e/screenshots/run-detail.png"
    ]
  }
}
```

如果失败，报告要指出失败层级：

- `cli_execution_failed`
- `upload_failed`
- `api_readback_failed`
- `ux_not_visible`
- `auth_or_config_missing`

## 不应做的事

- 不要创建新的 e2e repo。
- 不要把 token 或 OAuth secret 写入本指南、提交信息、截图或最终报告。
- 不要只用 terminal “uploaded” 日志作为成功判定。
- 不要用 UI 最新 run 替代 receipt 里的 `runId`。
- 不要在没有 owner 明确允许的情况下重置 dogfood 数据库或删除项目。
