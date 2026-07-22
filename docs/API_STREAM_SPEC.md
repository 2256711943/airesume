# API_STREAM_SPEC.md

## 1. 目的

定义项目中所有 SSE 流式接口协议，包括聊天流和简历生成流，作为前后端实现与联调依据。

## 2. Endpoints

### 2.1 聊天流

- **`POST /chat/message/stream`**
- Content-Type: `application/json`
- Accept: `text/event-stream`
- Header: `Authorization: Bearer <token>`

请求体：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `conversationId` | `string` | 否 | 已有会话 ID，不传则新建 |
| `message` | `string` | 是 | 用户消息内容 |
| `title` | `string` | 否 | 新建会话时的标题 |
| `historyLimit` | `number` | 否 | 历史消息返回条数 |
| `streamKey` | `string` | 否 | 断线恢复用，同一次会话须保持一致 |
| `sinceSeq` | `number` | 否 | 断线恢复用，客户端最后消费的 seq，默认 0 |

### 2.2 简历生成流

- **`GET /resume/generate/stream`**
- Accept: `text/event-stream`
- Header: `Authorization: Bearer <token>`

请求参数（query）：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `profile` | `string` | 是 | JSON 字符串，个人信息 |
| `targetJob` | `string` | 是 | JSON 字符串，目标岗位 |
| `tone` | `string` | 否 | 风格，默认 `professional` |
| `language` | `string` | 否 | 语言，默认 `zh-CN` |
| `variants` | `number` | 否 | 生成版本数，1-3，默认 1 |
| `streamKey` | `string` | 否 | 断线恢复用，同一次任务须保持一致 |
| `sinceSeq` | `number` | 否 | 断线恢复用，客户端最后消费的 seq，默认 0 |

## 3. SSE Envelope 协议（统一信封）

所有事件均包裹在统一信封中传输。每条 SSE 消息的 `data` 字段为 JSON，结构如下：

```json
{
  "id": "run-abc:3",
  "seq": 3,
  "runId": "run-abc",
  "spanId": "span-xyz",
  "type": "assistant_chunk",
  "ts": "2026-07-22T10:30:00.000Z",
  "payload": { ... }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 全局唯一事件 ID，格式 `{runId}:{seq}` |
| `seq` | `number` | 单调递增序号，用于去重和断线恢复 |
| `runId` | `string` | 一次 Agent 执行的会话 ID |
| `spanId` | `string?` | 当前执行片段 ID |
| `type` | `string` | 事件类型（见各流的事件表） |
| `ts` | `string` | 服务端时间戳（ISO 8601） |
| `payload` | `object` | 事件具体内容，与 `type` 对应 |

终端事件（`done` / `error` / `canceled`）发送后连接关闭。

## 4. 聊天流事件

事件类型：`ChatStreamEventType`

```typescript
type ChatStreamEventType =
  | 'start'
  | 'route_decision'
  | 'tool_start'
  | 'tool_done'
  | 'assistant_chunk'
  | 'assistant_done'
  | 'done'
  | 'error';
```

### 4.1 `start`

- 含义：流会话已建立，Agent 开始处理。
- payload:
  - `requestId: string`
  - `routeDecisionStarted: boolean`

### 4.2 `route_decision`

- 含义：编排器已完成意图识别和 Agent 选择。
- payload:
  - `routeDecision: ChatRouteDecision`

### 4.3 `tool_start`

- 含义：Agent 开始调用工具。
- payload:
  - `agentRunId: string`
  - `toolName: string`
  - `startedAt: string` ISO 时间

### 4.4 `tool_done`

- 含义：工具调用完成。
- payload:
  - `agentRunId: string`
  - `toolName: string`
  - `success: boolean`
  - `latencyMs: number`
  - `errorCode?: string`
  - `errorMessage?: string`

### 4.5 `assistant_chunk`

- 含义：增量文本片段（按 ~80 字符分片）。
- payload:
  - `text: string`

### 4.6 `assistant_done`

- 含义：助手文本生成完毕。
- payload:
  - `content: string` 完整回复文本
  - `routeDecision: ChatRouteDecision`
  - `toolCalls: ChatToolCallSummary[]`

### 4.7 `done`

- 含义：整次聊天流处理成功结束（终态）。
- payload:
  - `requestId: string`
  - `conversationId: string`
  - `agentRunId: string`
  - `createdConversation: boolean`
  - `routeDecision: ChatRouteDecision`

### 4.8 `error`

- 含义：聊天流失败（终态）。
- payload:
  - `requestId: string`
  - `code: string`
  - `message: string`

### 聊天流时序

```
正常：start -> route_decision -> tool_start -> tool_done -> assistant_chunk* -> assistant_done -> done
失败：start -> route_decision -> (tool_start -> tool_done)? -> error
取消：由 AbortController 触发，状态机进入 canceled
```

## 5. 简历生成流事件

事件类型：`ResumeSseEventType`

```typescript
type ResumeSseEventType = 'start' | 'chunk' | 'progress' | 'done' | 'error' | 'canceled';
```

### 5.1 `start`

- 含义：任务已开始，流会话已建立。
- payload:
  - `requestId: string`
  - `taskId: string`
  - `variantCount: number` 目标生成版本数
  - `startedAt: string` ISO 时间
  - `status: "running"`

### 5.2 `chunk`

- 含义：增量简历文本片段。
- payload:
  - `requestId: string`
  - `taskId: string`
  - `variantIndex: number` 从 1 开始
  - `field: string` 当前字段名
  - `text: string` 当前增量文本
  - `timestamp: string` ISO 时间

### 5.3 `progress`

- 含义：任务进度更新（用于前端进度条/状态文案）。
- payload:
  - `requestId: string`
  - `taskId: string`
  - `progress: number` 0-100
  - `stage: string` 如 `planning | generating | post_processing`
  - `timestamp: string` ISO 时间

### 5.4 `done`

- 含义：生成成功结束（终态）。
- payload:
  - `requestId: string`
  - `taskId: string`
  - `variantCount: number` 实际生成版本数
  - `variants: ResumeVariant[]` 生成结果
  - `finishedAt: string` ISO 时间
  - `status: "succeeded"`

### 5.5 `error`

- 含义：任务失败（终态）。
- payload:
  - `requestId: string`
  - `taskId: string`
  - `code: string` 如 `INTERNAL_ERROR`
  - `message: string`
  - `timestamp: string` ISO 时间
  - `status: "failed"`

### 5.6 `canceled`

- 含义：任务被用户或系统取消（终态）。
- payload:
  - `requestId: string`
  - `taskId: string`
  - `reason: string` 如 `USER_ABORT`
  - `timestamp: string` ISO 时间
  - `status: "canceled"`

### 简历生成流时序

```
正常：start -> progress -> chunk* -> progress -> done
失败：start -> (progress|chunk)* -> error
取消：start -> (progress|chunk)* -> canceled
```

## 6. 断线恢复协议

### 6.1 核心机制

- 客户端记录最后消费的 `seq`（通过 `lastEventSeq` ref 维护）
- 重连时通过 `streamKey` + `sinceSeq` 参数告知服务端"我从哪继续"
- 服务端通过 `ReplayableSseSession` 按 `seq > sinceSeq` 回放缓存事件

### 6.2 恢复流程

```
1. 记录最后消费的 seq
2. 关闭旧连接，状态机进入 retrying
3. 使用相同的 streamKey + sinceSeq 重新请求
4. 服务端从 replay buffer 补发缺失事件
5. 恢复到 streaming 状态，继续渲染
```

### 6.3 服务端 replay buffer

- 实现在 `apps/api/src/common/sse-session.ts`
- `ReplayableSseSession`: 内存事件缓冲，支持按 `sinceSeq` 增量回放
- `ReplayableSseSessionStore`: 按 `streamKey` 管理多个会话
- 空闲超时：10s 无订阅者触发 abort（`idleAbortMs`）
- 清理延迟：会话结束后 60s 清理 buffer（`retainMs`）

### 6.4 客户端重连

- 实现在 `apps/web/composables/useSseSupervisor.ts`
- 指数退避：`1000ms -> 2000ms -> 4000ms -> 8000ms -> 16000ms -> 30000ms(max)`
- Full Jitter：实际延迟为 `random(0, cap)`，避免雪崩
- 状态机：`idle -> connecting -> streaming -> done/error/canceled`，支持 `retrying` 和 `paused` 中间态

## 7. 协议规则

### 7.1 事件顺序

- 所有流以 `start` 事件开头
- 终态事件（`done` / `error` / `canceled`）发送后必须主动关闭连接
- `requestId` / `taskId` / `runId` 在同一次流式会话中必须一致
- `seq` 全局单调递增

### 7.2 前后端数据流

```
服务端：
  请求到达 → 创建/复用 ReplayableSseSession
  → SseEnvelopeFactory.create() 生成带 seq 的事件
  → session.emit() 追加到 buffer + 推送给订阅者
  → NestJS @Sse 装饰器写入 SSE Response

客户端：
  fetch() → consumeSseEventEnvelopeStream()
  → 按 seq 去重（seq <= lastSeq 跳过）
  → onEvent 回调 → 渲染引擎 enqueueIngress()
  → rAF 调度 → 打字机渲染
```

### 7.3 去重与幂等

- 客户端 `consumeSseEventEnvelopeStream` 按 `seq` 严格递增过滤
- 服务端 `ReplayableSseSession.subscribe(sinceSeq)` 只回放 `seq > sinceSeq`
- 双重保障确保断网重连后不重复渲染已消费内容

## 8. 前端处理要求

### 8.1 SSE 解析

- 实现在 `apps/web/utils/sse.ts`
- 解析 SSE 帧格式（`event:` + `data:` 行）
- 自动构造 envelope 兼容纯 payload 格式
- 检测到流结束但未收到终态事件时，抛出 `SseStreamDisconnectedError`

### 8.2 渲染引擎

- 实现在 `apps/web/composables/useSseRenderEngine.ts`
- 双缓冲模型：`ingressBuffer` → 转换 → `frameBuffer` → `requestAnimationFrame` 提交
- 打字机策略：按 `charsPerSecond` 控制输出节奏
- 帧预算：单帧处理时间约 8ms

### 8.3 事件处理

- 接到 `start`：初始化会话状态，清空旧内容
- 接到 `chunk` / `assistant_chunk`：增量渲染
- 接到 `progress`：更新进度 UI
- 接到 `tool_start` / `tool_done`：更新 Agent 执行时间线
- 接到 `route_decision`：记录路由决策信息
- 接到 `done`：切换完成态
- 接到 `error`：展示错误提示
- 接到 `canceled`：切换"已取消"态
- 连接异常时：展示"连接中断"状态，触发自动重连

## 9. 当前实现对齐说明（2026-07-22）

### 9.1 服务端

| 模块 | 文件 | 状态 |
|------|------|------|
| Envelope 工厂 | `apps/api/src/common/sse.ts` | ✅ `SseEnvelopeFactory` 带递增 seq |
| Replay Buffer | `apps/api/src/common/sse-session.ts` | ✅ `ReplayableSseSession` + `Store` |
| 聊天流 | `apps/api/src/chat/chat.service.ts` | ✅ 8 种事件，支持 `streamKey` + `sinceSeq` |
| 简历流 | `apps/api/src/resume/resume.service.ts` | ✅ 6 种事件，支持 `streamKey` + `sinceSeq` |

### 9.2 客户端

| 模块 | 文件 | 状态 |
|------|------|------|
| SSE 解析 | `apps/web/utils/sse.ts` | ✅ `consumeSseEventEnvelopeStream` + seq 去重 |
| 事件类型 | `apps/web/utils/sse-events.ts` | ✅ 聊天 + 简历事件类型定义 |
| 状态机 | `apps/web/composables/useSseMachine.ts` | ✅ 8 状态 + 10 事件，含 `retrying`/`paused` |
| 重连监督 | `apps/web/composables/useSseSupervisor.ts` | ✅ 指数退避 + Full Jitter + 可配置重试 |
| 渲染引擎 | `apps/web/composables/useSseRenderEngine.ts` | ✅ 双缓冲 + rAF + 打字机 + 帧预算 |

### 9.3 Phase 3（断线恢复）完成度

| 任务 | 状态 |
|------|------|
| `sinceSeq` 接入 | ✅ 已通过 query/body 参数传递 |
| Replay buffer 补发 | ✅ `ReplayableSseSession` + 单元测试 |
| 指数退避 + Jitter | ✅ Full Jitter，1s-30s |
| 断网/切网/后台恢复 | 🔶 `online`/`offline`/`visibilitychange` 监听待补充 |
