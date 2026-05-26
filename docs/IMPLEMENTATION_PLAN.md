# IMPLEMENTATION_PLAN.md

## Phase 1（第1-2周）：文档先行 + 最小可用

- 文档重构：PRD / SYSTEM_DESIGN / OPENAPI / STREAM / DB_SCHEMA
- 新增 `resume/generate`（非流式）接口
- 前端新增简历生成页面（最小表单 + 结果渲染）
- 复用现有鉴权与统一响应结构

交付物：

- 可演示“输入简历信息 -> 输出结构化简历”的闭环

## Phase 2（第3-4周）：生成体验增强

- `resume/generate/stream` SSE 流式生成
- 简历版本管理与历史记录
- 针对目标岗位的定向优化接口
- 失败重试与中断恢复体验

交付物：

- 可讲“实时生成体验 + 版本演进”的版本

## Phase 3（第5-6周）：工程化升级

- 接入 Redis + BullMQ（生成/优化异步化）
- 请求链路可观测（Langfuse）
- 错误归因报表
- 评测集与回归评估

交付物：

- 可讲系统稳定性与工程深度的版本
