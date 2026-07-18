# SSE_RENDER_ENGINE_PLAN.md

## 1. 目标

实现一套面向 Agent 对话与执行过程的 SSE 流式渲染引擎，满足以下能力：

- 基于 `requestAnimationFrame` 的双缓冲打字机渲染
- 支持断线重连与事件补偿
- 支持应用层背压控制
- 支持 Agent 执行时间线的实时渲染
- 保持文本流与执行流解耦，避免 UI 抖动

## 2. 设计原则

- SSE 只负责传输，不承担渲染节奏控制
- 前端负责事件调度、合并、降频和提交
- 文本流、状态流、时间线流使用统一事件协议
- 所有事件必须可去重、可重放、可恢复
- 渲染优先保证稳定性，其次才是“更快显示”

## 3. 总体架构

### 3.1 分层

1. 传输层
- SSE 连接负责接收服务端事件
- 连接状态由独立 supervisor 管理

2. 缓冲层
- `ingressBuffer` 保存网络层收到但未处理的事件
- `frameBuffer` 保存本帧准备提交给 UI 的增量

3. 调度层
- `requestAnimationFrame` 负责按帧消费事件
- 每帧限制处理预算，避免长任务

4. 展示层
- 文本区域做打字机效果
- 时间线区域实时呈现 Agent 运行轨迹

### 3.2 数据流

`SSE -> ingressBuffer -> decode/merge -> frameBuffer -> rAF commit -> UI`

## 4. 事件协议

### 4.1 通用字段

每条事件都应包含：

- `id`: 全局唯一事件 ID
- `seq`: 单调递增序号
- `runId`: 一次 Agent 执行的会话 ID
- `spanId`: 当前执行片段 ID
- `type`: 事件类型
- `ts`: 服务端时间戳
- `priority`: 优先级
- `payload`: 事件内容

### 4.2 事件类型

- `stream.start`
- `text.delta`
- `agent.step.started`
- `agent.step.finished`
- `tool.call.started`
- `tool.call.finished`
- `checkpoint`
- `heartbeat`
- `stream.done`
- `stream.error`

### 4.3 恢复要求

- 客户端必须记录最后成功消费的 `seq`
- 重连时携带 `Last-Event-ID` 或 `sinceSeq`
- 服务端从 replay buffer 补发缺失事件

## 5. 客户端渲染引擎

### 5.1 双缓冲模型

- `ingressBuffer` 负责收事件
- `frameBuffer` 负责本帧提交
- 每帧只允许有限数量的字符或事件进入 UI
- 采用增量追加，不做整段重绘

### 5.2 打字机策略

- 文本按 grapheme cluster 切分，避免 emoji 和组合字符断裂
- 优先按语义片段输出，再按字符粒度细分
- 支持按速度配置渲染节奏，例如 `charsPerSecond`
- 当积压过大时自动合并片段，优先保证可读性

### 5.3 帧预算

- 单帧处理时间建议控制在 `8ms` 左右
- 若积压超过阈值，降低动画粒度，切换为批量提交
- 不允许在单帧内完成大规模 DOM 重建

## 6. 断线重连

### 6.1 重连策略

- 使用指数退避
- 重试间隔示例：`1s -> 2s -> 4s -> 8s -> 16s -> 30s`
- 每次重试加入随机抖动，避免雪崩

### 6.2 恢复流程

1. 记录最后消费的 `seq`
2. 关闭旧连接并进入重连状态
3. 使用 `sinceSeq` 或 `Last-Event-ID` 重新连接
4. 补发缺失事件
5. 恢复正常渲染

### 6.3 服务端要求

- 维护短期 replay buffer
- `checkpoint` 事件作为恢复锚点
- 终态事件发送后主动关闭连接

## 7. 背压控制

### 7.1 问题定义

SSE 单向流没有原生应用层背压，因此需要前端和服务端协同实现软背压。

### 7.2 客户端信号

客户端监控以下指标：

- `ingressBuffer` 长度
- 当前帧耗时
- UI 提交延迟
- 未渲染事件数量

### 7.3 控制方式

- 当积压较小时正常推送
- 当积压升高时降低事件粒度
- 当积压严重时合并低优先级事件
- 必要时通过控制接口通知服务端降速或暂停部分非关键事件

### 7.4 处理策略

- 高优先级事件优先渲染
- 文本增量可合并，时间线状态不可丢失
- 终态事件永远优先提交

## 8. Agent 时间线

### 8.1 建模方式

- 将一次执行拆成 `run -> step -> tool -> subtask`
- 每个节点记录 `startTs`、`endTs`、`status`、`label`
- 使用 `parentSpanId` 建立层级关系

### 8.2 渲染方式

- 左侧显示对话与输出文本
- 右侧显示时间线轨迹
- 节点状态实时更新：`pending`、`running`、`succeeded`、`failed`、`canceled`

### 8.3 交互要求

- 支持按 run 回放
- 支持按 step 折叠与展开
- 支持点击时间线节点定位对应文本输出

## 9. 实施阶段

### Phase 1: 协议与基础链路

- 定义事件 envelope
- 实现 SSE 连接 supervisor
- 实现 `seq` 去重与基础重连
- 打通最小事件流

### Phase 2: 双缓冲渲染

- 实现 `ingressBuffer` / `frameBuffer`
- 接入 `requestAnimationFrame`
- 实现打字机节奏控制
- 处理 grapheme cluster 切分

### Phase 3: 断线恢复

- 接入 `Last-Event-ID` / `sinceSeq`
- 实现 replay buffer 补发
- 完善指数退避与 jitter
- 覆盖断网、切网、页面后台恢复

### Phase 4: 背压控制

- 增加积压监控
- 设计控制接口
- 实现事件合并和降频策略
- 验证高并发输入下的稳定性

### Phase 5: 时间线渲染

- 建立 span store
- 增加 Agent step / tool call 事件
- 实现实时时间线组件
- 完成文本与时间线联动

### Phase 6: 验证与优化

- 补齐单元测试与集成测试
- 验证长文本、大量事件和弱网场景
- 做性能 profiling
- 输出最终使用约束与上线检查清单

## 10. 验收标准

- 断网后可恢复到正确位置，不重复渲染已消费内容
- 长文本流场景下 UI 无明显卡顿
- 高事件密度下仍能保持主线程可用
- Agent 时间线可以实时反映执行进度
- 终态事件可稳定触发收尾与状态固化

## 11. 风险与约束

- SSE 无原生双向背压，服务端降速只能通过应用层协商实现
- 大量细粒度增量会放大主线程压力，必须做合并
- 时间线和文本流若共用同一渲染链路，容易互相拖慢
- replay buffer 保留时间过短会导致断线恢复不完整

## 12. 待补充内容

- 服务端 SSE 事件具体字段定义
- 前端状态管理结构
- 时间线组件布局与交互细节
- 压力测试场景与指标门槛
