# Chat 模块 Function Calling 实施计划书

## 1. 文档目标

本文档面向实施阶段，指导 Chat 模块接入 OpenAI Responses API Function Calling 能力：将现有三个 Specialist Agent（`resumeDiagnosisAgent` / `interviewCoachAgent` / `careerPlannerAgent`）的模板化规则回复，升级为 LLM 驱动的工具调用循环（tool loop），并注册 `web_search` 与 `web_browser` 两个联网工具。

本计划书不展开具体代码实现，重点回答：

- 先做什么，后做什么
- 每个阶段交付什么
- 与现有 LLM 客户端、工具注册表、SSE 事件流如何衔接
- 安全边界如何约束
- 如何定义验收、风险与上线边界

## 2. 建设目标

本期目标是将 Chat 模块从「关键词路由 + 硬编码模板回复」升级为「模型自主判断 + 工具调用 + 多轮续接」的 Agent 链路，并满足：

- 三个 Agent 统一接入同一套 tool loop 机制，模型自主决定是否调用工具（`tool_choice: auto`）
- 注册且仅注册 `web_search`、`web_browser` 两个工具，本期不扩展其他工具
- `web_search` 本期先以 Mock 实现跑通全链路，真实搜索服务商后接，不阻塞交付
- `web_browser` 复用现有 pdf-export 的 Playwright 浏览器实例管理，不重复建设浏览器资源
- 工具调用具备明确的安全边界（协议白名单、SSRF 防护、内容与超时限制）
- 工具调用进度继续沿用现有 SSE `tool.call.started` / `tool.call.finished` 事件与 `tool_call_log` 落库

## 3. 范围定义

### 3.1 本期范围

- 三个 Specialist Agent 统一接入 `OpenAiAgentClient.runWithTools` 多轮 tool loop
- 新增 `web_search` 工具：定义 zod schema、executor 接口与 Mock 实现，返回搜索结果列表（title / url / snippet），契约对齐现有 `WEB_SEARCH_TOOL`
- 新增 `web_browser` 工具：输入 URL，输出页面标题与截断后的正文文本，复用 pdf-export Playwright 浏览器实例
- 通过公共层 `ToolRegistry`（`common/llm`）注册两个工具，供 `toOpenAiTools()` 转换 function 参数
- 安全边界：http/https 白名单、SSRF 防护（内网/保留地址拦截）、正文大小上限、抓取超时、重定向复检
- 现有 SSE 事件、`tool_call_log` 落库、记忆层写入保持贯通

### 3.2 非本期重点

- 接入真实搜索服务商（Tavily / Bing / 百度等）与对应 API key 管理
- 工具调用频率限制、用户级配额与计费控制
- 不同 Agent 使用不同工具集（本期三个 Agent 统一挂同一套工具）
- 完整对话历史以消息数组传入模型（本期仅传当前用户消息 + 上下文摘要）
- 抓取页面正文的语义化清洗、去广告、结构化抽取
- 搜索缓存与结果去重
- 复杂工具编排（如搜索后自动抓取首个结果）

## 4. 前置条件与依赖

### 4.1 已具备的资产（直接复用）

| 资产 | 位置 | 作用 |
| --- | --- | --- |
| `OpenAiAgentClient` | `apps/api/src/common/llm/openai-agent.client.ts` | Responses API 通用 tool loop：`tool_choice: auto`、多轮续接、错误回填、maxSteps、工具 trace |
| `ToolRegistry` + `ToolDefinition` | `apps/api/src/common/llm/tool-registry.ts`、`tool.definition.ts` | zod schema 单一来源 → OpenAI function 参数转换，支持 strict 模式与重名校验 |
| `WEB_SEARCH_TOOL` 契约 | `apps/api/src/resume/web-search-tool.interface.ts` | `WebSearchTool.search(query, signal)` → `{ title, url, snippet }[]` |
| Playwright 浏览器管理 | `apps/api/src/pdf-export/browser-launcher.ts`、`browser-instance-manager.service.ts` | 已有浏览器进程/会话管理（含信号量、超时） |
| SSE 工具事件 | `apps/api/src/chat/chat.service.ts` | `tool.call.started` / `tool.call.finished` 事件流 |
| 工具日志 | `apps/api/src/agent/tool-call-log.service.ts` | `tool_call_log` 落库 |
| 上下文构建 | `apps/api/src/memory/context-budget-manager.service.ts`、`resume-context.service.ts` | 组装 context pack 与简历上下文，用于构建 system prompt |

### 4.2 环境前提

- 已配置 `OPENAI_API_KEY`；若使用中转 `OPENAI_BASE_URL`，需确认该端点兼容 Responses API 的 function calling（见风险 10.1）
- `OPENAI_STRICT_SCHEMA` 默认关闭；两个工具 schema 均按非 strict 可运行、strict 兼容设计（必填字段已明确）

## 5. 总体方案

### 5.1 架构

```
User Message
   │
   ▼
ChatService.executeMessageFlow ──► OrchestratorService（路由不变）
   │
   ▼
AgentExecutorService.execute（三个 Agent 分支，逻辑替换）
   │  不再走模板回复，改为：
   │  1. 组装 instructions（Agent 提示词 + resumeContext + contextPack 摘要 + 显示偏好）
   │  2. tools = ToolRegistry.toOpenAiTools(strict)
   │  3. OpenAiAgentClient.runWithTools({ instructions, input: 用户消息, tools, execute })
   │  4. execute 回调 → ChatWebToolExecutor → web_search / web_browser
   │
   ▼
OpenAiAgentClient（tool loop，多轮直至模型不再请求工具 / maxSteps）
   │  每步 function_call → execute → function_call_output 回填
   ▼
web_search（Mock）        web_browser（复用 Playwright 实例）
   │                        │
   └──── ToolResult（{ ok, data | error }）回填给模型
```

### 5.2 数据流（一次工具调用）

1. 模型输出 `function_call`（`web_search` 或 `web_browser`）
2. `ToolRegistry.validateArguments` 按 zod schema 校验参数，失败回填 `{ ok:false, error }`
3. executor 执行：`web_search` 走 `WebSearchTool` 实现；`web_browser` 走浏览器正文提取
4. 结果以 `{ ok:true, data }` / `{ ok:false, error }` 包装，经 `function_call_output` 续接回模型
5. 工具进度通过 `toolProgress.onToolStart/onToolDone` 上报现有 SSE 事件，并写入 `tool_call_log`

## 6. 核心设计决策

### 6.1 工具定义

| 工具名 | 入参（zod） | 出参 | 说明 |
| --- | --- | --- | --- |
| `web_search` | `{ query: string, maxResults?: number }` | `{ results: { title, url, snippet }[] }` | 搜索关键词，返回结构化结果列表；契约对齐 `WebSearchResult` |
| `web_browser` | `{ url: string }` | `{ title: string, content: string }` | 抓取单页，正文截断（默认上限见 7.4），供模型阅读页面内容 |

工具描述（description）需明确触发边界：`web_search` 用于获取最新资讯、行业动态、外部事实；`web_browser` 仅在需要阅读具体网页正文时使用，避免模型滥用。

### 6.2 注册与注入

- 新增 `ChatWebToolModule`（或扩展 `tool` 目录），在 `onModuleInit` 中向公共层 `ToolRegistry` 注册两个 `ToolDefinition`
- executor 通过 NestJS DI 注入：`WebSearchTool`（Mock 实现）与浏览器正文提取服务
- `AgentExecutorService` 从 `ToolRegistry.list()/toOpenAiTools()` 获取工具集，三个 Agent 统一使用

### 6.3 Agent 指令构建

- instructions = Agent 专属 system 提示词（沿用现有三个 Agent 的职责定位）+ resume 上下文前缀（复用 `buildResumeContextPrefix` 等既有方法）+ context pack 摘要 + 显示偏好
- input = 当前用户消息（本期不传完整历史数组；历史摘要已含在 resumeContext 中）
- 保持现有 `assistantText` / `toolCalls` 返回结构与 ChatService 的 SSE 落库逻辑不变

### 6.4 web_search Mock 实现

- 实现 `WebSearchTool` 接口，返回固定结果集（如预设 2~3 条 `{ title, url, snippet }`）
- 目的：跑通「模型判断 → 调工具 → 工具结果回填 → 最终回复」全链路，验证 schema、事件、落库
- 真实服务商接入时仅替换实现（同 DI token），不影响上层

### 6.5 web_browser 浏览器复用

- 复用 pdf-export 的浏览器实例/会话管理（含信号量与超时机制）
- 新增轻量「打开 URL → 提取 `title` + 正文文本（去脚本/样式）→ 截断」能力
- 不新增独立浏览器生命周期管理

## 7. 安全边界（本期强制）

### 7.1 协议白名单

- 仅允许 `http:` / `https:`，其余协议（`file:`、`ftp:`、`javascript:`、`data:` 等）直接拒绝

### 7.2 SSRF 防护

- 解析 URL 后校验主机名与解析出的 IP：拒绝本地回环（`127.0.0.1`、`::1`、`localhost`）、内网段（`10.x`、`172.16~31.x`、`192.168.x`）、链路本地（`169.254.x`）、`0.0.0.0` 等
- 重定向后重新执行同一套校验（防 DNS rebinding / 重定向绕过）
- 校验失败回填 `{ ok:false, error: 'web_browser_invalid_url' }`，不抛出未捕获异常

### 7.3 请求约束

- URL 长度上限（如 2048 字符）
- 单页抓取超时（建议 10s，纳入 `withTimeout` 收敛）
- 结果内容大小上限：正文截断（建议 16KB，超出部分丢弃并标记 `truncated: true`）

### 7.4 限额（默认值）

- `maxSteps` 沿用 `OpenAiAgentClient` 默认 5，多轮循环存在明确上限，避免死循环

## 8. 任务拆分与交付物

### Phase 1：工具定义与注册（不依赖模型）

- [ ] 定义 `web_search` / `web_browser` 的 zod schema 与 ToolDefinition（含描述与触发边界）
- [ ] 注册到公共层 `ToolRegistry`（重名校验、`toOpenAiTools` 转换验证）
- [ ] 单测：schema 校验、`toOpenAiTools` 输出符合 Responses API 结构（strict 开/关）

### Phase 2：executor 与安全边界

- [ ] 实现 `WebSearchTool` Mock 实现并绑定 DI
- [ ] 实现 `web_browser` 正文提取（复用 pdf-export 浏览器实例）
- [ ] 实现协议白名单 + SSRF 校验 + 重定向复检 + 内容截断 + 超时
- [ ] 单测：非法协议、内网 IP、重定向绕过、超时、超大正文截断

### Phase 3：Agent 接入 tool loop

- [ ] `AgentExecutorService` 三个分支改为调用 `runWithTools`（保留返回结构）
- [ ] 组装 instructions（Agent 提示词 + resumeContext + contextPack 摘要 + 显示偏好）
- [ ] `execute` 回调路由到 web 工具 executor；`toolProgress` 保持现有 SSE 事件上报
- [ ] 单测：工具未命中时回填错误、多轮 loop 收敛、assistant 文本含工具结果

### Phase 4：端到端验证与回归

- [ ] Chat SSE 端到端：发起需联网的问题，观察 `tool.call.started/finished` 事件与最终回复
- [ ] 三个 Agent 回归：简历诊断 / 面试指导 / 职业规划仍正常回复
- [ ] `tool_call_log` 落库与记忆层写入验证

## 9. 验收标准

- 三个 Agent 均可触发 `web_search` / `web_browser`，模型自主决策且循环收敛（maxSteps 内结束）
- 工具参数非法时模型收到 `{ ok:false, error }` 并继续正常回复，不中断链路
- 安全校验生效：非法协议、内网地址、重定向到内网均被拦截并回填错误
- SSE 事件、`tool_call_log`、记忆层贯通，与现有非工具调用路径行为一致
- 全部新增单测通过，现有 `chat` / `agent` / `llm` 相关单测无回归

## 10. 风险与缓解

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| 10.1 | 中转 `OPENAI_BASE_URL` 不支持 Responses API function calling | tool loop 不可用 | 前置做一次连通性验证；不兼容时回退到 Chat Completions 层（tool loop 逻辑收敛在客户端，可替换实现） |
| 10.2 | `OPENAI_STRICT_SCHEMA` 开启后 schema 不满足 strict 要求 | 模型报错 | 工具 schema 按 strict 兼容设计（必填字段明确）；`ToolRegistry` 已处理 `required` / `additionalProperties` |
| 10.3 | 多轮 loop 增加延迟与 token 消耗 | 用户体验与成本 | 控制 maxSteps；本期成本边界不设用户级配额，风险随真实服务商接入一并处理 |
| 10.4 | pdf-export 浏览器实例被高频 web_browser 占用（信号量排队） | 抓取延迟/超时 | 复用既有信号量；将超时纳入回填错误；真实接入阶段再评估独立实例 |
| 10.5 | Mock 搜索无真实数据，模型可能"编造"外部事实 | 回复可信度 | 工具描述与 Agent 提示词明确「Mock 阶段结果不可作为真实依据」；真实服务商接入前控制联网场景 |
| 10.6 | 模型滥用工具（无关问题也搜索/抓取） | 浪费与错误 | 通过工具 description 明确触发边界；可观测事件便于复盘调优 |
