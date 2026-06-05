实施阶段
1. Phase 1：数据层
  ○ 增加 Prisma schema
  ○ 生成 client
  ○ 初始化 SQLite/Postgres 表
  ○ 验证 CRUD
2. Phase 2：Conversation 模块
  ○ 实现 ConversationService
  ○ 实现消息写入和历史读取
  ○ 实现最近 N 轮上下文拼接
  ○ 预留 summary/memory slot 能力
3. Phase 3：Tool Registry
  ○ 设计统一 tool interface
  ○ 接入 4 个一期工具
  ○ 统一超时、错误码、日志格式
4. Phase 4：Agent 编排
  ○ 实现 OrchestratorAgent
  ○ 实现 3 个 specialist agents
  ○ 路由规则先做“规则优先 + LLM 辅助”
  ○ 每个 agent 输出必须结构化
5. Phase 5：API 与集成
  ○ 增加 POST /chat/message
  ○ 串起 conversation -> orchestrator -> tools -> specialist
  ○ 联调现有 resume/jd 能力
6. Phase 6：日志与验收
  ○ 记录 agent run 和 tool call log
  ○ 验证错误降级
  ○ 补基础测试