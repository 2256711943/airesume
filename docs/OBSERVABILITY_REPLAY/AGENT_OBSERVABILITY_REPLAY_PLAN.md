# Agent 链路观测、回放与故障诊断执行计划

## 目标

把当前流式事件和时间线能力升级为完整的 Agent 运行观测系统，支持执行回放、故障定位、结果对比和断线补偿。

## 方案核心

- 统一以 `run -> span -> event -> checkpoint` 组织 Agent 执行链路。
- 观测系统不直接依赖原始文本，而消费结构化运行数据。
- 回放基于事件日志和检查点恢复，不依赖实时流重放。
- 诊断系统对路由、工具、记忆注入和流中断做规则化分析。
- 前端提供“实时观察”和“事后复盘”两套模式。

## 数据模型

建议统一成以下运行对象：

- `run`
- `span`
- `event`
- `checkpoint`
- `diagnostic_issue`

每个 run 建议包含：

- `runId`
- `conversationId`
- `intent`
- `selectedAgent`
- `status`
- `startedAt`
- `endedAt`
- `rootSpanId`
- `contextPackId`
- `replayVersion`

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
- `meta`

每个 diagnostic issue 建议包含：

- `issueId`
- `runId`
- `spanId`
- `category`
- `severity`
- `title`
- `reason`
- `evidence`
- `suggestion`
- `createdAt`

## 记录粒度

按「诊断价值 × 体积 × 可重建性」分档存储，不做全量保存。以不可变事件日志为主，checkpoint 只做恢复锚点，不能替代完整事件日志。

### P0 必存（结构化、体积小、不可重建）

span 关系、seq、时间戳、事件类型、状态码、errorCode、路由决策摘要、tool 名/延迟/成功标志。随事件本身落盘，无额外成本。

### P1 常存（带截断策略）

- tool output：默认截断（如前 2KB）存 preview + length + hash；失败或显式开启时补全量。
- user prompt：原文保存，是路由诊断的关键输入。
- 系统 prompt / 记忆注入：不存原文，只存 contextPackId + 摘要 + 版本号，复现时按引用回源。

### P2 聚合存（不逐条存原文）

- stream chunk：不逐条保存原文。按 text span 聚合为完整文本存一次，另存 chunk 元信息数组（seq、时间戳、长度），回放时按元信息重建打字机节奏，存储从 O(n) 降到 O(1)。
- checkpoint state：不存完整状态快照。只存 { checkpointId, seq, 关联 span 指针, 关键字段增量 diff }，恢复 = 锚点 + 后续事件日志重放重建。

### P3 不存

LLM 中间推理过程、完整系统 prompt、记忆库原始文档、大体积二进制。降级为摘要或引用回源。

### 存储控制

- 热/冷分离：实时 UI 用内存 span store；回放数据落持久化事件日志，分页/窗口化加载。
- 单 run 预算：限制事件数与字节量（如 500 事件 / 1MB），超限降级为「P0 + 摘要」。
- 隐私：prompt 与回复含用户数据，P1/P2 数据支持 TTL 过期并随会话删除。

## 事件映射

- `start` -> 创建 `run`
- `route_decision` -> 写入路由决策事件
- `agent.step.started` -> 创建 `step span`
- `agent.step.finished` -> 结束 `step span`
- `tool_start` / `tool.call.started` -> 创建 `tool span`
- `tool_done` / `tool.call.finished` -> 结束 `tool span`
- `assistant_chunk` -> 记录 `text event`
- `checkpoint` -> 记录可回放锚点
- `error` -> 创建诊断问题并结束相关 span
- `done` -> 结束 `run`

旧事件保持兼容映射，不要求一次性切协议。

## 前端结构

- `useTraceStore`：负责 run / span / event / checkpoint 归一化存储。
- `useReplayController`：控制播放、暂停、跳帧、倍速和 checkpoint 恢复。
- `useDiagnosticsStore`：根据运行数据生成路由异常、工具失败、断流等诊断项。
- `AgentRunTimelinePanel`：展示实时执行时间线。
- `ReplayScrubber`：支持 seq / checkpoint 级别回放。
- `DiagnosticsDrawer`：集中展示故障、证据和修复建议。

## 回放能力

- 支持按 `seq` 单步回放。
- 支持按 `checkpoint` 快进恢复。
- 支持同一问题多次 run 的结果 diff。
- 支持查看路由决策、工具调用和文本产出的时序差异。

## 实施步骤

### MVP 范围

MVP 只做完整的实时观测，但复盘的数据地基（事件持久化）随实时链路一并落地，复盘 UI 与 run 对比放 Phase 2。

| MVP 做（完整） | MVP 做（地基） | Phase 2 做 |
|---|---|---|
| AgentRunTimelinePanel 实时时间线 | 事件持久化（按记录粒度 P0/P1 落库） | ReplayScrubber seq/checkpoint 回放 |
| DiagnosticsDrawer 实时诊断 | 单 run 事件预算 + 窗口化加载 | run 对比 / diff 视图 |
| 诊断规则引擎（四大高频故障） | 事件日志查询接口（按 runId/seq） | 回放模式与实时模式状态隔离 |

MVP 验收 = 时序可还原、断线补偿完整、诊断可命中、事件日志可查询；"同一问题多次执行可对比"暂不验收。

### 执行顺序

1. 定义 run / span / event / checkpoint / diagnostic issue 模型。
2. 扩展现有 span store，补齐事件日志和 checkpoint 索引。
3. 落地 replay controller，支持按 seq 和 checkpoint 驱动 UI 恢复。
4. 增加诊断规则，覆盖路由误判、工具超时、流中断、上下文缺失等场景。
5. 新增回放面板、诊断抽屉和 run 对比视图。
6. 接入断线重连后的事件补偿，保证回放数据完整性。
7. 清理只看最终回答、不保留运行过程的旧 trace 依赖。

## 验收标准

- 任意一次 run 都能还原 step / tool / text 的完整时序。
- SSE 断线后重新订阅不会导致回放数据重复或缺段。
- 工具失败、路由误判、上下文缺失至少能命中一条可读诊断。
- 同一问题多次执行时，可直观看到决策和结果差异。
- 回放模式不影响实时模式的流式渲染性能。

## 风险与控制

- 事件量大时，回放日志必须做分页或窗口化加载。
- 诊断规则先覆盖高频故障，不要一开始做成庞大规则库。
- 回放 UI 与实时 UI 共享 store 时，要避免状态互相污染。
- checkpoint 只能做恢复锚点，不能替代完整事件日志。
