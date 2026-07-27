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
