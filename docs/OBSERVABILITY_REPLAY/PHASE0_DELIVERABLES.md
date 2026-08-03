# Phase 0 交付物：实施准备与边界冻结

> 本文档是 [AGENT_OBSERVABILITY_REPLAY_IMPLEMENTATION_PLAN.md](./AGENT_OBSERVABILITY_REPLAY_IMPLEMENTATION_PLAN.md) 中 Phase 0 的交付物合集，用于冻结核心名词、事件口径、字段边界和保留策略。

---

## 1. 数据对象词汇表

### 1.1 核心运行对象

#### Run（运行）

一次 Agent 执行的顶层容器，对应一次用户消息触发的完整链路。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `runId` | `string` | 是 | 全局唯一运行 ID，格式 `run-{ulid}` |
| `conversationId` | `string` | 是 | 所属会话 ID |
| `userId` | `string` | 否 | 发起用户 ID |
| `intent` | `ChatIntent` | 否 | 识别到的用户意图 |
| `selectedAgent` | `SpecialistAgentName` | 否 | 路由选择的 Agent 名称 |
| `status` | `RunStatus` | 是 | 运行状态（见下方枚举） |
| `startedAt` | `ISO 8601` | 是 | 运行开始时间 |
| `endedAt` | `ISO 8601` | 否 | 运行结束时间 |
| `rootSpanId` | `string` | 是 | 根 Span ID |
| `contextPackId` | `string` | 否 | 关联的上下文包 ID |
| `replayVersion` | `number` | 否 | 回放协议版本号（默认 1） |
| `modelName` | `string` | 否 | 使用的 LLM 模型名称 |
| `errorCode` | `string` | 否 | 运行失败时的错误码 |
| `errorMessage` | `string` | 否 | 运行失败时的错误信息 |

**RunStatus 枚举：**

| 值 | 说明 |
|------|------|
| `pending` | 已创建，尚未开始 |
| `running` | 正在执行 |
| `succeeded` | 成功完成（收到 `done` 事件） |
| `failed` | 执行失败（收到 `error` 事件） |
| `canceled` | 被取消（收到 `canceled` 事件或 AbortController 触发） |

**语义边界：**
- Run 是"一次"执行，包含从 `start` 到终态事件（`done` / `error` / `canceled`）的完整生命周期
- 同一条用户消息始终对应同一个 Run
- Run 不等于"会话"——一个会话可以有多个 Run
- Run 是事件分组的顶级容器，所有 Span / Event / Checkpoint 都归属于某个 Run

---

#### Span（片段）

Run 内的一个执行子区间，构成父子树形结构。Run 本身也有对应的根 Span（`kind=run`）。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `spanId` | `string` | 是 | 全局唯一 Span ID，格式 `span-{ulid}` |
| `parentSpanId` | `string` | 否 | 父 Span ID，根 Span 为 null |
| `runId` | `string` | 是 | 所属 Run ID |
| `kind` | `SpanKind` | 是 | Span 种类（见下方枚举） |
| `name` | `string` | 是 | 人类可读名称（如 `step-1`, `jd_parse_and_score`） |
| `status` | `SpanStatus` | 是 | 片段状态（见下方枚举） |
| `startTs` | `ISO 8601` | 是 | 开始时间 |
| `endTs` | `ISO 8601` | 否 | 结束时间 |
| `seqStart` | `number` | 是 | 该 Span 内第一个事件的 seq |
| `seqEnd` | `number` | 否 | 该 Span 内最后一个事件的 seq |
| `meta` | `Record<string, unknown>` | 否 | 扩展元数据 |

**SpanKind 枚举：**

| 值 | 说明 | 对应事件 | 典型 name |
|------|------|------|------|
| `run` | 运行级根 Span | `start` → `done`/`error` | `run` |
| `step` | Agent 迭代步骤 | `agent.step.started` → `agent.step.finished` | `step-1`, `step-2` |
| `tool` | 工具调用 | `tool.call.started` → `tool.call.finished` | `jd_parse_and_score` |
| `text` | 文本生成输出 | `assistant_chunk*` → `assistant_done` | `assistant_text` |
| `checkpoint` | 检查点标记 | `checkpoint` | `cp-v1` |

**SpanStatus 枚举：**

| 值 | 说明 |
|------|------|
| `pending` | 尚未开始（预留，实际不发事件） |
| `running` | 进行中 |
| `succeeded` | 成功完成 |
| `failed` | 失败或出错 |
| `canceled` | 被取消 |

**语义边界：**
- Span 是有明确生命周期的执行子区间，必须有 `startTs` 和（最终）`endTs`
- 父子关系由 `parentSpanId` 确立，不能形成环
- `kind=run` 的 Span 始终是 Span 树的根节点
- Span 不等于 SSE 事件——一个 Span 可能包含多个 Event
- `meta` 字段按 `kind` 存储不同结构（见各 SpanKind 的 meta 结构说明）

**各 SpanKind 的 meta 结构：**

| kind | meta 关键字段 | 说明 |
|------|------|------|
| `run` | `{ conversationId, intent?, selectedAgent?, modelName? }` | 运行的概要信息 |
| `step` | `{ stepIndex: number, promptPreview?: string }` | 步骤序号和输入摘要 |
| `tool` | `{ toolName: string, success: boolean, latencyMs: number, errorCode?: string, errorMessage?: string }` | 工具调用结果 |
| `text` | `{ totalChars: number, chunkCount: number }` | 文本输出统计 |
| `checkpoint` | `{ label: string, keyValues?: Record<string, unknown> }` | 检查点标签和快照数据 |

---

#### Event（事件）

不可变的原子执行记录，是观测系统的最小数据单元。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `eventId` | `string` | 是 | 全局唯一事件 ID，格式 `{runId}:{seq}` |
| `seq` | `number` | 是 | 单调递增序号，用于去重和断线恢复 |
| `runId` | `string` | 是 | 所属 Run ID |
| `spanId` | `string` | 否 | 所属 Span ID |
| `type` | `EventType` | 是 | 事件类型（见 2. 事件类型清单） |
| `status` | `EventStatus` | 否 | 事件状态（正常 / 异常） |
| `ts` | `ISO 8601` | 是 | 服务端时间戳 |
| `payload` | `Record<string, unknown>` | 是 | 事件体，结构因 `type` 而异 |

**EventStatus 枚举：**

| 值 | 说明 |
|------|------|
| `normal` | 正常事件 |
| `replay` | 断线重连后补发的事件 |
| `suppressed` | 被流控抑制的事件（仅标记，不实际发送） |

**语义边界：**
- Event 是不可变的，一旦生成就不修改
- `seq` 在一个 Run 内严格单调递增
- Event 通过 `spanId` 归属于某个 Span，但并非所有 Event 都必须有 `spanId`（如 `checkpoint` 可独立存在）
- 同一 `type` 的 Event 可以在一个 Run 中出现多次
- Event 不等同于 SSE 消息——SSE 消息是 Event 的传输形式（Envelope）

---

#### SSE Envelope（SSE 信封）

Event 的传输层包装，通过 SSE 连接发送到前端。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | `string` | 是 | 等同 `eventId`，格式 `{runId}:{seq}` |
| `seq` | `number` | 是 | 等同 Event.seq |
| `runId` | `string` | 是 | 等同 Event.runId |
| `spanId` | `string` | 否 | 等同 Event.spanId |
| `type` | `string` | 是 | 等同 Event.type |
| `ts` | `ISO 8601` | 是 | 等同 Event.ts |
| `payload` | `object` | 是 | 等同 Event.payload |

**语义边界：**
- Envelope 是 Event 的"网络传输形态"，语义上等价于 Event
- Envelope 不引入新字段，只是把 Event 的字段扁平化到顶层
- 持久化层存储的是 Event 而非 Envelope

---

#### Checkpoint（检查点）

执行链路中的关键状态快照，作为回放恢复锚点。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `checkpointId` | `string` | 是 | 全局唯一检查点 ID，格式 `cp-{ulid}` |
| `runId` | `string` | 是 | 所属 Run ID |
| `spanId` | `string` | 否 | 关联的 Span ID |
| `seq` | `number` | 是 | 对应的事件 seq |
| `label` | `string` | 是 | 标签（如 `agent.step.completed`, `tool.before_call`） |
| `keyValues` | `Record<string, unknown>` | 是 | 快照关键字段（增量 diff，非完整状态） |
| `createdAt` | `ISO 8601` | 是 | 检查点创建时间 |

**语义边界：**
- Checkpoint 不做完整状态快照，只保存 `{checkpointId, seq, 关联 span 指针, 关键字段增量 diff}`
- Checkpoint 是恢复锚点，不能替代完整事件日志
- 恢复 = 定位到 Checkpoint 的 `seq` + 后续事件日志重放
- 不是所有事件都产生 Checkpoint，只在关键节点（step 完成、tool 调用前/后）创建

---

#### Diagnostic Issue（诊断问题）

规则引擎产出的结构化诊断结果。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `issueId` | `string` | 是 | 全局唯一诊断 ID，格式 `diag-{ulid}` |
| `runId` | `string` | 是 | 所属 Run ID |
| `spanId` | `string` | 否 | 关联的 Span ID（定位到问题出处） |
| `category` | `DiagnosticCategory` | 是 | 诊断类别（见下方枚举） |
| `severity` | `DiagnosticSeverity` | 是 | 严重级别（见下方枚举） |
| `title` | `string` | 是 | 问题标题（一行摘要） |
| `reason` | `string` | 是 | 根因描述 |
| `evidence` | `object[]` | 是 | 证据列表，每条含 `{type, value, eventId}` |
| `suggestion` | `string` | 否 | 建议动作 |
| `createdAt` | `ISO 8601` | 是 | 生成时间 |

**DiagnosticCategory 枚举：**

| 值 | 说明 | 覆盖场景 |
|------|------|------|
| `route_misjudgment` | 路由误判或路由缺失 | 意图识别错误、Agent 选择不当、兜底路由触发 |
| `tool_failure` | 工具失败、超时、空结果或结果异常 | 工具调用超时、API 错误、返回空数据 |
| `tool_timeout` | 工具调用超时 | 工具执行超过合理时间上限 |
| `context_missing` | 上下文注入缺失 | 缺失 resume context、缺失 preference、contextPack 不完整 |
| `context_duplicate` | 上下文重复注入 | 同一记忆被多次注入 prompt |
| `context_truncation` | 上下文裁剪异常 | budget manager 过度裁剪、关键上下文被误裁 |
| `stream_interrupt` | 文本流中断 | assistant_chunk 流未正常结束、done 事件缺失 |
| `stream_incomplete` | 流式输出不完整 | 流突然关闭且无 done/error 事件 |
| `agent_loop` | Agent 循环异常 | step 数量超出预期、重复调用同一工具无进展 |
| `other` | 其他 | 未分类的异常情况 |

**DiagnosticSeverity 枚举：**

| 值 | 说明 |
|------|------|
| `critical` | 致命：导致 Run 失败或输出完全不可用 |
| `warning` | 警告：可能影响输出质量，但 Run 仍可继续 |
| `info` | 信息：值得注意但非异常的表现 |

**语义边界：**
- Diagnostic Issue 是诊断结果，不是事件本身
- 通过 `evidence[].eventId` 关联到具体的 Event
- 同一类问题在同一次 Run 中去重聚合
- 诊断引擎不阻塞主链路

---

### 1.2 上下文工程侧对象（对齐引用）

以下对象定义在 [CONTEXT_ENGINEERING_PLAN.md](./CONTEXT_ENGINEERING_PLAN.md)，观测系统仅消费其产出，不负责写入。

#### Context Pack（上下文包）

每次 Agent 执行前由 `ContextBudgetManager` 产出的上下文注入结果。

| 字段 | 类型 | 说明 |
|------|------|------|
| `packId` | `string` | 全局唯一包 ID |
| `conversationId` | `string` | 所属会话 |
| `intent` | `string` | 用户意图 |
| `maxTokens` | `number` | 允许的最大 token 预算 |
| `selectedMemoryIds` | `string[]` | 被选中注入的 memory ID 列表 |
| `droppedMemoryIds` | `string[]` | 因预算被裁剪的 memory ID 列表 |
| `summaryBlocks` | `object[]` | 摘要块列表 |
| `finalPromptPreview` | `string` | 最终注入的 prompt 摘要 |
| `generatedAt` | `ISO 8601` | 生成时间 |

#### Memory Entry（记忆条目）

| 字段 | 类型 | 说明 |
|------|------|------|
| `memoryId` | `string` | 全局唯一记忆 ID |
| `conversationId` | `string` | 所属会话 |
| `runId` | `string` | 创建的 Run |
| `layer` | `MemoryLayer` | 记忆层级 |
| `scope` | `MemoryScope` | 作用域 |
| `content` | `string` | 原始或摘要后的文本 |
| `summary` | `string` | LLM 生成的摘要 |
| `tokenEstimate` | `number` | 预估 token 数 |
| `priority` | `number` | 优先级（越大越优先保留） |
| `pinned` | `boolean` | 是否固定 |
| `freshnessScore` | `number` | 新鲜度分数 |
| `relevanceScore` | `number` | 相关性分数 |
| `sourceRefs` | `object[]` | 源数据引用 |
| `expiresAt` | `ISO 8601` | 过期时间 |

**MemoryLayer 枚举：**

| 值 | 说明 |
|------|------|
| `session` | 会话记忆（对话历史摘要） |
| `resume` | 简历记忆（简历快照、解析结果） |
| `preference` | 用户偏好记忆（风格、格式要求） |
| `tool_result` | 工具结果记忆（工具调用的返回数据） |
| `system` | 系统上下文（角色提示、约束规则） |

**MemoryScope 枚举：**

| 值 | 说明 |
|------|------|
| `conversation` | 仅当前会话可见 |
| `user` | 同一用户所有会话可见 |
| `global` | 全局共享 |

---

## 2. 事件类型清单与映射表

### 2.1 统一事件类型枚举

以下为观测系统统一的事件类型，覆盖聊天流和简历生成流。

| 编号 | 事件类型 | 所属流 | 终态 | 说明 |
|------|------|------|------|------|
| 1 | `start` | 通用 | 否 | 流会话建立，Run 开始 |
| 2 | `route_decision` | 聊天 | 否 | 编排器完成意图识别和 Agent 选择 |
| 3 | `agent.step.started` | 聊天 | 否 | Agent 步骤开始 |
| 4 | `agent.step.finished` | 聊天 | 否 | Agent 步骤完成 |
| 5 | `tool.call.started` | 聊天 | 否 | 工具调用开始（新命名，优先使用） |
| 6 | `tool.call.finished` | 聊天 | 否 | 工具调用完成（新命名，优先使用） |
| 7 | `tool_start` | 聊天 | 否 | 工具调用开始（旧命名，兼容保留） |
| 8 | `tool_done` | 聊天 | 否 | 工具调用完成（旧命名，兼容保留） |
| 9 | `assistant_chunk` | 聊天 | 否 | 增量文本片段 |
| 10 | `assistant_done` | 聊天 | 否 | 助手文本生成完毕 |
| 11 | `done` | 通用 | **是** | 流成功结束 |
| 12 | `error` | 通用 | **是** | 流失败 |
| 13 | `canceled` | 简历 | **是** | 任务被取消 |
| 14 | `checkpoint` | 通用（隐式） | **是** | 执行检查点 |
| 15 | `chunk` | 简历 | 否 | 增量简历文本片段 |
| 16 | `progress` | 简历 | 否 | 任务进度更新 |

### 2.2 事件 → SpanKind 映射

| 事件类型 | 映射 SpanKind | 映射行为 | 说明 |
|------|------|------|------|
| `start` | `run` | 创建根 Span（status=running） | 通过 `requestId` 生成 spanId |
| `route_decision` | `run` | 更新根 Span meta | 追加 intent, selectedAgent |
| `agent.step.started` | `step` | 创建 step Span（status=running） | name 取 `step-{index}` |
| `agent.step.finished` | `step` | 结束 step Span（status=succeeded/failed） | |
| `tool.call.started` | `tool` | 创建 tool Span（status=running） | 新命名 |
| `tool.call.finished` | `tool` | 结束 tool Span（status=succeeded/failed） | 新命名 |
| `tool_start` | `tool` | 创建 tool Span（status=running） | 旧命名，内部归一化到 tool.call.* |
| `tool_done` | `tool` | 结束 tool Span（status=succeeded/failed） | 旧命名，内部归一化到 tool.call.* |
| `assistant_chunk` | `text` | 创建/追加 text Span | 首次 chunk 时创建 Span |
| `assistant_done` | `text` | 结束 text Span | 记录 totalChars, chunkCount |
| `checkpoint` | `checkpoint` | 创建 checkpoint Span | 离散标记，无 running 状态 |
| `done` | `run` | 结束根 Span（status=succeeded） | 级联结束所有未完成的子 Span |
| `error` | `run` | 结束根 Span（status=failed） | 级联结束所有未完成的子 Span |
| `canceled` | `run` | 结束根 Span（status=canceled） | 简历流专用 |
| `chunk` | — | 简历流专用，暂不纳入 Span | 按文本聚合存储 |
| `progress` | — | 简历流专用，暂不纳入 Span | 仅做进度展示 |

### 2.3 新旧事件命名兼容映射

| 旧命名 | 新命名（统一后） | 兼容策略 |
|------|------|------|
| `tool_start` | `tool.call.started` | 旧事件仍然产生 `tool` Span，内部提取为同一种 SpanKind |
| `tool_done` | `tool.call.finished` | 同上 |
| `chunk`（简历流） | `chunk`（不变） | 按文本聚合存储，不创建 Span |
| `progress`（简历流） | `progress`（不变） | 仅做进度展示 |

> **兼容原则：** 观测系统同时支持新旧命名。新代码优先使用 `tool.call.*`，旧事件 `tool_start`/`tool_done` 在 Span Store 层归一化处理。不在传输层做转换。

### 2.4 流控豁免事件

以下事件在断线重连和流控中始终不被抑制：

| 事件类型 | 豁免原因 |
|------|------|
| `done` | 终态事件，客户端必须收到才能结束 |
| `error` | 终态事件，客户端必须收到才能展示错误 |
| `canceled` | 终态事件，客户端必须收到才能切换取消态 |
| `checkpoint` | 回放恢复关键节点，不能丢失 |

### 2.5 事件渲染阶段

事件按渲染紧迫度分为三个层级，供前端渲染引擎调度：

| 渲染阶段 | 优先级 | 包含事件 | 调度策略 |
|------|------|------|------|
| `critical` | 最高 | `done`, `error`, `assistant_done`, `canceled` | 立即处理，不排队 |
| `state` | 中 | `start`, `route_decision`, `agent.step.*`, `tool.*`, `progress` | 排在 bulk 之前 |
| `bulk` | 低 | `assistant_chunk`, `chunk` | 双缓冲 + rAF 调度 |

### 2.6 事件时序约束

```
聊天流正常：start → route_decision → (agent.step.started → tool.call.started → tool.call.finished → assistant_chunk* → assistant_done → agent.step.finished)* → done

聊天流失败：start → route_decision → (agent.step.started → tool.call.*)* → error

简历流正常：start → progress → chunk* → progress → done

简历流取消：start → (progress|chunk)* → canceled
```

约束规则：
- 所有流以 `start` 开头
- 终态事件 (`done` / `error` / `canceled`) 发送后连接关闭
- `seq` 全局单调递增
- `runId` 在同一流内一致
- `tool.call.started` 和 `tool.call.finished` 必须成对出现
- `agent.step.started` 和 `agent.step.finished` 必须成对出现

---

## 3. 记录粒度与保留期策略

### 3.1 粒度分级总览

| 级别 | 策略 | 存储内容 | 体积特征 | 典型示例 |
|------|------|------|------|------|
| **P0 必存** | 结构化字段，随事件落盘 | span 关系、seq、时间戳、事件类型、状态码、errorCode、路由决策摘要、tool 名/延迟/成功标志 | 体积小（< 500B/条），不可重建 | `{ type: "tool.call.finished", seq: 42, spanId: "span-xxx", payload: { toolName: "jd_parse_and_score", success: true, latencyMs: 320 } }` |
| **P1 常存** | 带截断策略，按需补全 | tool output 前 2KB + hash、user prompt 全文、assistant 完整回复文本（聚合后） | 体积中（1-10KB/条），有重建成本 | tool output preview、用户输入的原文、最终回复全文 |
| **P2 聚合存** | 聚合后再存，不逐条存原文 | stream chunk 聚合文本 + chunk 元信息数组（seq、时间戳、长度） | 体积从 O(n) 降到 O(1) | 将 200 个 assistant_chunk 合并为 1 条聚合文本 + 200 字节的元信息数组 |
| **P3 不存** | 仅摘要或引用回源 | LLM 中间推理过程、完整系统 prompt、记忆库原始文档、大体积二进制 | — | model.internal_reasoning、完整系统 prompt、完整简历原文 |

### 3.2 P0 必存 — 详细字段清单

以下字段无论任何情况都必须落盘：

| 存储字段 | 说明 |
|------|------|
| `runId` | 所属 Run |
| `spanId` | 所属 Span |
| `parentSpanId` | 父 Span |
| `seq` | 事件序号 |
| `type` | 事件类型 |
| `ts` | 服务端时间戳 |
| `span.kind` | Span 种类 |
| `span.name` | Span 名称 |
| `span.status` | Span 最终状态 |
| `span.startTs` | Span 开始时间 |
| `span.endTs` | Span 结束时间 |
| `payload.toolName` | 工具名称（tool 事件） |
| `payload.success` | 工具成功标志（tool 事件） |
| `payload.latencyMs` | 工具延迟（tool 事件） |
| `payload.errorCode` | 错误码（error 事件 / tool 失败） |
| `payload.requestId` | 请求 ID（start / done 事件） |
| `payload.conversationId` | 会话 ID（done 事件） |

### 3.3 P1 常存 — 详细字段清单

以下字段默认存储，但带截断或引用策略：

| 存储字段 | 截断/引用策略 | 说明 |
|------|------|------|
| `tool output` | 默认截断前 2KB，存 `preview + length + hash` | 失败时或前端显式请求时补全量 |
| `user prompt` | 全文保存 | 路由诊断的关键输入 |
| `assistant 完整回复` | 全文保存（聚合后） | `assistant_done.content` |
| `route_decision` | 全文保存 | 包含 intent, selectedAgent, reason, confidence, matchedRules |
| `agent.step prompt preview` | 摘要保存（前 200 字符 + hash） | 完整 prompt 不存，回源上下文工程 |
| `系统 prompt 引用` | 不存原文，只存 `contextPackId + 摘要 + 版本号` | 复现时按引用回源 |
| `记忆注入引用` | 不存原文，只存 `contextPackId + selectedMemoryIds + droppedMemoryIds` | 同上 |

### 3.4 P2 聚合存 — 详细策略

#### Stream Chunk 聚合

```
原始: chunk-1, chunk-2, ..., chunk-200  (200 条独立 event)
聚合后:
  {
    "fullText": "完整的回复文本...",
    "chunkMeta": [
      { "seq": 14, "ts": "2026-07-22T10:30:00.100Z", "len": 78 },
      { "seq": 15, "ts": "2026-07-22T10:30:00.180Z", "len": 82 },
      ...
    ]
  }
```

chunkMeta 用于回放时重建打字机节奏。

#### Checkpoint 存储

```
不存完整状态快照，只存：
  {
    "checkpointId": "cp-xxx",
    "seq": 42,
    "spanId": "span-xxx",
    "label": "agent.step.completed",
    "keyValues": {
      "stepIndex": 2,
      "toolCallsCompleted": 1,
      "assistantTextLength": 520
    }
  }
```

恢复 = 锚点 keyValues + 后续事件日志重放。

### 3.5 P3 不存 — 详细清单

| 内容 | 替代策略 |
|------|------|
| LLM 内部推理过程（thinking / reasoning） | 不存，无法从 API 获取 |
| 完整系统 prompt | 改为 `contextPackId + 摘要 + 版本号` 引用 |
| 完整记忆库原文（简历全文等） | 保留 `sourceRefs` 引用，回源 `ConversationMemory` 或 `ResumeLibraryItem` 表 |
| 大体积二进制（图片、文件） | 不存储，仅保留文件名和引用 |
| Token 日志级别的逐 token 时间戳 | 聚合到 chunkMeta 足够 |

### 3.6 保留期（TTL）策略

TTL 以所属 Run 的终态为基准计算：

| Run 终态 | P0 结构化字段 | P1 截断数据 | P2 聚合数据 | checkpoint | diagnostic_issue |
|------|------|------|------|------|------|
| `succeeded` | **7 天** | 与 Run 相同（**7 天**） | 跟随会话/消息生命周期 | 与 Run 相同（**7 天**） | 与 Run 相同（**7 天**） |
| `failed` / `canceled` | **30 天** | 与 Run 相同（**30 天**） | 跟随会话/消息生命周期 | 与 Run 相同（**30 天**） | 与 Run 相同（**30 天**） |

> **原则：**
> - 失败 Run 的观测数据保留更久，便于事后复盘和根因分析；成功 Run 的数据快速清理以控制存储成本。
> - P0/P1/checkpoint/diagnostic_issue 的 TTL 与所属 Run 的终态绑定。
> - P2 聚合文本（chunk 聚合文本 + chunkMeta）不设置独立过期时间，跟随业务数据（会话/消息记录）的生命周期。当会话删除或消息清退时，与其关联的聚合文本随之清理。

**热数据（内存）：**
- Span Store 在 Web 前端内存中维护当前 Run 的所有 Span
- Run 完成后允许手动保留或自动释放
- 页面刷新后仅保留 P0+P1 的持久化数据

**温数据（数据库）：**
- Run 结束后自动从内存持久化到数据库
- 支持按 `runId + seq` 分页查询

**冷数据清理：**
- 定时任务（Cron）以 `Run.endedAt + TTL` 为过期基准，按 `runId` 级联清理所有相关 Event、Span、Checkpoint、DiagnosticIssue
- 清理策略：到期标记 → 保留宽限期（1 天）→ 物理删除
- 账号注销时所有关联数据级联删除

### 3.7 单 Run 预算控制

| 预算项 | 上限 | 超限行为 |
|------|------|------|
| 事件总数 | 500 条/Run | 超限后新事件只存 P0，不存 P1/P2 |
| 事件日志总字节 | 1 MB/Run | 超限后降级为「P0 + 摘要」 |
| Stream Chunk 数量 | 200 条/Run | 超限后新 chunk 仅计数，不追加 chunkMeta |

---

## 4. 与上下文工程的字段对齐清单

### 4.1 字段对齐总览

| # | 观测系统字段 / 能力 | 上下文工程侧对应 | 对齐方式 | 对齐状态 |
|------|------|------|------|------|
| 1 | `run.contextPackId` | `contextPack.packId` | Run 创建后由观测系统关联 contextPack 的 packId | 🔶 待实施 |
| 2 | `span.meta.conversationId` | `memory.conversationId` | 从 Run 层级继承 | ✅ 已有（`SseEventEnvelope.runId`） |
| 3 | 选中记忆展示 | `contextPack.selectedMemoryIds` | 通过 packId 查询 memory 列表，UI 展示 | 🔶 待实施 |
| 4 | 裁剪记忆展示 | `contextPack.droppedMemoryIds` | 通过 packId 查询被裁剪的 memory 列表，标注裁剪原因 | 🔶 待实施 |
| 5 | 摘要注入概览 | `contextPack.summaryBlocks` | UI 展示摘要块数量、来源层级 | 🔶 待实施 |
| 6 | 注入异常检测 | `memory.mergeGroup` / `memory.sourceRefs` | 诊断引擎检查记忆缺失、重复注入、裁剪异常 | 🔶 待实施（Phase 4） |
| 7 | prompt 预览 | `contextPack.finalPromptPreview` | P1 级别存储 promptPreview 摘要 | 🔶 待实施 |
| 8 | 记忆追溯 | `memory.sourceRefs` | UI 支持从诊断 issue 点击跳转到源 memory | 🔶 待实施 |
| 9 | 记忆版本 | `memory.version` / `memory.updatedAt` | 展示记忆的版本号和更新时间 | 🔶 待实施 |
| 10 | 记忆过期状态 | `memory.expiresAt` | UI 标注已过期记忆，诊断引擎检查过期注入 | 🔶 待实施 |

### 4.2 Run 与 Context Pack 的关联

```
观测系统 Run:
  runId: "run-xxx"
  contextPackId: "pack-yyy"    ← 关联

上下文工程 ContextPack:
  packId: "pack-yyy"
  selectedMemoryIds: ["mem-1", "mem-2"]
  droppedMemoryIds: ["mem-3"]
  summaryBlocks: [...]
  finalPromptPreview: "..."

观测系统前端:
  AgentTraceCard
    → 读取 run.contextPackId
    → 查询 ContextPack 数据
    → 显示:
        - 选中记忆列表（selectedMemoryIds → 按 layer 分组展示）
        - 裁剪记忆列表（droppedMemoryIds → 展示裁剪原因如 "超出 token 预算"）
        - 摘要注入概览（summaryBlocks 数量 + 来源层级分布）
        - prompt 预览（finalPromptPreview 摘要）
```

### 4.3 诊断系统的上下文相关规则

以下诊断类别依赖上下文工程的数据：

| 诊断类别 | 检测条件 | 依赖的上下文字段 | 证据来源 |
|------|------|------|------|
| `context_missing` | `selectedMemoryIds` 为空 或 `resume` layer 无选中记忆 | `contextPack.selectedMemoryIds`, `memory.layer` | Run.contextPackId → selectedMemoryIds |
| `context_duplicate` | 同一 `memoryId` 在 `selectedMemoryIds` 中出现 ≥2 次 | `contextPack.selectedMemoryIds` | 数组去重检测 |
| `context_truncation` | `droppedMemoryIds` 非空 且 包含 `priority >= 8` 的高优先级记忆 | `contextPack.droppedMemoryIds`, `memory.priority` | 检查被裁剪的记忆中是否有高优先级条目 |
| `context_injection_failure` | `contextPackId` 为 null 但 Run 已进入 agent step | `run.contextPackId` | Run 进入 step 但 contextPackId 缺失 |

### 4.4 上下文注入概览区 UI 字段

观测 UI 中的上下文注入概览区（`ContextInjectionOverview`）展示以下字段：

```typescript
interface ContextInjectionOverview {
  packId: string;                     // contextPack.packId
  generatedAt: string;                // contextPack.generatedAt
  maxTokens: number;                  // contextPack.maxTokens
  
  // 选中记忆
  selectedCount: number;              // selectedMemoryIds.length
  selectedByLayer: {                  // 按 layer 分组计数
    session: number;
    resume: number;
    preference: number;
    tool_result: number;
    system: number;
  };
  
  // 摘要
  summaryBlockCount: number;          // summaryBlocks.length
  
  // 裁剪
  droppedCount: number;               // droppedMemoryIds.length
  droppedTopReasons: string[];        // 裁剪原因（如 "超出 token 预算"）
  
  // prompt
  promptPreview: string;              // finalPromptPreview（摘要，前 200 字符）
}
```

### 4.5 数据访问边界

观测系统对上下文工程数据的访问遵循以下原则：

| 操作 | 允许 | 说明 |
|------|------|------|
| 读取 `contextPackId` | 是 | 通过 `run.contextPackId` 关联 |
| 查询 contextPack 摘要信息 | 是 | 用于 UI 概览展示 |
| 查询 selectedMemoryIds 列表 | 是 | 用于展示注入的记忆来源 |
| 查询 droppedMemoryIds 列表 | 是 | 用于展示被裁剪的记忆 |
| 读取单个 memory 的 `content` | 否 | 观测系统不保存 memory 原文，需要时回源上下文工程 |
| 读取单个 memory 的 `summary` | 是 | 用于展示记忆摘要 |
| 写入 memory | 否 | 观测系统只读不写 |
| 修改 contextPack | 否 | 观测系统只读不写 |

---

## 5. 端到端验收样例

### 5.1 数据对象一致性验收

| 验收项 | 验收方法 | 通过条件 |
|------|------|------|
| Run 边界清晰 | 发送一条聊天消息，检查 `runId` 是否在整个流中一致 | `start` 到 `done`/`error` 的所有事件 `runId` 相同 |
| Span 父子关系正确 | 检查 `step` span 的 `parentSpanId` 指向 `run` span | `step.parentSpanId === run.spanId` |
| Event seq 单调递增 | 检查同一 runId 内所有 event 的 seq | `seq[i] < seq[i+1]` |
| Span 生命周期完整 | 检查 `agent.step.started` → `agent.step.finished` 成对出现 | 每个 started 有 finished，span.status 正确 |
| 终态事件唯一 | 检查每个 Run 只有一个终态事件 | 每 Run 只有 1 个 `done` 或 `error` 或 `canceled` |

### 5.2 事件映射一致性验收

| 验收项 | 验收方法 | 通过条件 |
|------|------|------|
| 旧事件兼容 | 发送 `tool_start`/`tool_done`，检查 Span Store 是否正确创建 | Span.kind = 'tool'，状态正确 |
| 新事件优先 | 发送 `tool.call.started`/`tool.call.finished`，检查是否优先使用新命名 | Event.type = 'tool.call.*' |
| 上下文关联 | 检查 `route_decision` 事件后 run span meta 是否包含 intent | span.meta.intent 非空 |

### 5.3 上下文字段对齐验收

| 验收项 | 验收方法 | 通过条件 |
|------|------|------|
| contextPackId 关联 | 发送消息，检查 run 是否关联到 contextPack | run.contextPackId 非空 |
| 记忆选中展示 | UI 中查看选中记忆列表，与 contextPack.selectedMemoryIds 比对 | 数量和内容一致 |
| 裁剪记忆展示 | UI 中查看裁剪记忆列表，与 contextPack.droppedMemoryIds 比对 | 数量和内容一致 |
| 摘要注入概览 | UI 中查看摘要概览，与 contextPack.summaryBlocks 比对 | summaryBlockCount 一致 |

---

## 6. 附：修订记录

| 版本 | 日期 | 修订内容 |
|------|------|------|
| v1.0 | 2026-08-03 | 初始版本，冻结数据对象词汇表、事件类型映射、记录粒度策略、上下文字段对齐 |

> **关联文档：**
> - [AGENT_OBSERVABILITY_REPLAY_PLAN.md](./AGENT_OBSERVABILITY_REPLAY_PLAN.md)
> - [AGENT_OBSERVABILITY_REPLAY_IMPLEMENTATION_PLAN.md](./AGENT_OBSERVABILITY_REPLAY_IMPLEMENTATION_PLAN.md)
> - [CONTEXT_ENGINEERING_PLAN.md](./CONTEXT_ENGINEERING_PLAN.md)
> - [API_STREAM_SPEC.md](./API_STREAM_SPEC.md)
> - [DB_SCHEMA.md](./DB_SCHEMA.md)
