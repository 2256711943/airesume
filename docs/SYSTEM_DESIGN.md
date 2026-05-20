# SYSTEM_DESIGN.md

## 1. 架构概览

- 前端（Nuxt）：工作台、商品录入、流式生成展示、评分与改写交互、看板
- 后端（NestJS）：认证、商品管理、文案生成、评分、改写、采纳、指标
- 数据层（PostgreSQL + Prisma）：业务数据持久化
- AI 服务（OpenAI API）：文本生成与评分

## 2. 关键模块

- Auth Module：登录与会话管理
- Product Module：商品录入、查询、CSV 导入
- Copy Module：生成、评分、改写、采纳
- Stream Module：SSE 事件通道
- Metrics Module：统计聚合

## 3. 主流程（MVP）

1. 用户登录
2. 创建商品或导入 CSV
3. 发起生成请求（SSE）
4. 前端接收 chunk 实时渲染
5. 完成后落库版本结果
6. 调用评分接口生成维度评分
7. 按低分维度触发改写
8. 用户采纳版本并写入反馈

## 4. 错误处理

- 输入非法：`VALIDATION_ERROR`
- 模型超时：`LLM_TIMEOUT`
- 调用受限：`RATE_LIMITED`
- 服务异常：`INTERNAL_ERROR`

## 5. 演进路线

- Phase 1：同步生成 + SSE
- Phase 2：用户体系与看板完善
- Phase 3：接入 Redis + BullMQ 异步化
