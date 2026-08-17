# Agent Loop 与 Function Calling 面试问答手册

> 适用代码路径：
> - `apps/api/src/common/llm`（Agent tool loop 客户端、ToolRegistry、LLM 配置）
> - `apps/api/src/chat/tools`（web_search / web_browser 联网工具）
> - `apps/api/src/agent`（Agent 编排：AgentExecutorService、AgentConfigRegistry）
>
> 背诵策略：先背「一句话答案」，再背「要点序号」，最后补「代码位置」。面试时按 结论 → 要点 → 举例 的结构作答。

---

## 一、Function Calling 核心机制

### Q1. 为什么选 OpenAI Responses API，而不是 Chat Completions + function calling？

**一句话答案**：Responses API 提供 `previous_response_id` 增量续接和 `function_call_output` 结构化回填，比手动拼 messages 数组更简单、更不易错。

**要点**：
1. `previous_response_id` 续接：服务端自动保留前文上下文，不用重复传历史 → 省 token、省上下文窗口。
2. `function_call_output` 以独立 item 回填，结构清晰。
3. SDK 类型完备，`ResponseFunctionToolCall` 可直接过滤。
4. 兼容性反面：Chat Completions 更通用，中转/代理服务（`OPENAI_BASE_URL`）可能只支持 chat completions。

---

### Q2. 模型返回 function_call 后，如何续接对话？

**一句话答案**：用 `previous_response_id` + `function_call_output` 增量续接，不发完整历史。

**要点**：
1. 首轮 `create({ input: 用户文本, tools })` 得到 `response.id`。
2. 后续轮次带 `previous_response_id: response.id`，`input` 只放 `function_call_output` 数组。
3. 每轮都传 `instructions` 和完整 `tools`。

**代码位置**：`openai-agent.client.ts` 的 `createResponse`（`previousResponseId` 条件展开）。

---

### Q3. `tool_choice: 'auto'` 是什么？想让模型必须调用工具怎么改？

**一句话答案**：auto 是模型自主决定是否调用工具；必须调用则用 `required` 或指定具体工具。

**要点**：
- `tool_choice` 可选：`auto` / `required` / `none` / `{type:'function', name:'xxx'}`。
- 本项目统一用 `auto`，让模型自行判断（联网工具不是每问必用）。

---

### Q4. 一轮返回多个 function_call，你的代码是并发还是串行执行？为什么？

**一句话答案**：当前串行执行，保证结果顺序与调用顺序一致。

**要点**：
1. 当前实现：`for` 循环逐个执行、逐个 push `function_call_output`（见 `runWithTools` 的 outputs 循环）。
2. 串行的好处：顺序确定、trace 顺序与 call 顺序对应、避免并发写状态。
3. 可扩展：独立工具可 `Promise.all` 并行，但要处理结果顺序与 trace 顺序。

---

### Q5. 工具 arguments 是字符串，如何解析？空参数 / 非法 JSON 怎么办？

**一句话答案**：分两种模式——多轮 loop 解析失败回填给模型；stopOnToolCall 直接抛错给上层。

**要点**（`parseCallArguments` 两个分支）：
1. 多轮 loop（strict=false）：空/非法 JSON 返回 `null`，由 `safeExecute` 回填 `{ok:false, error:'invalid_json_arguments'}`，不中断 loop。
2. stopOnToolCall（strict=true）：空抛 `openai_empty_arguments`，非法 JSON 抛 `openai_invalid_arguments`，由上层走 fallback（如 JD 解析降级）。

---

### Q6. 工具执行抛异常会中断 Agent loop 吗？为什么？

**一句话答案**：不中断——错误包装成 `{ok:false, error}` 回填给模型，让模型自愈。

**要点**：
1. `safeExecute` 捕获所有异常 → `{ok:false, error: message}`。
2. 该结果作为 `function_call_output` 回填模型，模型可修正参数重试、换工具或放弃。
3. LLM 是不可控依赖，工具失败不应击穿主链路 → 这是 Agent 自愈（self-correction）的核心设计。

---

### Q7. `maxSteps` 的作用？达到上限会发生什么？成本风险？

**一句话答案**：防死循环 + 控制调用次数；达到上限抛 `openai_agent_max_steps_5`。

**要点**：
1. 默认 5 轮，每轮一次 API 调用。
2. 达上限抛错说明模型一直在请求工具，可能是指令或工具定义引导问题。
3. 成本/延迟：N 轮 = N 次调用，单次超时 `timeoutMs`（20s），最坏总耗时 N×timeout，需要 maxSteps 兜底。

---

## 二、ToolRegistry 与 zod 单一来源设计

### Q8. 为什么用 zod 作为工具 schema 单一来源？

**一句话答案**：一份 schema 两用——运行时参数校验 + 转成 OpenAI parameters，避免双份维护漂移。

**要点**：
1. `ToolDefinition.inputSchema: z.ZodTypeAny`（`tool.definition.ts`）。
2. `validateArguments` 做运行时校验，失败统一抛 `openai_invalid_arguments`。
3. `z.toJSONSchema` 转 OpenAI `parameters` 发给模型。
4. `z.infer` 推导 TS 类型，类型安全。

---

### Q9. `deepRequireAll` 做了什么？为什么需要它？

**一句话答案**：递归给所有 object 节点补 `required=全部属性` + `additionalProperties:false`，满足 OpenAI strict schema 要求。

**要点**：
1. strict 模式要求：所有字段必填、禁止额外字段。
2. 入参先 `structuredClone` 深拷贝，避免原地改写共享 base schema。
3. 代价：可选字段变必填，语义要接受；strict 开启后模型输出强保证符合 schema。

---

### Q10. 工具重名为什么直接抛错而不是覆盖？

**一句话答案**：fail-fast——重名覆盖会导致不可预期的运行期 bug，启动期暴露更安全。

**要点**：
- 模块 A 的定义被 B 静默覆盖 → 行为不可预期。
- 抛 `tool_already_registered` 让问题在启动期暴露。

---

### Q11. executor 为什么只做查表分发，不写 switch 路由？

**一句话答案**：开放封闭原则——新增工具不改分发逻辑，只注册定义 + executor。

**要点**：
1. `ToolRegistry.getExecutor(name)` 查表分发，未注册抛 `tool_not_registered`。
2. 公共层（ToolRegistry）不反向依赖业务模块，依赖方向：业务 → registry。

---

### Q12. `toOpenAiTools({ names })` 按名字裁剪工具集的动机？

**一句话答案**：Agent 间工具隔离——不同 Agent 只暴露自己该用的工具。

**要点**：
1. 如 Chat 三个 Agent 只暴露 `web_search` / `web_browser`，不暴露 JD 工具。
2. 减少 tools 体积，防止模型调用不该用的工具。

---

## 三、Agent Loop 架构与编排

### Q13. 你的 Agent 编排属于哪种模式？

**一句话答案**：Router（意图路由）→ 单 Agent 的 ReAct 风格 tool loop。

**要点**：
1. `OrchestratorService.decideNextAgent` 先路由到三个 Specialist Agent 之一。
2. Agent 内部是 ReAct：思考 → 调用工具 → 观察结果 → 继续，直到不再请求工具。
3. 可扩展：多 Agent 协作 Graph、并行子 Agent。

---

### Q14. `stopOnToolCall` 单轮模式 vs 完整多轮 loop，各自适用场景？

**一句话答案**：单轮用于"只要工具输出"的任务；多轮用于"要基于工具结果生成回答"的任务。

**要点**：
1. 单轮（JD 解析/重写）：拿到 tool arguments 即返回，省一次调用、降延迟。
2. 多轮（Chat 联网问答）：模型基于工具结果生成最终文本。

---

### Q15. 三个 Agent 为什么用 `AgentConfigRegistry` 配置驱动，不硬编码 switch？

**一句话答案**：注册表模式——新增 Agent 只加一条配置，执行逻辑零改动。

**要点**：
- `AgentConfig = { id, systemPrompt, toolNames }`，工具名由配置注入。
- `register` 重名抛 `agent_already_registered`，同样 fail-fast。

---

### Q16. 简历上下文 / 显示偏好 / 历史摘要如何注入 Agent？

**一句话答案**：拼进 instructions 的 system 提示词前缀。

**要点**：
1. `buildInstructions` = systemPrompt + 简历上下文前缀（简历摘要、显示偏好、对话历史摘要）。
2. 让模型回答贴合用户简历与偏好。
3. 关联：`ContextBudgetManagerService` 用 token 预算（4000 + 预留 500）做记忆选择/丢弃/摘要。

---

### Q17. 超长历史 / token 超预算怎么处理？

**一句话答案**：context pack 在 token 预算内做记忆选择、丢弃和摘要块。

**要点**：
1. `CHAT_CONTEXT_PACK_MAX_TOKENS = 4000`，`reservedTokens = 500`（覆盖系统提示词固定开销）。
2. 历史摘要刷新 best-effort，失败不阻断回复。

---

## 四、安全边界（联网工具）

### Q18. 做了哪些 SSRF 防护？

**一句话答案**：协议白名单 + IP 黑名单 + DNS 解析校验 + IPv4-mapped IPv6 归一化 + 重定向复检。

**要点**（`web-url-security.util.ts`）：
1. 协议白名单：仅 http/https。
2. 直接 IP：回环/内网/链路本地/CGNAT（100.64.0.0/10）/ULA 黑名单。
3. 域名：DNS 解析后校验**所有**解析结果，任一内网即拒绝。
4. `::ffff:a.b.c.d` 归一化后再判定（面试高频细节）。
5. 重定向复检：`goto` 后 finalUrl 不一致重新走校验，防 302 跳内网绕过。

---

### Q19. DNS rebinding 怎么防？只解析校验够吗？

**一句话答案**：不够——解析到连接之间存在 TTL 窗口，DNS 可能变化。

**要点**：
1. 当前是"抓取前"校验，存在解析时安全、连接时指向内网的窗口。
2. 更严格方案：自定义 socket 层固定 IP 连接（拦截 DNS 自行建连）、或浏览器实例隔离 + 校验最终 URL（重定向复检属于其中一环）。
3. 面试时主动承认局限 + 给改进方向，比吹满强。

---

### Q20. web_browser 抓取做了哪些资源保护？

**一句话答案**：整体超时 + AbortSignal 取消 + 内容截断 + 受管并发。

**要点**：
1. 单页 10s 超时，`withTimeout` 包裹每个操作。
2. 正文 16KB 截断 + `truncated` 标记。
3. 复用 `BrowserInstanceManagerService`（信号量 + 会话租约），受管并发。

---

### Q21. `withTimeout` 为什么同时处理 timer 和 AbortSignal？

**一句话答案**：竞态下必须清理资源，避免重复 resolve/reject 和监听器泄漏。

**要点**：
1. cleanup = clearTimeout + removeEventListener。
2. 先判 `signal.aborted` 再监听，避免竞态双 reject。
3. resolve/reject 只触发一次。

---

## 五、错误处理与可观测性

### Q22. 错误码为什么统一 `openai_*` 前缀？

**一句话答案**：上层 fallback / strict 分支用同一套错误码判断。

**要点**（`mapOpenAiError`）：
1. 映射：`APIUserAbortError` → aborted；超时 → `openai_timeout_20s`；限流 → `openai_http_429:rate_limit`；鉴权 → `openai_http_401:authentication`；连接失败 → `openai_connection_failed`。
2. 非 APIError 透传原 error。

---

### Q23. `onToolStart` / `onToolDone` / toolTrace 观测设计解决了什么？

**一句话答案**：Agent 可观测性——前端实时事件 + span 追踪 + 审计落库。

**要点**：
1. 前端 SSE 事件：`tool.call.started / tool.call.finished`，带 spanId 构建时间线。
2. `toolTrace` 记录 step/name/arguments/result/latencyMs → 回填 `toolCalls` 摘要。
3. `ToolCallLogService` 异步落库审计日志，失败仅告警不阻断 loop。

---

### Q24. 并发工具调用时，span 怎么匹配 start/finish？

**一句话答案**：按 toolName 的 FIFO 队列配对，队列空时兜底生成新 span。

**要点**：
1. `pendingToolSpans` Map<toolName, spanQueue>，finish 时 shift 最早未结束的 span。
2. 局限：`onToolDone` 回调不携带 callId，只能按队列配对。
3. 诚实说明局限 + 改进：让回调携带 callId 精确配对。

---

### Q25. SSE 断线续传怎么实现？

**一句话答案**：事件带 seq 序号 + 会话按 streamKey 复用 + sinceSeq 增量补发。

**要点**：
1. `ReplayableSseSessionStore` 以 streamKey 存会话，重连时订阅既有会话。
2. 客户端传 `sinceSeq`，服务端从该序号后补发。
3. 事件同时异步落库 observability，失败仅告警。

---

## 六、抽象与扩展性

### Q26. LlmModule 为什么用 useFactory 显式构造，不直接标 @Injectable()？

**一句话答案**：构造函数带默认参数，标 @Injectable() 会被 Nest 当作 DI 依赖解析而失败。

**要点**：
- `config = loadOpenAiLlmConfig()` 是默认参数，不是 DI 依赖。
- useFactory 明确构造路径，避免被 Nest 隐式实例化。

---

### Q27. 换成 Claude / 通义 / 本地模型，要改哪些地方？

**一句话答案**：业务层已解耦（接口），但 Agent loop 客户端与 Responses API 强绑定。

**要点**：
1. JD 链路：`JdLlmParserClient` / `JdLlmRewriterClient` 是接口，换 provider 只加新实现。
2. Agent 链路：`OpenAiAgentClient` 强绑 `previous_response_id` / `ResponseInputItem`，需抽象统一 `AgentClient` 接口。
3. `ToolRegistry.toOpenAiTools` 输出是 OpenAI 特定格式。

---

### Q28. 工具定义（definition）和执行函数（executor）为什么分开注册？

**一句话答案**：定义是给模型的契约，executor 是给系统的实现，关注点分离。

**要点**：
- 可只注册定义不注册 executor（stopOnToolCall 场景不需要执行）。
- 也可只注册 executor 做分发。

---

## 七、性能与扩展追问

### Q29. 流式输出为什么是"模拟"的（80 字符切片）？

**一句话答案**：当前 runWithTools 整段返回后切片模拟打字机，未接真实 token 流——是明确演进方向。

**要点**：
1. `emitAssistantTextChunks` 按 80 字符切片发 `assistant_chunk`。
2. 真实流式需 `stream:true` 接 Responses API 流事件，并过滤工具调用阶段事件。

---

### Q30. 每轮重复传完整 tools 数组，有优化空间吗？

**一句话答案**：有——tools 变化才重传，或服务端缓存工具 schema。

---

### Q31. 模型连续调用工具导致超时，能提前熔断吗？

**一句话答案**：maxSteps + 单次超时兜底；可加熔断器、工具级预算、限流。

**要点**：
- 熔断器：连续失败次数达阈值熔断。
- 工具级预算：如每轮最多 N 次联网。
- SDK 侧 `maxRetries: 2` 控制重试。

---

## 八、高频追问链速记（面试节奏）

| 追问方向 | 先答什么 | 再补什么 | 代码锚点 |
|---|---|---|---|
| 为什么用 Responses API | previous_response_id 增量续接 | 省 token、类型完备、中转兼容性反面 | `createResponse` |
| 工具失败怎么办 | 回填 `{ok:false,error}` 不中断 | 模型自愈、LLM 不可控依赖 | `safeExecute` |
| 为什么用 zod | 单一来源两用 | 避免漂移、类型推导 | `tool.definition.ts` |
| strict 模式做了什么 | 全字段 required + 禁额外字段 | structuredClone 防原地改写 | `deepRequireAll` |
| 有哪些安全边界 | 协议白名单 + IP 黑名单 + DNS + 重定向复检 | IPv4-mapped IPv6、DNS rebinding 局限 | `web-url-security.util.ts` |
| 超时怎么做 | withTimeout + AbortSignal | cleanup 防泄漏、竞态双 reject | `web-browser-tool.service.ts` |
| 怎么观测 Agent | SSE 事件 + span + toolTrace + 审计落库 | FIFO 队列配对的局限 | `chat.service.ts` / `tool-call-log.service.ts` |

---

## 九、可量化的数字（背诵用）

- 默认模型：`gpt-4o-mini`
- 单次请求超时：20s（`OPENAI_TIMEOUT_MS`）
- SDK 重试：`maxRetries: 2`
- Agent loop 最大轮数：5（`DEFAULT_MAX_STEPS` / `DEFAULT_CHAT_AGENT_MAX_STEPS`）
- web_browser 单页超时：10s；正文截断：16KB
- ContextPack token 预算：4000，预留 500
- 工具数：web_search / web_browser 两个联网工具 + parse_jd / rewrite_jd 两个 JD 工具
- 错误码前缀：`openai_*`（tool 类：`tool_not_registered` / `openai_invalid_arguments` / `openai_no_tool_call` / `openai_agent_max_steps_N`）
