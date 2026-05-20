# AI运营内容助手（电商营销文案）

一个面向电商运营场景的 AI 内容助手项目。  
目标是完成可演示、可复现、可讲技术深度的全栈 AI 应用：

- 商品信息录入（手动 + CSV）
- 营销文案多版本生成（SSE 流式）
- 文案质量评估（规则 + LLM）
- 一键定向改写
- 版本对比与人工采纳反馈

## 1. 项目目标

- 4-6 周内完成 MVP
- 优先实现简历可展示技术点
- 先不接入真实电商开放 API，使用手动数据与 CSV

## 2. 技术栈（定版）

- 前端：Nuxt + TypeScript + Tailwind + Naive UI + ECharts
- 后端：NestJS + TypeScript + Swagger(OpenAPI)
- 数据：PostgreSQL + Prisma
- 缓存/队列（后续阶段）：Redis + BullMQ
- AI：OpenAI API
- 协议：HTTP + SSE（主通道）

## 3. 文档入口

- 执行章程：[AGENT.md](./AGENT.md)
- 代码规范：[CODE_STYLE.md](./CODE_STYLE.md)
- 产品需求：[PRD.md](./PRD.md)
- 架构设计：[SYSTEM_DESIGN.md](./SYSTEM_DESIGN.md)
- 接口契约：[OPENAPI.yaml](./OPENAPI.yaml)
- SSE 协议：[API_STREAM_SPEC.md](./API_STREAM_SPEC.md)
- 数据模型：[DB_SCHEMA.md](./DB_SCHEMA.md)
- AI 规范：[AI_SPEC.md](./AI_SPEC.md)
- 评估规范：[EVAL_SPEC.md](./EVAL_SPEC.md)
- 测试计划：[TEST_PLAN.md](./TEST_PLAN.md)
- AI 编码约束：[AI_CODING_RULES.md](./AI_CODING_RULES.md)

## 4. 开发阶段

1. Phase 1：闭环可用（录入 -> 生成 -> 评分 -> 改写）
2. Phase 2：产品化增强（登录、看板、采纳反馈）
3. Phase 3：工程化增强（异步队列、可观测、回归评估）

## 5. MVP 验收基线

- 至少 20 条样本商品可稳定跑通全流程
- 结构化输出成功率 >= 95%
- 3 个版本生成 P95 < 15s（本地正常网络）
