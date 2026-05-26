# AI 简历助手（AI Resume Assistant）

一个面向求职场景的 AI 助手项目。  
当前已完成主链路收敛，保留“登录 + AI 流式简历生成”最小闭环。

## 1. 当前阶段目标

- 4-6 周内完成简历助手 MVP
- V1 优先交付：结构化简历生成
- 采用“先文档、后代码；先小改、后大改”的渐进式重构策略

## 2. 技术栈（当前）

- 前端：Nuxt + TypeScript + Tailwind + Naive UI + ECharts
- 后端：NestJS + TypeScript + Swagger(OpenAPI)
- 数据：SQLite（开发）+ Prisma
- 缓存/队列（后续阶段）：Redis + BullMQ
- AI：OpenAI API
- 协议：HTTP + SSE（流式通道）

## 3. 文档入口

- 文档索引：[DOC_INDEX.md](./docs/DOC_INDEX.md)
- 产品需求：[PRD.md](./docs/PRD.md)
- 架构设计：[SYSTEM_DESIGN.md](./docs/SYSTEM_DESIGN.md)
- 接口契约：[OPENAPI.yaml](./docs/OPENAPI.yaml)
- SSE 协议：[API_STREAM_SPEC.md](./docs/API_STREAM_SPEC.md)
- 数据模型：[DB_SCHEMA.md](./docs/DB_SCHEMA.md)
- AI 规范：[AI_SPEC.md](./docs/AI_SPEC.md)
- 评估规范：[EVAL_SPEC.md](./docs/EVAL_SPEC.md)
- 测试计划：[TEST_PLAN.md](./docs/TEST_PLAN.md)

## 4. 当前能力

1. JWT 登录与鉴权
2. `POST /resume/generate` 非流式简历生成
3. `GET /resume/generate/stream` SSE 流式简历生成
4. 前端 `/resume` 页面实时渲染生成结果
