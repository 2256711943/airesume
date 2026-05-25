# SPRINT_2W_TASK_PLAN.md

## 1. Sprint 目标

在 2 周（10 个工作日）内，交付一套可写进简历、且与当前项目强相关的 AI 业务技术能力：

1. 真实 SSE 流式生成（支持取消/重试）
2. 生成与改写异步化（Redis + BullMQ）
3. 活动批量生产（Campaign Batch）
4. 真实指标看板（非占位页）
5. AI 安全护栏（输入/输出双层）
6. 已采纳内容复用（轻量业务记忆，Light RAG）

本 Sprint 明确不做：

- 评分引擎重构
- 离线评测体系
- Prompt/模型版本治理

---

## 2. 当前基线（基于现有代码）

- Backend：NestJS + Prisma + SQLite
- Frontend：Nuxt
- 已有主链路：商品 -> 生成 -> 评分 -> 改写 -> 采纳
- 当前主要缺口：
  - `apps/api/src/copy/copy.service.ts` 的 SSE 还是占位实现（仅 `done`）
  - `apps/web/pages/metrics.vue` 仍是占位页面
  - 生成/改写链路仍以同步请求为主

---

## 3. 按天任务拆解（10 个工作日）

## Day 1：流式协议定稿 + 状态流设计

任务：

- 设计并定稿 SSE 事件协议：
  - `start`
  - `chunk`
  - `progress`
  - `done`
  - `error`
  - `canceled`
- 更新 `docs/API_STREAM_SPEC.md`，保证文档和实现一致。
- 设计任务状态流转点（开始/完成/失败/取消）。

DoD：

- SSE 协议文档可直接用于前后端联调。
- 状态流转在代码中有明确落点。

## Day 2：后端真实 SSE 生成

任务：

- 改造 `apps/api/src/copy/copy.service.ts` 的 `generateStream()` 为真实流式输出。
- 在 `apps/api/src/copy/copy.ai.service.ts` 增加流式调用能力。
- 统一 `requestId/taskId` 在整条事件流中的追踪。

DoD：

- 事件顺序满足 `start -> chunk* -> done/error`。
- 上游模型异常能正确返回 `error` 事件（含可读原因）。

## Day 3：前端流式交互（可取消/可重试）

任务：

- 改造 `apps/web/pages/copy.vue`，从一次性返回改为 SSE 消费。
- 增加交互能力：
  - 取消当前生成
  - 失败后重试
- 实现逐段渲染与任务状态展示。

DoD：

- 页面可实时看到文案流式生成过程。
- 取消与重试在 UI 上可完整闭环。

## Day 4：队列基础设施（BullMQ + Redis）

任务：

- 新增后端 queue 模块：
  - queue config
  - producer service
  - worker processor
- 将生成/改写长耗时逻辑迁移到队列任务执行。

DoD：

- 提交请求后能创建队列任务并返回任务标识。
- Worker 能消费任务并更新状态。

## Day 5：异步任务可观测与前端状态跟踪

任务：

- 新增任务状态查询接口（如 `/copy/tasks/:id`）。
- 前端支持异步任务追踪（轮询或 SSE 状态流）。
- 增加失败任务重试入口。

DoD：

- 异步任务全流程可见：`pending/running/succeeded/failed`。
- 前端能稳定显示状态并支持失败重试。

## Day 6：Campaign Batch 数据模型与接口

任务：

- 在 Prisma 增加批量任务实体（campaign + item）。
- 新增批量能力接口：
  - 创建批次
  - 启动批量生成
  - 查询批次进度
  - 重试失败子项
- 与队列 worker 打通。

DoD：

- 单批次可包含多商品，且可追踪每个子项状态。

## Day 7：批量任务页面 + 导入导出

任务：

- 新增 Nuxt 批量任务页。
- 支持：
  - 批量商品选择
  - 启动批量生成
  - 进度表
  - 导出生成结果（CSV/JSON）

DoD：

- 批量页面可用于真实运营演示。
- 导出文件可直接给业务使用。

## Day 8：指标后端聚合

任务：

- 新增 metrics 模块与接口：
  - `/metrics/overview`
  - `/metrics/trend`
- 聚合数据来源：
  - `copy_tasks`
  - `copy_scores`
  - `adoption_feedback`
- 关键指标：
  - 生成量
  - 成功率
  - 采纳率
  - P95 耗时

DoD：

- 指标接口支持按天/周聚合查询。
- 核心指标可与数据库抽样核对一致。

## Day 9：指标看板页面落地

任务：

- 替换 `apps/web/pages/metrics.vue` 占位实现。
- 实现 KPI 卡片、趋势图、时间筛选。
- 每个指标配业务解释文案，提升演示说服力。

DoD：

- 看板展示真实数据，可直接用于项目答辩/面试演示。

## Day 10：AI 安全护栏 + 采纳内容记忆增强

任务：

- 安全护栏能力：
  - 输入注入模式检测
  - 生成前禁用词校验
  - 生成后绝对化表达过滤（含 reason code）
- 轻量业务记忆：
  - 按平台/类目/语气检索历史已采纳文案
  - 取 top-k 作为 few-shot 上下文参与生成

DoD：

- 风险内容可拦截并返回明确原因。
- 引入采纳样本后，生成风格一致性可观察提升。

---

## 4. 每周里程碑

第 1 周里程碑：

- SSE 真实流式链路上线。
- 队列异步架构跑通。

第 2 周里程碑：

- Campaign 批量生产链路跑通。
- 指标看板上线。
- 安全护栏与业务记忆增强上线。

---

## 5. Sprint 出口验收清单

- SSE 支持 `start/chunk/done/error/canceled` 全事件流。
- 队列链路在并发 30 请求下可稳定执行。
- 批量任务支持 100 商品处理与失败子项重试。
- 指标页展示真实 KPI 数据（非 mock）。
- 安全护栏可拦截高风险内容并返回 reason code。
- 生成流程可利用已采纳文案做上下文增强。

---

## 6. 可直接用于简历的成果表述

1. 实现可取消/可重试的 SSE 流式文案生成链路，显著提升 AI 交互实时性。
2. 将同步 LLM 调用改造为 Redis + BullMQ 异步任务架构，提升并发稳定性与容错能力。
3. 搭建 Campaign 级批量文案生产能力，支持百商品级别批处理与失败子任务重跑。
4. 从 0 落地运营指标看板，打通生成效率、成功率、采纳率与耗时闭环。
5. 设计 AI 内容安全护栏与采纳样本记忆增强，提高内容合规性与业务贴合度。

---

## 7. 主要风险与兜底方案

风险 1：Redis/BullMQ 接入进度不及预期  
兜底：先保持统一 queue interface，短期以内存队列替代，接口不变。

风险 2：上游模型流式稳定性不足  
兜底：降级为伪流（chunk 分发 + 最终合并），保持前端协议不变。

风险 3：批量导出在大数据量下变慢  
兜底：改为异步导出任务，生成可下载文件链接。
