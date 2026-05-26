# SYSTEM_DESIGN.md

## 1. 架构概览

- 前端（Nuxt）：简历信息录入、生成结果展示、后续优化入口
- 后端（NestJS）：认证、简历生成、历史版本（后续）
- 数据层（SQLite/PostgreSQL + Prisma）：任务与结果持久化
- AI 服务（OpenAI API）：文本生成、结构化解析、质量评估

## 2. 关键模块

- Auth Module：登录与会话管理
- Resume Module（Primary）：简历生成与后续优化
- Resume Stream Module（Planned）：简历流式生成通道
- Metrics Module（Planned）：生成质量与耗时统计

## 3. 主流程（MVP V1）

1. 用户登录
2. 录入简历基础信息与目标岗位
3. 发起 `resume/generate` 请求
4. 后端调用 LLM 生成结构化简历
5. 返回可直接渲染的数据结构
6. 失败时返回可重试错误信息

## 4. 错误处理

- 输入非法：`VALIDATION_ERROR`
- 模型超时：`LLM_TIMEOUT`
- 调用受限：`RATE_LIMITED`
- 服务异常：`INTERNAL_ERROR`

## 5. 演进路线

- Phase 1：文档改造 + `resume/generate` 最小闭环
- Phase 2：SSE 流式简历生成 + 简历版本持久化
- Phase 3：评分优化、异步化、可观测与评测集
