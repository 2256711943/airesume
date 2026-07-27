# Phase 5 B 方案执行计划

## 目标

把现有 SSE 事件流整理成统一的 `span store`，并在此基础上实现实时时间线、文本联动和可回放的执行轨迹。

## 方案核心

- `SSE event` 只负责传输。
- 前端把事件归一成 span。
- `span store` 维护树状关系和当前状态。
- 时间线组件只消费 `span store`，不直接读原始 SSE。
- 文本消息与 span 通过 `spanId` 绑定。

## 数据模型

建议统一成以下 span 类型：

- `run`
- `step`
- `tool`
- `text`
- `checkpoint`

每个 span 建议包含：

- `spanId`
- `parentSpanId`
- `runId`
- `kind`
- `name`
- `status`
- `startTs`
- `endTs`
- `seqStart`
- `seqEnd`
- `messageIds`
- `meta`

## 事件映射

- `stream.start` -> 创建 `run`
- `agent.step.started` -> 创建 `step`
- `agent.step.finished` -> 结束 `step`
- `tool.call.started` -> 创建 `tool`
- `tool.call.finished` -> 结束 `tool`
- `text.delta` -> 写入 `text` span
- `checkpoint` -> 写入锚点
- `stream.done` / `stream.error` -> 结束 `run`

旧事件保持兼容映射，不一次性破坏现有协议。

## 前端结构

- `useSpanStore`：负责归一化、增量更新、回放。
- `useSpanTimeline`：提供派生视图和选中态。
- `AgentTimelinePanel`：实时时间线主组件。
- `TimelineNode`：渲染 step / tool / text 节点。
- `AgentTraceCard`：保留做摘要卡，不承担主时间线职责。

## 文本联动

- 每条 assistant 消息绑定主 span。
- 点击时间线节点时滚动到对应消息。
- hover 节点时高亮对应文本块。
- 流式文本继续走现有 render engine，timeline 只接收结构化状态。

## 实施步骤

1. 定义 span 类型和 store 接口。
2. 扩展 SSE 事件到 step / tool 级别。
3. 落地 span reducer 和派生 selector。
4. 新增时间线面板和节点组件。
5. 接入消息锚点和定位。
6. 补齐回放、断线重连后的状态恢复。
7. 清理旧的平铺 `toolCalls` 依赖。

## 验收标准

- 同名工具可正确区分多次调用。
- step / tool 状态可实时更新。
- 时间线点击能定位到对应文本。
- 断线重连后时间线不重复、不丢段。
- 文本渲染和时间线渲染互不阻塞。

## 风险与控制

- 事件过密时，span 更新必须做增量合并。
- 时间线和文本不要共用同一渲染队列。
- 旧 trace 字段只能做过渡层，不能继续扩展。
