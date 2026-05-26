# API_STREAM_SPEC.md

## 1. 目的

定义简历生成 SSE 流式协议，作为前后端实现与联调依据。

## 2. Endpoint

- `GET /resume/generate/stream`

请求参数（query）：

- `profile: string`（必填，JSON 字符串）
- `targetJob: string`（必填，JSON 字符串）
- `tone: string`（如 concise / professional）
- `language: string`（如 zh-CN / en-US）
- `variants: number`（默认 1，最大 3）

Header：

- `Authorization: Bearer <token>`

## 3. 事件协议（定稿 v1）

### 3.1 `start`

- 含义：任务已开始，流会话已建立。
- data:
  - `requestId: string` 全链路请求 ID
  - `taskId: string` 任务 ID
  - `variantCount: number` 目标生成版本数
  - `startedAt: string` ISO 时间
  - `status: "running"`

### 3.2 `chunk`

- 含义：增量简历片段。
- data:
  - `requestId: string`
  - `taskId: string`
  - `variantIndex: number` 从 1 开始
  - `field: "summary" | "experience" | "projects" | "skills"`
  - `text: string` 当前增量文本
  - `timestamp: string` ISO 时间

### 3.3 `progress`

- 含义：任务进度更新（用于前端进度条/状态文案）。
- data:
  - `requestId: string`
  - `taskId: string`
  - `progress: number` 0-100
  - `stage: string` 例如 `planning | generating | post_processing`
  - `timestamp: string` ISO 时间

### 3.4 `done`

- 含义：生成成功结束。
- data:
  - `requestId: string`
  - `taskId: string`
  - `variantCount: number` 实际生成版本数
  - `finishedAt: string` ISO 时间
  - `status: "succeeded"`

### 3.5 `error`

- 含义：任务失败结束。
- data:
  - `requestId: string`
  - `taskId: string`
  - `code: string` 例如 `LLM_TIMEOUT | RATE_LIMITED | INTERNAL_ERROR`
  - `message: string`
  - `timestamp: string` ISO 时间
  - `status: "failed"`

### 3.6 `canceled`

- 含义：任务被用户或系统取消。
- data:
  - `requestId: string`
  - `taskId: string`
  - `reason: string` 例如 `USER_ABORT`
  - `timestamp: string` ISO 时间
  - `status: "canceled"`

## 4. 协议规则

- 正常顺序：`start -> (progress|chunk)* -> done`
- 异常顺序：`start -> (progress|chunk)* -> error`
- 取消顺序：`start -> (progress|chunk)* -> canceled`
- `requestId`、`taskId` 在同一次流式会话中必须一致。
- 终态事件（`done`/`error`/`canceled`）发送后必须主动关闭连接。
- 首版不支持 `Last-Event-ID` 恢复

## 5. 任务状态流转点设计

基础状态：

- `pending`：任务已创建，未进入生成执行。
- `running`：已发送 `start`，开始生成。
- `succeeded`：发送 `done` 后进入终态。
- `failed`：发送 `error` 后进入终态。
- `canceled`：发送 `canceled` 后进入终态。

关键流转点：

1. 开始：`pending -> running`
- 触发点：SSE 会话建立成功并发送 `start`。

2. 完成：`running -> succeeded`
- 触发点：成功发送 `done`，并落库 `finishedAt`。

3. 失败：`running -> failed`
- 触发点：模型调用/解析/持久化异常，发送 `error`，并记录 `errorCode/errorMessage`。

4. 取消：`running -> canceled`
- 触发点：用户主动取消或连接中断触发取消策略，发送 `canceled`。

说明：

- 当前可先复用 `pending|running|succeeded|failed` 状态模型；若暂未扩展枚举，可先将取消态映射为 `failed + errorCode="CANCELED"`，待 schema 升级后再切为独立 `canceled` 状态。

## 6. 前端处理要求

- 接到 `start`：初始化会话状态（loading、进度 0、清空旧内容）。
- 接到 `chunk` 立即增量渲染
- 接到 `progress` 更新进度 UI
- 接到 `done` 切换完成态并触发结果拉取
- 接到 `error` 展示错误提示并允许重试
- 接到 `canceled` 切换“已取消”态并保留重试入口
- 连接异常时展示“连接中断”状态

## 7. 当前实现对齐说明（2026-05-25）

- `apps/api/src/resume/resume.service.ts` 已实现完整事件集合：
  - `start`
  - `chunk`
  - `progress`
  - `done`
  - `error`
  - `canceled`
- 当前 `resume/generate/stream` 使用 `ResumeAiService.generateWithStream()` 进行 mock 流式分片，满足前端联调与事件时序验证。
