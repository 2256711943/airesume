# Agent Workflow + Tool Calling + SSRF 面试追问手册

> 适用代码路径（monorepo `apps/api`）：
>
> - Agent 编排：`apps/api/src/agent`（orchestrator / agent-executor / agent-run / agent.config）
> - LLM 客户端与工具注册：`apps/api/src/common/llm`（openai-agent.client / tool-registry / tool.definition / llm-config）
> - 聊天主流程与 SSE：`apps/api/src/chat`（chat.service / chat.controller / chat-web-tool-executor / web-\*.ts）
> - 简历生成闭环（方案检验的映射）：`apps/api/src/resume`（resume-agent-loop / resume-scorer / jd-parser / resume.service）
>
> 背诵策略：先背「一句话答案」，再背「要点」，关键决策问题补「为什么 + 其它方案」，最后记「代码锚点」。面试按 结论 → 要点 → 举例 作答。
>
> 口径说明：本文档以 **当前最新代码** 为准。与根目录旧文档 `agent-loop-function-calling-interview-qa.md` 的差异已显式标注（核心差异：同一轮多 Tool 已由串行改为 `Promise.all` 并行执行）。

---

## 问题总览（递进逻辑）

| 阶段              | 问题范围 | 核心词                                          |
| ----------------- | -------- | ----------------------------------------------- |
| 整体架构          | Q1–Q5    | 节点划分 / 链路 / 为什么 Workflow               |
| Intent + Router   | Q6–Q10   | 意图识别实现 / LLM vs 规则 / 误判兜底           |
| 多轮 Tool Calling | Q11–Q20  | loop 流程 / 续接 / 失败自愈 / 防死循环          |
| 方案检验          | Q21–Q27  | Planner / Validator / Executor 拆分             |
| Responses API     | Q28–Q33  | previous_response_id / 与 Chat Completions 对比 |
| Tool 设计         | Q34–Q39  | 注册 / 裁剪 / 分发 / 扩展                       |
| Zod 参数校验      | Q40–Q49  | 单一来源 / 运行时安全 / 防绕过                  |
| SSE               | Q50–Q57  | 事件时序 / 并发 / 断线续传                      |
| SSRF              | Q58–Q68  | 协议白名单 / DNS / Rebinding / 重定向复检       |

---

## 一、整体架构

### Q1. 你的 Agent Workflow 整体是怎么设计的？

**一句话答案**：两级结构 —— 上层是「Router（规则路由）→ 单 Specialist Agent」，下层是每个 Agent 内部的「ReAct 式多轮 tool loop」；外围再包「上下文组装（token 预算）」与「SSE 事件上报 / 审计落库」两条横切能力。

**要点**：

1. 上层路由：`OrchestratorService.decideNextAgent()` 把用户消息路由到 `resumeDiagnosisAgent / interviewCoachAgent / careerPlannerAgent` 三者之一，并产出 `intent + selectedAgent + confidence`。
2. Agent 配置化：三个 Agent 各自有 `systemPrompt + toolNames`，用 `AgentConfigRegistry` 注册表驱动（`agent.config.ts`），不是 if/switch 硬编码。
3. 下层执行：`AgentExecutorService` 把「该 Agent 的指令 + 简历上下文 + 裁剪后的工具集」交给 `OpenAiAgentClient.runWithTools()` 跑多轮 loop，直到模型不再请求工具或到 `maxSteps`。
4. 横切能力：
   - 上下文：`ContextBudgetManagerService` 在 4000 token 预算内做记忆选择/丢弃/摘要；
   - 可观测：工具执行通过 `onToolStart / onToolDone` 转成 SSE 事件 + `ToolCallLogService` 异步审计落库；
   - 运行态：`AgentRunService` 把每次 run 落库为状态机（running/succeeded/failed/timeout/canceled/partial_success）。

**代码锚点**：`apps/api/src/agent/orchestrator/orchestrator.service.ts`、`apps/api/src/agent/agent-executor.service.ts`（runAgentLoop）、`apps/api/src/agent/agent.config.ts`。

---

### Q2. Workflow 里有哪些核心节点？它们之间怎么串起来的？

**一句话答案**：路由（Router）→ 上下文组装（Context）→ 执行器（Executor/Loop）→ 结果收口（Persist + SSE），工具节点嵌在 Loop 内反复执行。

**核心节点与串联**（对应 `chat.service.ts` 的 `executeMessageFlow`，全流程共 5 步）：

| 节点                    | 职责                                     | 输入 → 输出                                                    |
| ----------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| ① 意图路由 Orchestrator | 判定用户意图，选 Agent                   | 消息文本 → `routeDecision{intent, selectedAgent, confidence}`  |
| ② 会话/Run 建立         | 建会话、落用户消息、建 agentRun          | routeDecision → `agentRunId`（真实 runId）                     |
| ③ 上下文组装            | 简历上下文 + context pack                | userId/conversationId + token 预算 → `instructions` 前缀       |
| ④ Agent Loop 执行       | 多轮「模型→工具→模型」                   | instructions+tools+execute 回调 → `{assistantText, toolTrace}` |
| ⑤ 收口                  | 广播事件、落 assistant 消息、标 run 状态 | 执行结果 → DB + SSE done                                       |

**串联细节**：

- SSE 事件先以 `requestId` 生成 spanId，agentRun 创建后通过 `bindRunId` 把信封 runId 从 `pending:streamKey` 换成真实 runId（`sse-session.ts` / `SseEnvelopeFactory.setRunId`）。
- 步骤 ② 把 `routeDecision.intent / agentName` 写进用户消息，后续上下文检索能按 intent 过滤记忆。

**代码锚点**：`apps/api/src/chat/chat.service.ts` `executeMessageFlow`（L209 起）。

---

### Q3. 为什么设计成 Workflow，而不是简单的 LLM → Tool → LLM？

**一句话答案**：单次「LLM → Tool → LLM」无法表达四件事——**多步自主决策**（模型要跑多少轮由结果决定）、**失败自愈**（工具失败后模型需要修正重试）、**并行工具**、**可观测与安全边界**；这些都需要一个「带终止条件的循环 + 受控回调」的结构来承载。

**要点**：

1. 简单直链是"固定次数的一问一答"：一次调用只能请求一批工具，无法根据工具结果决定"要不要再查"。
2. Workflow（loop + 终止条件）才具备**闭式收敛**：模型自己决定何时停止（不再请求工具），系统用 `maxSteps` 兜底防死循环。
3. 直链模式下工具失败只能整体失败；loop 模式下 `safeExecute` 把 `{ok:false,error}` 回填给模型，让模型自愈（这是二者最大的行为差异）。
4. 直链模式天然串行；loop 可以支持同一轮多个独立工具并行（本项目用 `Promise.all`）。
5. Workflow 还预留了路由/上下文/审计这些"围绕 LLM 的基础设施"的挂载点。

**为什么（面试补充）**：Workflow 本质是把"模型不可控"这件事工程化——你不知道它会调用 0 次还是 5 次工具，所以不能写死调用链，只能写"循环 + 每个轮次的执行与回填约定 + 硬性上限"。

**其它方案**：

- 更重的方案：LangGraph / AutoGen 式显式状态图，适合跨 Agent 协作、条件跳转多的场景——本项目任务（咨询/联网问答）单 Agent 内循环就够，不上图避免过度设计。
- 更轻的方案：单次 Chat Completions + 手拼 messages 数组做多轮（见 Q29，代价是上下文管理易错）。

**代码锚点**：`apps/api/src/common/llm/openai-agent.client.ts` `runWithTools`（loop 主体）。

---

### Q4. Intent Recognition、Task Router、Tool Calling、方案检验分别负责什么？

**一句话答案**：**Intent** 回答"用户想干什么"（语义分类），**Task Router** 回答"这活派给谁"（选 Agent/流程），**Tool Calling** 回答"具体每一步怎么执行"（模型在 Agent 内自主调工具），**方案检验**回答"产出的东西质量够不够、要不要重来"（本项目对应简历链路的 scorer 闭环）。

**要点**：

1. Intent（意图）：语义层。例：`resume_diagnosis / interview_guidance / career_planning`。
2. Task Router（任务路由）：流程层。把 intent 落到一个可执行单元（这里三个 Specialist Agent 之一）。
3. Tool Calling（工具调用）：能力层。模型在单个 Agent 内、基于当前上下文自主决定调用 `web_search / web_browser` 等工具。
4. 方案检验（质量层）：结构化产出才需要的"生成 → 评价 → 定向迭代"闭环（见第四板块，代码映射在 `resume-agent-loop.service.ts`）。

**它们不是同层概念**：Intent 和 Router 解决"这次请求走哪条业务线"（每轮一次）；Tool Calling 解决"这条业务线内部怎么完成"（可能多轮）；方案检验解决"完成了没有、好不好"（外层循环）。

---

### Q5. 一次用户请求从进入系统到最终返回，完整链路是什么？

**一句话答案**（以 Chat 流式接口为例）：`HTTP POST /chat/message/stream` → DTO class-validator → 意图路由 → 会话/Run 建立 → 上下文组装 → 多轮 Agent loop（含工具调用与 SSE 上报）→ 结果落库 → SSE `done` 收口。

**完整链路**（对照代码逐段）：

1. **入口**：`ChatController.sendMessageStream`（`@Sse` 端点），JWT 守卫鉴权 → `ChatService.sendMessageStream`。
2. **SSE 会话**：按 `streamKey` 查 `chatStreamSessions`；会话已存在则直接订阅（断线续传），否则创建可回放会话。
3. **异步执行 `executeMessageFlow`**：
   - a. `OrchestratorService.decideNextAgent(message)` 得 `routeDecision`；
   - b. 无会话则自动建会话；落库用户消息（带 intent/agentName）；`AgentRunService.createRunningRun` 建 run，`bindRunId` 回填真实 runId；
   - c. 刷新历史摘要（best-effort）；`ResumeContextService` 建简历上下文；`ContextBudgetManagerService` 在 token 预算内组装 context pack；
   - d. SSE 广播 `start`、`route_decision`、`agent.step.started`（带 prompt 预览）；
   - e. `AgentExecutorService.execute` 跑 loop：每条工具调用先发 `tool.call.started`（带 spanId），执行完成后发 `tool.call.finished`，全程工具审计异步落 `ToolCallLogService`；
   - f. 模型最终文本按 80 字符切片发 `assistant_chunk`（模拟打字机），再发 `assistant_done`、`agent.step.finished`；
   - g. 落库 assistant 消息（含 `toolCallSummary`），刷新记忆摘要（best-effort）。
4. **收口**：广播 `done` → 等待持久化任务收口（`waitForPersistenceTasks`）→ `session.complete()`。
5. **失败路径**：任何异常 → 广播 `error{code,message}` → 结束会话；`agentRun` 标记为 failed/timeout/canceled。

**非流式**：`POST /chat/message` 的 `sendMessage` 与流式共用同一个 `executeMessageFlow`，保证两种模式行为一致（只是不挂 SSE 会话）。

**简历生成侧（另一条主链路）**：`POST /resume/generate` → `ResumeService.generate`（是否走 `ResumeAgentLoopService.run` 由开关决定）→ 多变体生成 → 评分 → 迭代最弱变体 → 返回带分/排名/差异的变体列表；`jd/rewrite` 走 JD judge → 定向重写闭环。

**代码锚点**：`apps/api/src/chat/chat.controller.ts`、`chat.service.ts`（sendMessageStream / executeMessageFlow）、`apps/api/src/resume/resume.service.ts`。

---

## 二、Intent + Router

### Q6. 为什么需要单独做 Intent Recognition？直接让 LLM 决定调用什么 Tool 不行吗？

**一句话答案**：可以，但"用 Tool 之前先决定走哪条业务线"更便宜、更稳——把**路由决策**和**工具决策**分开：路由用确定性的低成本规则每轮只判一次；工具选择仍交给 LLM。两者决策粒度不同，混在一起会让模型每次回答都背上"选业务线"的负担。

**要点**：

1. 工具是**能力**（能不能查网页），意图是**目标**（用户想改简历还是准备面试）。模型自己选工具解决不了"这次请求该由哪个 Agent 的服务/上下文体系处理"。
2. 每个 Agent 有独立的 systemPrompt、工具集、上下文前缀（简历上下文/显示偏好/历史摘要），必须先路由到 Agent，才能确定 instructions 和可用工具集。
3. 业务需要意图的**确定性落库与检索**：用户消息要带 `intent` 落库、context pack 要按 intent 过滤历史记忆——这个标识必须稳定、可审计，交给 LLM 每次返回会抖动。
4. 分层把"贵且慢"的 LLM 调用留在真正需要语义的地方（生成/工具），路由这种可穷举的判别任务用规则，成本趋近于零。

**其它方案**：

- **LLM 做意图分类**：自由文本意图类别多、边界模糊时用（一次小模型调用 + 枚举输出）。代价：延迟 ~1 次调用、输出可能越界，需要 schema 约束 + fallback。
- **Embedding + 分类器**：意图类别多但语义可分时，比关键词鲁棒（能处理同义改写），但需要向量库与标注样本。
- 本项目意图类别只有 4 类且关键词判别度高（见 Q7），规则足够，LLM 化属于过度设计。

---

### Q7. 你的 Intent Recognition 是怎么实现的？

**一句话答案**：本项目没有用 LLM 做意图识别，而是用**规则引擎**——`OrchestratorService.decideNextAgent()` 对消息小写化后做关键词命中判定，按「面试 > 职业规划 > 简历诊断」的优先级短路返回，全部未命中走默认 fallback。

**要点**：

1. 判定依据：`message.includes(keyword)`，关键词分组（如面试类：面试/追问/自我介绍/怎么说/star/mock…；职业类：职业/规划/转岗/方向…；简历类：简历/优化/润色/诊断/匹配…）。
2. 输出：`OrchestratorDecision` = `{ intent, selectedAgent, reason, confidence, fallbackUsed, matchedRules[] }`，`confidence` 是**先验配置值**（0.9x），不是模型概率。
3. 优先级 + 短路：先查面试 → 再职业 → 再简历，命中即返回（后两组顺序保证 `简历` 不会误吞「优化简历面试回答」这类组合句的前置判断）。
4. 全未命中 → `general_resume_followup` + `resumeDiagnosisAgent`，`fallbackUsed: true`、`confidence: 0.42`（显式标记低置信，前端可据此展示）。

**为什么这么做**：判别空间小、意图明确、中文关键词命中率高，规则是确定性的——同样输入永远同样输出，可单测、可审计（`matchedRules` 记录了命中证据），面试时可诚实讲"我在意图明确的产品里选择用规则做第一层路由，把 LLM 预算留给生成层"。

**其它方案 / 演进**：规则 + LLM 兜底（低置信或零命中时再让 LLM 分类）、或直接换 embedding 分类（见 Q6）。局限是**同义改写不耐受**（用户写「想看看岗位要求我合不合适」不含关键词时命中不了，只能走 fallback），这是规则的已知短板，面试主动点出加分。

**代码锚点**：`apps/api/src/agent/orchestrator/orchestrator.service.ts`。

---

### Q8. Intent Recognition 和 Task Router 有什么区别？

**一句话答案**：Intent 是**分类结果**（用户要什么），Task Router 是**执行决策**（这个意图该交给哪个可执行单元）；本项目两者职责合一在 `decideNextAgent`——一次调用同时产出 `intent` 与 `selectedAgent`。

**要点**：

1. 概念上可分：Intent "用户想准备面试" → Router 决定 "由 interviewCoachAgent 处理"。同一 intent 未来也可能路由给不同流程（如简历诊断可能路由到 JD 匹配服务）。
2. 项目当前是 **1:1 映射**（每个 intent 固定对应一个 Agent），所以合并成一个方法实现即可，不引入额外抽象。
3. 分开的价值体现在**可扩展**：当出现"一个意图可由多 Agent 协作 / 多个意图指向同一 Agent"时，Router 才需要独立成层。

**其它方案**：独立 Router 层（决策表/权重），本项目按 YAGNI 未做。面试口径：讲清楚概念分层 + 承认当前实现合并，是经过取舍的。

---

### Q9. Task Router 是由 LLM 决定，还是代码决定？为什么？

**一句话答案**：本项目由**代码（规则）决定**，不是 LLM。理由：路由是一个**有限、确定、可穷举**的判别问题，规则能做到零成本、零抖动、可单测可审计；LLM 的强项是开放生成，不该浪费在稳定判别上。

**要点**：

1. 决策面小：4 类 intent × 3 个 Agent，规则穷举无压力。
2. 路由错误代价高且不可控：LLM 输出概率性，同样的句子两次可能路由不同 → 会话体系/上下文/审计都要求稳定。
3. 延迟与成本：规则 <1ms，LLM 一次调用 ~数百 ms + 成本。
4. `OrchestratorDecision` 全量落库（agentRun.orchestratorDecision），确定性规则让"为什么选这个 Agent"可回溯、可解释。

**其它方案（什么场景该换 LLM 路由）**：意图开放（如几百个技能主题）、需要理解隐含语义、或多语言场景，规则维护成本爆炸，就应换 LLM/embedding 分类，并保留规则做 fallback。工程上通常**规则兜底 + 模型主判**或**模型为主 + 规则低置信兜底**，本项目反着来（规则为主）是因为业务边界明确。

---

### Q10. 如果 Intent 识别错了，后面的 Workflow 怎么处理？

**一句话答案**：三种兜底层层递进——① 规则层显式 `fallback`（没命中走默认 Agent）；② Agent 层工具可纠正（选错 Agent 也只是 systemPrompt/工具集不同，模型仍能答）；③ 会话层长期纠偏（历史会存下来，后续上下文按对话连续性修正）。系统**不因路由错而崩溃**。

**要点**：

1. **不会崩溃**：三个 Agent 共用同一套能力底座（都是"简历 AI 助手 + web 工具"），路由错=选错人设/上下文侧重，不是选错模块，下游仍能产出合理回答。
2. **消息按错就错**：路由结果已随用户消息落库，不做"二次纠错重路由"（避免多一次调用），错误体现在回复质量而非链路失败。
3. **意图在落库**：intent 写在用户消息上，后续多轮中用户会自然把真实诉求说清，新一轮路由会命中正确 Agent——错误是**单轮局部**的，不污染后续轮次。
4. **审计可发现**：`fallbackUsed`/`confidence` 落库后，可通过观测分析低置信样本做规则迭代（关键词补充）。

**其它方案**：可做"低置信 → 反问澄清"（用户输入歧义时先问一句而不是硬路由），或用 LLM 复判（Q6/Q9）。当前产品偏向快速响应，选择不做澄清、接受局部误差。

**代码锚点**：`apps/api/src/agent/agent-run.service.ts`（决策落库）、`apps/api/src/chat/chat.service.ts`（intent 随消息落库）。

---

## 三、多轮 Tool Calling

### Q11. 简历里说的"多轮工具调用"具体是什么意思？

**一句话答案**：不是"模型一次请求里调多个工具"，而是**一次用户请求内，模型 与 工具 反复交替多轮**：模型输出工具调用 → 系统执行并回填结果 → 模型基于结果再决定"继续调工具还是输出最终回答"，直到不再请求工具（或被 maxSteps 截断）。

**要点**：

1. 每一"轮" = 一次 LLM API 调用 + 这轮里所有工具执行。
2. 典型模式：`web_search` 拿到链接 → 下一轮 `web_browser` 打开具体页 → 再一轮基于正文生成回答，共 3 轮。
3. 在简历场景对应"生成 → 评分 → 只重写最弱变体 → 再评分"的**外循环**（那是多轮改写而非多轮工具调用，别混为一谈，见 Q21）。

**与"并行调用多个工具"的区别**：多轮是时间上的循环，并行是单轮内多个工具同时执行（Q16）。面试先讲清"多轮=多次 模型↔工具 交替"。

---

### Q12. 多轮 Tool Calling 的完整执行流程是什么？

**一句话答案**：`runWithTools` 中一个 `for` 循环：`createResponse`（首轮）→ 每轮提取 `function_call` → 无则返回最终文本；有则并行执行工具 → 构造 `function_call_output` → 带 `previous_response_id` 续接下一轮 → 直到无工具调用或 step 到 `maxSteps`。

**伪码级流程**（`openai-agent.client.ts`）：

```
response = createResponse({input: 用户文本, tools})
for step in 0..maxSteps-1:
  calls = extractToolCalls(response.output)     // 只取 function_call 项
  if calls 为空: return {output_text, toolTrace} // 收敛：模型给最终答案
  if stopOnToolCall: return {toolTrace}          // 单轮模式：只要参数
  对每个 call 依次触发 onToolStart              // 先统一发"开始"事件
  results = await Promise.all(calls 执行 execute) // 并行执行
  对每个结果: 生成 function_call_output 项 + push toolTrace + onToolDone
  response = createResponse({input: 上一步 outputs,
                             previous_response_id: response.id})
throw openai_agent_max_steps_N                    // 循环耗尽仍未收敛
```

**要点**：

1. 首轮 `input` 是用户文本，后续轮 `input` 只放 `function_call_output` 数组（历史在服务端由 `previous_response_id` 续接）。
2. 每轮重新传 `instructions` 与完整 `tools`（工具定义不随轮衰减）。
3. 退出路径只有两条：**无工具调用**（正常收敛）或 **maxSteps 耗尽**（异常截断）。

---

### Q13. Responses API 返回 Tool Call 后，你的代码具体怎么处理？

**一句话答案**：`extractToolCalls(response.output)` 过滤出 `type === 'function_call'` 的 `ResponseFunctionToolCall[]`，逐个解析 `arguments`（JSON 字符串 → 对象），并行交给注入的 `execute` 回调执行，再把结果包成 `function_call_output` 回填。

**处理细节**：

1. **取调用**：`output.filter(item => item.type === 'function_call')`。
2. **解析参数**：`parseCallArguments` 分两档——多轮 loop 模式解析失败返回 `null`（交给 safeExecute 回填错误）；stopOnToolCall 模式直接抛 `openai_empty_arguments` / `openai_invalid_arguments`。
3. **安全执行**：`safeExecute` 包 try/catch，任何异常都转成 `{ok:false, error}`，**不让异常穿透 kill 掉整个 loop**。
4. **执行前上报**：先对每个 call 触发 `onToolStart`（保持调用顺序、生成 spanId），再并行执行——这样前端时间线"开始事件顺序 = 调用顺序"。
5. **结果构造**：`function_call_output` 必须带 `call_id`（对齐 OpenAI 的工具调用）、`output: JSON.stringify({ok, data|error})`，状态 `completed`。
6. **trace 记录**：每步 `{step, name, arguments, result, latencyMs}` push 进 `toolTrace`，供 SSE 摘要与审计使用。

**代码锚点**：`openai-agent.client.ts`：`extractToolCalls` / `parseCallArguments` / `safeExecute` / `runWithTools` 内循环。

---

### Q14. Tool 执行结果是怎么重新交给模型的？

**一句话答案**：通过 Responses API 的 `function_call_output` 输入项 + `previous_response_id` 续接——不发完整历史，只发"本次工具输出"增量。

**要点**：

1. 每个工具结果：`{type:'function_call_output', call_id: call.call_id, output: JSON.stringify(result)}`。
2. `output` 统一包装成 `{ok:true,data}` 或 `{ok:false,error}` 结构——模型能一眼看出成功与否，失败的 error 可直接指导下一步。
3. 续接请求：`responses.create({..., previous_response_id: response.id, input: outputs})`——服务端自动把前几轮上下文连起来，系统不维护 messages 数组。
4. 若一轮有多个工具，按**输入顺序** push outputs，`function_call_output` 与 `call_id` 一一对应，OpenAI 会精确匹配是哪次调用的结果。

**其它方案**：Chat Completions 风格需要手动把 assistant tool_calls + role:tool 消息拼接进历史再全量发送，上下文管理和 token 开销都更大（详见 Q29）。

---

### Q15. 你怎么判断这一轮结束还是继续调用 Tool？

**一句话答案**：看当前 response 里还有没有 `function_call`：**有 → 继续执行并续接；没有 → 模型输出的是最终文本，直接收敛返回**。判断是数据驱动的，不靠代码猜。

**要点**：

1. `response.output` 是数组，可同时含 `message`（文本）与多个 `function_call`。
2. 本项目设计上"工具调用期间模型不产正文"，收敛条件就是 `calls.length === 0`。
3. 返回结果取 `response.output_text`（Responses API 聚合的纯文本）+ `toolTrace`（观测记录）。
4. 补充约束：即使模型一直要工具，`step < maxSteps`（默认 5）是硬边界，到上限视为异常（Q20）。

**其它方案**：可以允许"边输出文本边调工具"（`output_text` 中间态也可下发），但会增加 SSE 事件与渲染的复杂度；当前按"先工具后总结"的单步语义做，简单可控。

---

### Q16. 如果模型连续调用多个 Tool，你怎么处理？

**一句话答案**：**同一轮内并行执行**（`Promise.all`），但**先按顺序全部触发开始事件，再按输入顺序回填结果**——并发执行、顺序回填，保证结果与 trace/SSE 顺序稳定。

**要点**：

1. 执行阶段：`Promise.all(calls.map(execute))` 真正并发，缩短这轮耗时（联网 IO 是主要延迟）。
2. 事件阶段：先 `for` 循环触发全部 `onToolStart`（保持调用顺序），执行完成后按 `index` 顺序 push outputs / toolTrace / `onToolDone`。
3. 顺序保证：`Promise.all` 结果数组与输入数组下标一一对应，因此"回填顺序 = 模型调用顺序"，不会出现 B 的结果排在 A 前面。
4. span 配对（chat.service）：同名工具可能并发，`pendingToolSpans` 用 **toolName FIFO 队列**配对 start/finish，队列空则兜底新开 span（`popToolSpan`）。
5. `call_id` 保证 `function_call_output` 与调用精确对应，模型不会错配。

> ⚠️ 口径差异：旧文档 `agent-loop-function-calling-interview-qa.md` 记的是"当前串行执行"，**最新代码已改为 Promise.all 并行**，面试以本文档为准。

**为什么并行而非串行**：工具之间通常无依赖且都是网络 IO，串行让总耗时 = Σ单工具耗时；并行收敛到 max(单工具耗时)，延迟收益明显，代价只是要做好事件顺序与并发安全（上面已处理）。

**其它方案**：串行执行（简单、省资源但慢）、按依赖分批并行（复杂，需工具声明依赖，当前工具集 web_search→web_browser 是弱顺序依赖，靠模型分轮调用天然解决）。

---

### Q17. 如果模型一直调用 Tool，怎么防止 Agent 无限循环？

**一句话答案**：`maxSteps` 硬上限 + SDK 请求超时 + 工具自身超时三层兜底；达到上限抛 `openai_agent_max_steps_5`，由上层标记 run 失败。

**要点**：

1. **轮数上限**：`runWithTools` 的循环 `step < maxSteps`（默认 5），循环走完仍无收敛 → `throw openai_agent_max_steps_N`（N=5）。
2. **请求超时**：单次 LLM 调用 `timeoutMs=20s`（`llm-config.ts`）+ SDK `maxRetries: 2`，防止单轮卡死。
3. **工具超时**：web_browser 单页 10s `withTimeout`，防联网工具悬挂（Q19）。
4. 达上限后的处置：`AgentRunService.markFailed` + SSE `error` 广播；同时这是重要信号——模型一直请求工具通常说明工具定义/指令有缺陷，需排查（可观测里能定位）。

**为什么需要"硬上限"而非指望模型自觉**：LLM 是概率系统，可能进入工具循环（如搜索永远不满足）；任何 Agent 系统都必须在代码层保留终止保证，这是**可靠性设计的基本盘**。

**其它方案**：轮数上限之外可叠加：单轮 token 预算（`max_output_tokens`）、工具级配额（每 run 最多 N 次联网）、熔断器（连续失败达阈值直接终止）。工程上线越往这些方向做越稳。

**代码锚点**：`openai-agent.client.ts`（`DEFAULT_MAX_STEPS = 5`）、`agent-executor.service.ts`（`DEFAULT_CHAT_AGENT_MAX_STEPS = 5`）。

---

### Q18. 如果 Tool 执行失败，你是直接结束 Agent，还是继续执行？为什么？

**一句话答案**：**不结束，继续执行**——`safeExecute` 把所有异常捕获并包成 `{ok:false,error}` 回填给模型，模型拿到"失败信息"后可自行修正参数重试、换工具或放弃，这叫**模型自愈（self-correction）**。

**要点**：

1. 为什么继续：LLM 是不可控依赖，工具失败不应击穿主链路。多数失败（网页 404、参数不合法、超时）模型**换个做法就能成功**，直接终止会让一次本可完成的请求失败。
2. 为什么错误要"喂回模型"而不是吞掉：模型需要知道失败原因才能修正；`{ok:false,error}` 结构化清晰。
3. 唯一例外：**LLM API 层错误**（鉴权/限流/超时）不属于工具失败，`mapOpenAiError` 会映射为 `openai_*` 错误向上抛，由外层决定失败策略——因为这类错误模型自愈不了。
4. 结果仍会计入 `toolTrace`（result={ok:false,...}），前端 `tool.call.finished` 带 `success:false` + `errorMessage`，审计照记。

**其它方案**：**fail-fast**（失败即终止整个请求，事务语义强）适合"工具失败=业务失败"的场景（如扣款），不适合 Agent 探索场景。还有**有限重试**：在 safeExecute 内部对瞬时错误重试 N 次，本项目重试交给了模型（外部重试），避免内部盲目重试放大成本。

---

### Q19. 如果 Tool 超时怎么办？

**一句话答案**：工具层用 `withTimeout` 在超时后抛错（如 `web_browser_timeout`），该错误走 Q18 的路径包装回填给模型；若用户中途取消，`AbortSignal` 会立即中止并抛 `aborted`。

**要点**（`web-browser-tool.service.ts` 的 `withTimeout`）：

1. 单次异步操作包 Promise race：到 `timeoutMs`（默认 10s）→ `cleanup()` 后 `reject(errorCode)`。
2. `cleanup` = `clearTimeout` + `removeEventListener`，**先判 `signal.aborted` 再监听**避免竞态双 reject；resolve/reject 只触发一次。
3. `AbortSignal` 中断（用户点取消 / 客户端断连）→ reject `aborted`。
4. LLM 单次请求超时同理：SDK `timeout: config.timeoutMs`（20s），超时经 `mapOpenAiError` 转 `openai_timeout_20s` 上抛，run 标记 `timeout`（`AgentRunService.markTimeout`，errorCode `TOOL_TIMEOUT`）。
5. 工具级超时 ≠ 放弃：超时对模型而言只是"这次没查到"，模型可换 URL 或改用搜索摘要作答。

**为什么超时后还要回填给模型而不是静默重试**：避免"超时→内部盲重试"无限叠加延迟；把重试决策权交给模型（它会综合成本）。真正系统级保护是 `maxSteps × (LLM 超时 + 工具超时)` 的总预算（最坏 N×30s 以内）。

---

### Q20. 如果达到最大 Tool Call 次数，但任务还没有完成，怎么办？

**一句话答案**：当前实现是**失败并暴露**——抛 `openai_agent_max_steps_5`，外层把 run 标记失败、SSE 广播 error，把"模型始终无法收敛"这个事实显性化，而不是返回一个半成品当成功。

**要点**：

1. 语义选择：到 maxSteps 说明"模型在反复要工具但没给出结论"，这是**异常状态**，静默返回半成品会误导用户，所以抛错。
2. 体验补偿：前端展示明确错误码；run 状态机留 `failed` + `errorCode` 供诊断。
3. 演进方向（面试可主动给出）：
   - **阶梯降级**：到上限时携带已收集的工具结果问一次"基于已有信息能否作答"；
   - **可配置上限**：不同任务给不同 maxSteps；
   - **部分成功**：状态机里已有 `partial_success` 预留，未来可在"有部分工具结果"时返回中间结论并标记，而不是硬失败；
   - **熔断/配额**（见 Q17）。

**为什么当前不做降级**：chat 场景 maxSteps=5 足够宽裕，到上限多是模型行为异常，返回"尽力而为的半成品"会掩盖 prompt/tool 定义问题；先暴露、后优化更符合工程收敛节奏。

---

## 四、方案检验

> 口径提醒：简历若写了"方案检验 / Planner / Validator / Executor 三角色"，其真实代码映射在**简历生成链路**（`resume-agent-loop.service.ts` + `resume-scorer.service.ts` + `resume.ai.service.ts`），不是 Chat 链路。Chat/联网问答是开放式任务，没有独立 Validator。面试先声明这一点，再回答问题，避免被追问"这层代码在哪"时穿帮。

### Q21. 简历里说的"方案检验"具体是什么？

**一句话答案**：**方案检验 = 让"生成"与"评估"分离**：LLM 只负责起草/改写方案（Planner + Executor），另一个通道负责按规则打分（Validator），得分低就带反馈重写，直到达标——本项目对应简历"多变体生成 → 评分 → 只迭代最弱变体 → 再评分"的闭环。

**代码映射**：

1. **Planner/Executor（生成）**：`ResumeAiService.generate` 按请求生成候选变体（数量 1~3，默认 3，`normalizeVariantCount` 上限 3）；`rewriteVariantWithFeedback` 按反馈定向重写。
2. **Validator（评估）**：`ResumeScorerService.scoreVariant` 双通道打分：规则分（readability/measurability/roleRelevance 加权）+ LLM judge 分，`overallScore = 规则×0.4 + LLM×0.6`，并输出 `issues[] / suggestions[]`。
3. **闭环**：`ResumeAgentLoopService.run` —— 生成→全量评分→每轮只重写**分数最低**的变体→只重评该变体，直到满足停止条件。

**停止条件**（`resume-agent-loop.service.ts`）：

- 最弱变体 `overallScore >= targetScore`（默认 85，隐含全部达标）；
- 达到 `maxTurns`（默认 3）；
- 连续 `NO_IMPROVEMENT_LIMIT=2` 轮提升 ≤ `IMPROVEMENT_EPSILON=0.1`（无有效改进提前停）。

**JD 链路同构**：`jd-parser` 解析 → `jd-judge` 评分（低分维度）→ `jd-rewriter` 只重写低分维度 → 循环，属同一"检验-迭代"模式。

---

### Q22. 为什么需要方案检验？为什么不能让 Agent 直接执行？

**一句话答案**：LLM 单次生成的**质量不可控且无反馈**——它不知道自己漏了量化指标、重点不突出。方案检验引入"可量化的评估 + 定向反馈"，把单次生成变成**收敛式优化**；"直接执行"则无法回答"结果到底好不好"。

**要点**：

1. 直接生成没有**优化方向**：模型不知道差在哪，只重写一次不一定变好。
2. 检验提供**可终止性**：达标即停，避免无限打磨；无进展（分数不涨）也停，避免浪费 token。
3. 检验提供**可解释性与选择依据**：给用户展示分数/排名/差异，让他选变体（`variant/select`）。
4. 规则 + LLM 双通道：**规则**保证可复现的硬伤检查（量化、可读性），**LLM judge** 补语义质量（相关性、上下文契合），融合避免单通道偏差。
5. 何时"直接执行"也够：开放式问答（Chat 链路）无需分数；成本敏感的低价值任务不需要这层循环——检验是**增量价值 vs 额外 token 成本**的权衡。

**其它方案**：自我批评式（让同一模型"反思后重写"，成本低但偏见强，容易自说自话）；多模型交叉评分（成本高）；纯规则评分（漏语义）。本项目选"规则+LLM 双通道 + 只迭代最弱变体"是在质量、成本、速度间的平衡——只迭代最弱而非全部重写，显著省 token。

**代码锚点**：`apps/api/src/resume/resume-agent-loop.service.ts`、`resume-scorer.service.ts`。

---

### Q23. 你的 Plan 是怎么生成的？

**一句话答案**：**Planner 就是 LLM 起草**——`ResumeAiService` 用分步 prompt 模板（按岗位 JD/简历上下文生成多个风格的候选变体），不是先出一个文本大纲再执行，而是"prompt 结构即计划"。

**要点**：

1. 生成入口：`generate` 同时产多个变体（不同侧重），供后续评分挑选与用户选择。
2. 定向改写即"再计划"：`rewriteVariantWithFeedback` 把 `scores`（含维度分、issues、suggestions）序列化进 prompt，让 LLM 聚焦低分维度产出改进版——**评分结果就是下一轮的计划输入**。
3. JD 解析/重写链路：`JdParserService` 解析出结构化 JD → `JdJudgeService` 判低分维度 → `JdRewriterService` 构造 `JdRewriteImprovementTarget[]`（目标维度/当前分/达标阈值/改善 hint）→ `rewrite_jd`。
4. 显式约束防幻觉：rewrite prompt 明确 "只改低分维度、不改无关字段、不捏造 metrics、保持 evidenceSpan 可溯源"（`openai-responses-rewriter.client.ts`）。

**其它方案**：先出"结构化计划 JSON → 逐条执行"的严格 Plan-Execute 模式（任务拆解类场景）；或 Tree-of-Thought 并行探索。本项目"评审驱动迭代"比严格两步式更贴合内容生成类任务（方案很难预先精确分解）。

---

### Q24. 谁负责验证 Plan？是规则还是 LLM？

**一句话答案**：**两者都要，且是加权融合**：`ResumeScorerService` 同一变体同时算规则分与 LLM judge 分，`overallScore = 规则×0.4 + LLM×0.6`，issues/suggestions 也从两路取 top 去重合并。

**要点**：

1. **规则通道**（确定性、零成本）：抽取内容单元后按可复现规则打分，如 `scoreReadability`（句式长度/分点结构）、`scoreMeasurability`（数字指标密度）、`scoreRoleRelevance`（与目标岗位要求关键词/技能匹配度），各维加权合成。
2. **LLM judge 通道**（语义、灵活）：把变体与目标岗位描述交给 LLM 独立评分，捕捉规则抓不到的相关性/表达问题。
3. 融合动机：规则可复现但死板；LLM 灵活但可能抖动。0.4/0.6 权重让"硬伤"和"语义质量"都生效；LLM 失败时降级用规则分（`llm?.score ?? rule.score`），保证评分链路不因 LLM 抖动中断。

**面试补充**：这正是"为什么验证不纯用 LLM / 不纯用规则"的答案——纯规则看不到语义，纯 LLM 不可复现且贵；混合是工程折中。

---

### Q25. Validator 具体检查哪些内容？

**一句话答案**：三个可量化维度 + 两类定性输出。维度：可读性（readability）、可量化度（measurability）、岗位相关性（roleRelevance）；定性：问题列表（issues）+ 改进建议（suggestions），规则与 LLM 两路各自产出后**合并去重，整体最多 4 条**。

**各维度的规则检查示例**（`resume-scorer.service.ts`）：

- readability < 70 → issue `low_readability`，建议"用简洁 动宾结果 短句、避免超长嵌套从句"；
- measurability < 65 → 数字/结果导向不足；
- roleRelevance：与目标岗位 JD 的硬性要求/必备技能匹配度。
- 另有一层事实/安全约束不在评分里而在生成侧：JD rewrite 明确"不捏造 metrics，内容必须由原文 evidenceSpan 支撑"。

**评分产物同时服务两端**：向上（返回给用户展示/选择）与向下（作为下一轮 rewrite 的定向输入）。

---

### Q26. 如果 Validator 判断方案不合理怎么办？

**一句话答案**：**不是丢弃重做，而是"定向迭代最弱项"**——把评分里的短板作为下一轮 prompt 的改进目标重写；连续无提升或达上限才停止，返回当前最好结果而非空失败。

**要点**（`ResumeAgentLoopService.run` 的循环语义）：

1. 选最弱：`findWeakestIndex` 取 overallScore 最低的变体。
2. 定向重写：`rewriteVariantWithFeedback` 带该变体的评分与搜索摘要重写；重写后只重评该变体，`gained > 0.1` 记有提升否则累计 noImprovementRounds。
3. 停在三态：达标 / 达 maxTurns / 连续 2 轮无有效提升——**绝不无限打磨**。
4. 收尾返回 `{variants, scores}`：即使未达标也返回当前最优变体与分数，由上层继续（用户选择/再触发）。
5. JD 链路同构：`rewrite_jd` 只修 judge 指出的低分维度；LLM 未按规则出参时抛 `openai_*`，由 `JdRewriterService` **回退到规则版重写**（fallback 而非中断）。

---

### Q27. 为什么不让一个 LLM 同时负责 Planner、Validator 和 Executor？

**一句话答案**：**自我评估存在系统性偏误**（self-bias）：同一个模型对自己刚生成的内容天然倾向打高分、看不到它自己漏掉的点，等于"考生自己批卷子"；角色分离让"生成者"和"检验者"的失败模式不相关，检验信号才可信。同时分离在工程上带来：可独立升级/降级某一角色、LLM judge 挂了可单独降级到纯规则。

**要点**：

1. **认知层面**：自评与生成共用同一套盲区（比如都忽略量化指标），评估就失去纠错价值。
2. **成本/延迟层面**：完全分离=每次多一次 LLM 调用。所以本项目做了**分层妥协**——真正分模型的是"内容生成（ResumeAiService/LLM）"与"质量检验（规则为主 + LLM judge 为辅）"，而"规划"没有独立第三模型，靠 prompt 模板承担，避免三模型成本。
3. **工程隔离**：Validator 依赖评分接口（`ResumeScorerService`），Executor 依赖生成接口，接口化后可分别替换为更大模型/更严规则而不动对方。

**其它方案**：

- 完全独立的三模型（Planner/Validator/Executor 各一个）——质量上限最高，成本 ×2~3，适用于高价值长任务；
- 单模型自评（零额外成本）——适用于低价值任务，接受偏误；
- 角色由提示词而非模型区分——中等折中，本项目 JD 链路采用（同一模型不同 instructions），配合规则校验兜底。

**面试口径**：不要只说"不能"，要说"纯自评偏误大 → 分离有成本 → 我按价值密度做了分层：低风险提示词分离，高质量出口规则+LLM 双通道"。这是有工程权衡的答案，比教条式"必须分离"更打动人。

---

## 五、Responses API

### Q28. 为什么选择 OpenAI Responses API？

**一句话答案**：因为 tool calling 循环要处理"多次往返的上下文"，Responses API 的 `previous_response_id` 把"历史维护"交给服务端，配合 `function_call_output` 结构化回填，比自拼 messages 的 Chat Completions 方案**省心、省 token、不易错**。

**要点**：

1. **增量续接**：续轮请求只传 `previous_response_id + 本轮 tool outputs`，服务端自动带上前面所有上下文——系统代码不维护历史数组。
2. **结构化输出项**：`response.output` 是类型化数组（`message` / `function_call`），`output_text` 聚合最终文本，SDK 类型完备，过滤 `function_call` 一行搞定。
3. **OpenAI 官方演进方向**：Responses API 是官方推荐的 Agents/tool-calling 新接口（基于内部 Assistant/Agents 基础设施），会持续获得新能力。
4. **反面/代价**：Responses API 不是所有中转/兼容服务（`OPENAI_BASE_URL`）都支持，切换到只支持 chat/completions 的代理时会受限——这是当初同时保留兼容抽象的原因（`OpenAiAgentClient` 可被替换，JD 链路走 `JdLlmParserClient` 接口）。

---

### Q29. Responses API 和 Chat Completions 有什么区别？

**一句话答案**：核心差异在**多轮工具调用的上下文组织方式**：Chat Completions 要调用方自己把 `assistant.tool_calls` + 每工具一条 `role:'tool'` 的消息**拼回 messages 数组**再全量发送；Responses API 用 `previous_response_id` 服务端续接 + `function_call_output` 增量回填，不再需要调用方拼历史。

**对比表**：

| 维度             | Chat Completions                 | Responses API（本项目）                   |
| ---------------- | -------------------------------- | ----------------------------------------- |
| 历史维护         | 调用方全量拼接，每次重发全部历史 | 服务端按 `previous_response_id` 保留      |
| 工具结果回填     | `role:'tool', tool_call_id`      | `function_call_output{call_id, output}`   |
| Token 成本       | 每轮随历史增长                   | 增量续接，历史不重复计费                  |
| 工具调用识别     | `message.tool_calls[]`           | `response.output[]` 中 `function_call` 项 |
| 上下文管理出错面 | 大（漏拼/顺序错/截断历史）       | 小（只需持有 response.id）                |

**为什么这决定了选型**：tool loop 是多轮场景，多轮 × 全量历史 = token 与出错风险双双线性放大；`previous_response_id` 把最易错的"上下文连续性"从业务代码里拿掉，是工程化 agent 的关键简化。

---

### Q30. 你实际使用了 Responses API 的哪些能力？

**一句话答案**：`responses.create`（多轮续接的 tool calling）+ `tools/tool_choice`（函数定义与 auto 决策）+ `function_call_output`（结果回填）+ `previous_response_id`（增量上下文）+ `output_text`（收敛文本）+ SDK 超时/重试配置。

**具体使用点**（`openai-agent.client.ts`）：

1. `responses.create({model, instructions, input, tools, tool_choice:'auto', previous_response_id?, max_output_tokens?})`。
2. 用 `response.output` 的 `function_call` 提取工具调用、`response.output_text` 取最终回答。
3. `tool_choice: 'auto'` 让模型自主决定是否调用（联网工具非每问必用）；换 `required`/指定工具即可强制。
4. 未用流式（`stream:true`）——当前最终文本在服务端切片模拟打字机（见 Q56）。
5. `strict` schema：注册表把 zod 转成 OpenAI strict 兼容的 parameters（`deepRequireAll` 全字段必填 + 禁额外字段），降低模型输出不合规概率。

---

### Q31. Responses API 中 Tool Call 和普通文本输出有什么区别？

**一句话答案**：两者都在同一份 `response.output` 数组里，但**类型不同、形态不同**——文本是 `message` 项的 `content`、最终还能取聚合的 `output_text`；工具调用是 `function_call` 项，内容是 `{name, arguments(JSON字符串), call_id}`，需要系统执行并回填，不会直接作为答案。

**要点**：

1. `function_call` 不携带"结果"，只有"意图 + 参数"；参数是 **JSON 字符串**，要先 parse。
2. `call_id` 是回填的唯一凭证：`function_call_output.call_id` 必须等于它。
3. 判断收敛（Q15）：出现 `function_call` 就还没完；只剩 `message` 才是最终回答。
4. 本项目约定"工具阶段不吐正文"，所以直接以 `output_text` 为空/有作为辅助信号。

---

### Q32. 多轮 Tool Calling 在 Responses API 中是怎么串起来的？

**一句话答案**：靠 **`previous_response_id` 链**：第一轮创建 response 得 id，之后每轮都用上一轮 response 的 id + 本轮 `function_call_output` 增量继续，形成一条服务端维护的会话链，直到模型输出不再含 `function_call`。

**链路示意**：

```
R1 = create(input: 用户文本, tools)                 // 模型要搜
    └─ id1
执行 web_search → outputs1 = [function_call_output]
R2 = create(input: outputs1, previous_response_id: id1, tools)  // 模型要开网页
    └─ id2
执行 web_browser → outputs2 = [function_call_output]
R3 = create(input: outputs2, previous_response_id: id2, tools)  // 模型给出最终文本
    → 无 function_call，收敛，返回 output_text
```

每轮 `instructions` 与 `tools` 都重传；只有历史靠服务端链保留。

---

### Q33. 如果 Responses API 请求失败或者超时怎么办？

**一句话答案**：分层处理——SDK 层 `maxRetries: 2` 自动重试；超时/鉴权/限流/连接错误由 `mapOpenAiError` 统一映射为 `openai_*` 错误码；工具/模型层错误不中断 loop（回填自愈），只有 LLM API 层错误才上抛给外层走 run 失败状态。

**错误映射表**（`openai-error-mapper.util.ts`）：

- 用户中止（`APIUserAbortError`）→ `aborted`；
- 超时 → `openai_timeout_20s`；
- 429 限流 → `openai_http_429:rate_limit`；
- 401 鉴权 → `openai_http_401:authentication`；
- 连接失败 → `openai_connection_failed`；
- 非 APIError 异常 → 原样透传（如 `openai_agent_max_steps_5`）。
- 外层处置：`AgentRunService` 按错误标 `failed`/`timeout`/`canceled`；SSE 广播 `error{code}`。

**其它方案**：重试策略可升级为指数退避（SDK 默认 `maxRetries` 固定 2 次，需要更稳的批量任务可自实现退避重试）；对 429 可做熔断保护上游配额。当前 chat 场景 SDK 默认足够。

---

## 六、Tool 设计

### Q34. 你的 web_search 和 web_browser 分别负责什么？为什么要拆成两个 Tool？

**一句话答案**：`web_search` 负责**检索发现**（关键词 → 结果列表：标题/URL/摘要），`web_browser` 负责**精读单页**（URL → 页面标题 + 正文）。拆开是因为它们是**两种不同成本与风险的操作**：搜索一次返回多个候选，成本低；抓网页是重操作（无头浏览器 + SSRF 风险），应该只在确定目标 URL 时才允许。

**要点**：

1. **能力边界**：搜索解决"不知道哪个网页有答案"；浏览解决"已知页面、要读全文"。模型应先搜索拿到候选，再对选中页浏览——工具描述里写明了触发边界（`web-tools.schema.ts`）：web_browser 仅用于"读 web_search 返回的具体文章正文，通用问题不要用"。
2. **成本控制**：web_browser 每次要开浏览器会话、可能被反爬、10s 超时、16KB 截断；如果允许模型随意抓任意 URL，成本与风险不可控。
3. **风险隔离**：只有 web_browser 需要 SSRF 防护（真正建连抓取），web_search 是对外部搜索 API 的调用，本身不直连任意 URL——拆开让安全边界只落在最小面。
4. 拆分还给权限/配额控制提供粒度：可分别限制调用次数。

**其它方案**：合并成一个"fetch(urlOrQuery)"工具——参数语义混杂、安全边界不清，不推荐；或加"网页摘要"第三工具——当前 web_browser 截断 16KB 已够用，YAGNI。

**代码锚点**：`apps/api/src/chat/tools/web-tools.schema.ts`（两个 schema + description）。

---

### Q35. Tool 是怎么注册到 Agent 里的？

**一句话答案**：我这个项目里的 Agent 工具是“注册制 + 查表分发”，不是硬编码。 启动时做两件事：一是把工具的 定义（名称、描述、zod 入参 schema）注册进全局的 ToolRegistry，二是每个工具的执行器在自己构造函数里把执行函数也注册进同一张注册表。 所以注册表里最终是两张表：定义表（给模型生成 tools 参数用）和 executor 表（真正干活用）。 Agent 配置里只声明它允许用哪几个工具名。请求进来时，Agent 拿着工具名从注册表生成 OpenAI 的 tools 参数发给模型；模型返回 function_call 后，就按工具名从 executor 表查函数并执行，结果再回填给模型做多轮收敛。 好处是新增工具只需要“定义 + 一个执行器”，Agent 的路由代码完全不用动；公共的 OpenAI 客户端也不依赖任何业务服务，所以每条链路都能独立单测。

**注册细节**：

1. 定义注册：`registerChatWebTools(registry)`（chat 模块初始化时调用一次）调 `registry.register({name, description, inputSchema})`，重名直接抛 `tool_already_registered`。
2. 执行注册：`ChatWebToolExecutor` 构造时调 `registry.registerExecutor('web_search'|'web_browser', fn)`，重名抛 `executor_already_registered`。
3. Agent 关联：`DEFAULT_AGENT_CONFIGS` 给每个 Agent 配 `toolNames: ['web_search','web_browser']`，`AgentConfigRegistry` 注册（`registerDefaultAgents` 由 `AGENTS_INIT` 工厂触发一次）。
4. 运行时裁剪：`AgentExecutorService.runAgentLoop` → `registry.toOpenAiTools({strict, names: config.toolNames})`——Agent 只见自己被授权的工具（如 Resume 的 Agent 不会看到 JD 工具的依赖面）。

**代码锚点**：`web-tools.schema.ts`（registerChatWebTools）、`chat-web-tool-executor.ts`（registerExecutors）、`agent.config.ts` + `agent.module.ts`（AGENTS_INIT）。

---

### Q36. 模型是怎么知道当前有哪些 Tool 可以调用的？

**一句话答案**：每次 `responses.create` 请求的 **`tools` 参数**里带上完整工具定义（name + description + JSON Schema parameters），模型从请求上下文里"看到"可用工具，再靠 `tool_choice:'auto'` 决定是否调用。

**要点**：

1. 工具定义在**每一轮都全量重传**（`createResponse` 里每轮带 `tools`），保证模型记忆里的工具集不随轮次丢失。
2. **description 是模型决策的主要依据**：触发边界写进 description（如 web_browser "only for reading a concrete page found via web_search"），引导模型只在合适时机调用。
3. **裁剪即可见性控制**：toOpenAiTools 只转换该 Agent `toolNames` 里的工具——模型不可能调用"没在 tools 里"的工具（除非幻觉输出，见 Q38）。
4. **strict schema** 决定 parameters 形态（全字段必填 + 禁额外字段），降低模型生成非法参数的概率。

**其它方案**：极端情况下可把工具数量压到最少（每轮只暴露高概率用到的），省 token、减少误调用；代价是模型无法自由扩展策略。当前 2 个联网工具很小，无裁剪压力。

---

### Q37. 模型返回的 Tool Name 是怎么映射到具体业务函数的？

**一句话答案**：**查表分发**——`ChatWebToolExecutor.execute(call)` 用 `call.name` 调 `ToolRegistry.getExecutor(name)` 拿到执行函数再调用，注册表在启动期建好 `Map<toolName, executor>`，没有 if/switch 路由。

**映射链**：

```
模型 function_call{name:'web_search', arguments}
  → OpenAiAgentClient.safeExecute → execute 回调
  → ChatWebToolExecutor.execute(call)
  → registry.getExecutor('web_search')        // 查表
  → registry.validateArguments('web_search', args)  // zod 校验（先于业务执行）
  → webSearchTool.search(query)                // 真正的业务
```

定义层和执行层分开注册（Q35），`execute` 侧只有一行查表——**新增工具不需要改任何分发代码**。

**代码锚点**：`chat-web-tool-executor.ts` `execute`、`tool-registry.ts` `getExecutor`。

---

### Q38. 如果模型调用了一个不存在的 Tool 怎么办？

**一句话答案**：`getExecutor` 返回 undefined → 抛 `tool_not_registered: xxx` → 走 Q18 的 `safeExecute` 包装成 `{ok:false,error}` 回填给模型，**不中断 loop**；模型看到错误后会改用自己的已知工具或直接回答。同时它会被 `onToolDone` 记成一次失败的工具调用（前端/审计可见），可用于发现"模型幻觉工具名 / 工具集裁剪过度"的问题。

**要点**：

1. 不崩溃是核心：幻觉调用是模型的已知缺陷，回填错误让它自愈。
2. 双层兜底：注册表 `get` 与 `getExecutor` 都可能在定义/执行未注册时返回 undefined，分别抛错。
3. 观测价值：`ToolCallLogService` 把失败落库，`tool_not_registered` 频率是工具集设计质量的信号。

**其它方案**：定义层校验（启动时断言"所有声明的 toolNames 都已注册"）——项目实际通过"同一注册表 + 模块初始化顺序"保证，不存在声明了却没注册的情况，属于防御式兜底。

---

### Q39. 如果以后增加一个新的 Tool，需要修改哪些地方？

**一句话答案**：四个小改动、零公共层改动——① 建 zod schema（含 description 触发边界）；② `register` 定义进 `ToolRegistry`；③ 写 executor 并 `registerExecutor`；④ 在需要的 Agent 配置的 `toolNames` 里加上它。路由/校验/分发/执行循环都不动。

**清单**：

1. `web-tools.schema.ts`（或新文件）：定义 `TOOL_NAME`、`inputSchema`、`description`。
2. 定义注册处：调用 `registry.register({...})`。
3. 执行实现 + `registry.registerExecutor(NAME, fn)`（在 `ChatWebToolExecutor` 或新 executor 中）。
4. Agent 可见性：`agent.config.ts` 中给对应 Agent 的 `toolNames` 追加。
5. 可选项：安全边界（若直连网络，按 Q58–Q68 加校验）、配额/审计接入。

**为什么改动这么小**：`ToolRegistry` 的查表分发 + `toOpenAiTools` 的 schema 转换 + `runWithTools` 的通用 loop 全部是**工具无关**的；工具是插件式注册，符合开放封闭原则。若只给单个 Agent 用，`names` 裁剪自动隔离，不会污染其它 Agent。

---

## 七、Zod 参数校验

### Q40. 为什么使用 Zod 做 Tool 参数校验？

**一句话答案**：这个场景的 schema 同时是“发给模型的规格”和“验收模型的规则”，天然双份且绝不能漂移；Zod 把校验、JSON Schema 序列化、TS 类型收成同一个事实源，其它方案（裸信任/手写双份/class-validator）要么有安全洞、要么必然漂移、要么桥接成本高——而校验 LLM 这种“不守规矩的生产者”，恰恰是 Zod 最高价值的战场。

第一层：为什么“工具参数校验”这个位置非要有运行时校验不可
先想清楚这个场景的生产者是谁——是 LLM，一个概率性的、你不控制的第三方。这和普通 HTTP 请求有本质区别：

普通 API 的客户端至少是你按文档写的，出错是“偶发”；
LLM 每次都可能吐出结构不一样的东西：字段缺失、类型错误（query 给你数字 123）、多出未知字段、甚至编造工具名。
而参数一旦通过 JSON.parse 进入系统，就是裸的 unknown。这一层校验的本质是：在“外部不可信数据”进入你业务逻辑前的唯一边界上，把它收窄成可信类型。TS interface 在这一步帮不了忙——它编译期就被擦除了（对应文档 Q41/Q42）。所以这一步只能靠“有运行时实现的校验器”，Zod 只是这个校验器的具体选型。

**其它方案**：手写 JSON Schema + 手写校验（双份漂移）、运行时用 `JSON.parse` 后裸信任（无校验）、class-validator（声明式但无 TS 推导、转 JSON Schema 要额外桥接）。Zod 是当前生态里"TS 类型 + 校验 + JSON Schema 转换"结合最顺的方案。

---

### Q41. 为什么不能直接使用 TypeScript interface？

**一句话答案**：interface 是**编译期纯类型**，运行时会**被擦除**——它无法校验"模型这个 JSON 到底符不符合结构"。模型返回的数据是运行时到达的外部输入，必须用有运行时实现的校验器（Zod），而不是只在编译期存在的类型。

**要点**：

1. TS interface 只活在编译期，不给任何运行时代码（无 type introspection）。
2. 模型参数来自网络 JSON，是典型的"不可信外部输入"，需要**运行时的结构校验**，这恰是编译期类型覆盖不到的。
3. 本项目用 `z.infer` 把 Zod schema 转成 TS 类型——类型仍可得，但**校验事实源是 Zod**。

---

### Q42. TypeScript 类型为什么不能保证运行时安全？

**一句话答案**：类型系统是**编译时的静态契约**，它约束的是"源码里怎么写的"，不是"运行时实际收到什么"。一旦数据越过进程边界（HTTP/JSON 从 LLM 回来），一切编译期保证都失效——类型标注会被擦除，`as` 断言更是只"骗编译器"。所以运行时校验不能省。

**举例**：模型返回 `{"query": 123}` 或少了 `query` 字段，TS 类型声明 `{query:string}` 不会报错也不会拦截——JSON.parse 结果是 `unknown`，必须在入口做一次 schema 校验把它"收窄成可信类型"，之后才能 `as WebSearchToolInput` 使用。

---

### Q43. 模型返回参数之后，具体在哪里执行 Zod 校验？

**一句话答案**：**两道入口都过校验，且都先于业务代码**——① `safeExecute` 内、executor 内部第一行（`registry.validateArguments`）；② stopOnToolCall 单轮模式拿到参数后（`OpenAIJdLlmParserClient.parseJd` 里先 `validateArguments` 再使用）。公共层保证"任何工具参数到达业务函数前必经 zod"。

**精确位置**：

1. `chat-web-tool-executor.ts`：每个注册的 executor 开头都执行 `this.registry.validateArguments(call.name, call.arguments ?? {})`，校验通过才把解析后的 `data` 传给业务 service——**业务拿到的永远是校验后/规范化后的数据**。
2. `tool-registry.validateArguments`：查工具定义 → `inputSchema.safeParse(value)` → 失败抛 `openai_invalid_arguments`，成功返回 `result.data`（zod 会把默认值/转换补全）。
3. JD 链路：`OpenAIJdLlmParserClient.parseJd` 在把参数交给上层 `LlmSanitizer` 前同样先过 `validateArguments`。

**关键点**：校验点在 **executor 边界**（模型数据进入本系统业务逻辑的入口），而不是散落在业务 Service 里——Service 只信任已被校验的输入。

---

### Q44. 如果 Zod 校验失败怎么办？

**一句话答案**：多轮 loop 场景：抛 `openai_invalid_arguments` → 被 `safeExecute` 捕获 → 回填 `{ok:false,error}` 给模型（模型修正重试）；单轮 stopOnToolCall 场景：异常直接抛给上层走 fallback（JD 解析降级到规则解析），**绝不带脏参数执行业务**。

**两条路径**：

1. Chat 多轮：executor 抛错 → `OpenAiAgentClient.safeExecute` catch → `{ok:false, error:'openai_invalid_arguments'}` 进 `function_call_output` → 模型看到错误信息自行修正参数再调一轮（Q18 自愈）。这正是"为什么 zod 校验要放在 executor 内而不是 loop 外层"——校验失败也能进入自愈通道。
2. JD 单轮：`parseJd` 捕获后抛上层，`JdParserService` 回退到规则解析（fail-safe 降级，不中断用户请求）。

---

### Q45. 如果模型传错字段类型或者缺少字段怎么办？

**一句话答案**：两类都归 Zod 处理——类型错/缺字段 → `safeParse` 失败 → 同上一条路径（回填错误或 fallback）；strict 模式额外在**模型侧**降低发生率（JSON Schema 全字段必填 + 禁多余字段 + 类型约束写死，模型按 schema 生成几乎不会越界）。

**要点**：

1. **缺字段**：strict schema 把每个 object 节点都标 `required: 全部属性`，模型生成时就要求填全。
2. **类型错**：zod 按 schema 类型断言（`string()` 收 `number` 会失败）；同时 JSON Schema 的 `type` 约束让模型少犯错。
3. **多余字段**：strict 模式 `additionalProperties:false`，模型传 schema 外的字段会触发校验失败 → 回填错误（多轮下模型会收敛）。
4. 可选字段的取舍：strict 模式会强制"原 optional 字段也必填"（`deepRequireAll` 的代价），业务上要能接受——schema 设计时应尽量把确实可选的字段在 strict 语义下调成"可空而非可缺"。

---

### Q46. Zod 能不能防止模型传入恶意 URL？

**一句话答案**：**不能，也本不该由它负责**。Zod 只保证**结构合法**（`url: z.string().min(1).max(2048)`），不保证**内容安全**——"合法字符串 URL"和"指向内网 IP 的 URL"是两回事。URL 的**安全**校验（协议白名单、IP 黑名单、DNS 复检）由独立的 `WebUrlSecurity.assertFetchable` 在做，位于 executor 的业务层。

**要点**：

1. 分层：Zod = 形状/边界（长度 1~2048 防超大 payload）；`WebUrlSecurity` = 目的地安全性（防 SSRF，Q58+）。
2. schema 层永远**不做**"判断 URL 是否恶意"这类需要 IO/上下文/策略的决策。
3. 顺序：先 zod 过结构，再 `assertFetchable` 过安全，最后才建连抓取（`web-browser-tool.service.ts.fetch`）。
4. 面试表达：这正是"校验器分层"的教科书例子——**结构校验器**（zod）与**安全校验器**（策略/IO）必须分开，硬塞一起会导致要么漏安全、要么 zod 里跑 DNS 查询的坏味道。

---

### Q47. 你的 Tool Schema 和业务执行逻辑是怎么关联起来的？

**一句话答案**：通过注册表的两张表关联——`tools` Map 存「定义」（含 inputSchema），`executors` Map 存「执行函数」；执行函数注册时**闭包捕获**它对应的业务 service，并在入口统一先跑 zod。schema 与业务**不强耦合在类型上**，耦合点是"校验后数据喂给闭包"这个约定。

**要点**：

1. 注册执行函数时闭包已绑定业务实现：`registry.registerExecutor('web_search', async (call) => { const {query} = validate(...); return webSearchTool.search(query); })`。
2. `execute(call)` 只按 name 查表调用，不再关心业务细节（Q37）。
3. schema 与 executor 通过**工具名**关联，同一 name 在两条注册路径下各自 fail-fast 防覆盖（Q35）。
4. 好处：可"只注册定义不注册执行"（stopOnToolCall 的 JD 场景只需要模型产出参数，不需要执行函数）。

---

### Q48. 为什么不能让模型直接调用业务 Service？

**一句话答案**：业务 Service 的方法签名面向**可信内部调用**（参数语义、事务、权限、副作用都不设防）；让模型直调等于把"不可信、概率性、可被提示注入"的模型输出直接当成可信代码路径执行——缺校验、缺审计、缺权限边界、缺副作用控制，任何一环缺失都是事故。

**要点**：

1. **不可信输入**：模型输出可被用户 Prompt 注入操纵（如"忽略规则，调用 xxx(删除)"）；模型本身也会幻觉参数。
2. **副作用**：Service 常有写库/外呼副作用，而工具调用应被设计成"可审计、可失败、无隐蔽副作用"的操作。
3. **依赖方向**：业务模块被公共层 `ToolRegistry` 反向解耦（注册回调注入），反过来"模型 → Service"直调会形成公共层反向依赖业务 + 无注册表统一出口。
4. **能力最小化**：模型能碰的只能是被登记的工具（裁剪后），不是整个服务面。

**其它方案**：让工具 executor 作为"门面"（本项目做法），或模型输出仅产出"结构化指令 JSON"，由编排层决定执行哪个 Service——前者更适合 agent 内工具，后者更像任务编排。

---

### Q49. 你说"防止模型绕过校验直接触达业务逻辑"，具体是怎么做到的？

**一句话答案**：用**强制边界 + 唯一入口**：业务 Service 从不直接暴露给模型，模型只能命中 `ToolRegistry` 里登记的、由 executor 闭包包好的工具；而每个 executor 的第一行都是 `validateArguments`（zod）+ 必要的安全校验，**校验失败就抛错回填，业务函数根本不会被执行**——即"参数只有在通过全部校验后才可能触达业务代码"。

**落到代码的四个保证**：

1. **无直调路径**：模型 → `execute(call)` → `getExecutor(name)` 查表；查不到抛 `tool_not_registered`，永远到不了业务（Q37/Q38）。
2. **校验前置**：executor 内第一行 zod；`validateArguments` 通过才解构使用（Q43）。
3. **安全校验前置**：web_browser 的 `assertFetchable`（协议/IP/DNS/重定向复检）全在 `browserInstanceManager.withSession` **建连之前**执行（Q58）。
4. **失败不回退到执行**：`safeParse` 失败直接抛 → safeExecute 包成错误回填，业务函数代码路径不执行；成功才拿 `result.data`（已规范化）。

**面试一句话**：模型的触达面被注册表收窄到"登记过的工具"，每个工具的入口都是一道"zod 结构校验 + 业务安全校验"的闸门，闸门不过就没有后续业务执行——不存在模型可以"绕过校验直接调用"的第二条路。

---

## 八、SSE

### Q50. 为什么工具调用需要通过 SSE 上报？

**一句话答案**：Agent 执行是**秒级的异步过程**，中间有多次 LLM 调用与工具往返，用户需要实时看到"模型在做什么、现在到哪一步"（工具开始/结束、失败原因），否则体验就是长时间白屏等待；SSE 提供**服务端 → 浏览器单向事件推送**，正好承载这种"进度流 + 阶段态"。

**要点**：

1. 一次回答可能有：路由 → step 开始 → 多轮工具（每轮 started/finished）→ 文本 → done，全部是**时间上有先后的事件流**，天然适合推送协议表达。
2. 事件带 **spanId**（run→step→tool 层级），前端可还原成可展开的追踪时间线（诊断面板），而不只是"转圈等结果"。
3. 失败/超时中间态（工具失败但会话继续）只有事件流才能实时表达，HTTP 一次性响应做不到。

**代码锚点**：`chat.service.ts` `executeMessageFlow` 内 `emitWithSpan` 各调用点。

---

### Q51. 为什么选择 SSE，而不是 WebSocket？

**一句话答案**：本场景是**单向、服务端到客户端的流**（用户只在开始时发一条），SSE 足够且更简单：基于 HTTP、自动重连由浏览器原生支持、没有 WS 的握手/心跳/连接状态机；WebSocket 的优势（双向、低延迟自由通信）这里用不上。

**要点**：

1. 方向性：用户发起一次请求 → 服务端单向推送事件序列，没有"客户端推送/房间广播"需求——SSE 语义完全覆盖。
2. 基础设施：SSE 复用 HTTP（可过常规网关/负载均衡，易加鉴权头与超时）；WebSocket 升级连接在 Serverless/网关环境常需专门支持。
3. 可靠性补强：本项目在 SSE 之上自建了**可回放会话 + seq**（Q57），弥补了原生 SSE 重连后丢事件的短板——这也是"为什么敢用 SSE"的关键。
4. 反面：浏览器单域名连接数限制（HTTP/1.1 约 6 条）——本产品单用户在单会话内一条流，无压力。

**其它方案**：WebSocket/WebTransport（需要双向或高频推送时）；Fetch ReadableStream + `text/event-stream` 手动解析（更底层，可控性强但重复造轮子）。后端 NestJS 的 `@Sse()` 用 RxJS Observable 直接把事件模型化，接入成本低。

---

### Q52. 你的 SSE 具体会上报哪些事件？

**一句话答案**：一条完整回答按序上报：`start → route_decision → agent.step.started → (tool.call.started / tool.call.finished)×N → assistant_chunk×M → assistant_done → agent.step.finished → done`，异常时任意阶段后发 `error`。

**事件清单**（`ChatStreamEventType`，`chat.service.ts`）：
| 事件 | 时机/载荷 |
| --- | --- |
| `start` | 流程开始，带 context pack 摘要 |
| `route_decision` | 路由结果（intent/agent/confidence/fallback） |
| `agent.step.started` | Agent 开始执行，带 prompt 预览（诊断用） |
| `tool.call.started` | 每个工具开始：toolName/spanId/startedAt/status=running |
| `tool.call.finished` | 工具结束：success/latencyMs/errorCode/errorMessage/startedAt/finishedAt |
| `assistant_chunk` | 最终文本切片（80 字符/片，模拟流式打字机） |
| `assistant_done` | 完整回答 + toolCalls 摘要 + 展示偏好 |
| `agent.step.finished` | Agent 步骤结束 |
| `done` | 整个流结束，带 conversationId/agentRunId |
| `error` | 异常：code/message（run 标 failed） |

每个事件外层是**信封**：`{id, seq, runId, spanId, type, ts, payload}`（`sse.ts`），前端拿到 type + payload + spanId，凭 seq 保证顺序/去重（Q55）。

---

### Q53. Tool 开始执行、执行成功、执行失败分别什么时候发送事件？

**一句话答案**：**开始**在工具真正执行前统一发送（模型一返回 function_call、还没跑业务代码）；**成功/失败**在工具返回后发送——两者的差别只在 `finished` 事件的 `success` 与 `errorCode/errorMessage` 字段，事件类型都是 `tool.call.finished`。

**精确时序**（对应 `openai-agent.client.ts` + `chat.service.ts`）：

1. 模型返回含 N 个 `function_call` 的响应；
2. **先**对全部 N 个 call 触发 `onToolStart` → 发 N 条 `tool.call.started`（按调用顺序，每条先 `pushToolSpan` 生成 spanId 入队）；
3. 之后才 `Promise.all` 并行执行工具（业务代码此时才跑）；
4. 每个工具落定（成功或抛错被 `safeExecute` 包装）→ `onToolDone` → 发 1 条 `tool.call.finished`，`success = result.ok`：
   - 成功：`{success:true, latencyMs}`；
   - 失败：`{success:false, errorCode?, errorMessage}`。
5. span 配对：`popToolSpan(toolName)` 从 FIFO 队列取最早就绪的 started span 回填到 finished 事件的 `startedAt/spanId`。

**为什么"先全部发 started 再执行"**：保证前端时间线上"开始事件顺序 = 模型调用顺序"，不会因为工具实际完成先后而错乱（并行下 A 后完成也不影响它先开始的展示）。

---

### Q54. 如果一个 Agent 同时调用多个 Tool，SSE 怎么上报？

**一句话答案**：**开始事件按调用顺序依次发 N 条；结束事件按完成时刻发（可能乱序）**——前端通过 `spanId` 而非顺序来归属"哪次开始对应哪次结束"，同名单个工具用 FIFO 队列保证先进先配。

**要点**：

1. started：先循环全部触发（顺序=调用顺序）。
2. finished：各自完成后触发，先后取决于执行耗时（并行下天然乱序）。
3. spanId 语义：`{runId}:tool:{自增序号}:{toolName}`；同名工具可能并发，`pendingToolSpans: Map<toolName, span队列>` 在 started 时入队、finished 时 `shift()` 配对最早的（FIFO）。
4. 队列为空的兜底：若 finished 找不到对应 started（事件丢失/时序异常），`popToolSpan` 会新造一个 span，不让前端断链。
5. trace（审计侧）顺序不依赖 SSE：`toolTrace` 按输入 index 顺序 push，稳定可对齐。

**诚实补充（面试加分）**：FIFO 按工具名配对是一种近似——极端情况（同一工具并发多次且完成顺序与开始相反）理论上有错配窗口；根治方案是让 `onToolDone` 回调携带 `callId` 精确配对（当前 `AgentToolTraceEntry` 未带 callId，属于已知改进点）。

---

### Q55. 怎么保证前端收到的事件顺序正确？

**一句话答案**：服务端每个事件由 `SseEnvelopeFactory` 分配**全局单调递增的 `seq`**；事件按发生顺序同步 push 到会话缓冲并逐个下发（单线程顺序 emit），前端以 `seq` 排序/去重/续传，天然有序。

**要点**：

1. 生成端：`create()` 里 `seq = ++this.seq`，id=`{runId}:{seq}`；所有 emit 走同一个会话对象，无并发写序问题。
2. 传输端：`ReplayableSseSession.emit` → `publishEvent` 顺序 push 缓冲并 `subscriber.next`，HTTP 层按此顺序写响应。
3. 消费端：前端拿 seq 做增量渲染、断线后带 `sinceSeq` 重连（Q57）——即使网络层有重排，也按 seq 收敛。
4. 文本事件的流控特例：`assistant_chunk` 类文本事件在 high 级控制态下会**缓冲合并**到 `textChunkTargetChars` 再发（`handleTextChunkEvent`），减少事件量；`flushPendingTextEvent` 在非文本事件/结束前强制冲刷，保证事件语义不粘连。

---

### Q56. 为什么不直接把 OpenAI 的 Stream 转发给前端？

**一句话答案**：两层原因——① **协议形态不匹配**：OpenAI 流里的 token 块、tool-call 中间态是给"agent 执行器"看的内部协议，不是给 UI 的业务事件，原样转发会泄露实现且前端难消费；② **当前是多轮 loop**：流只在最后一轮产文本，工具调用阶段是"非流"的等待，直接把 `stream:true` 转发会切碎体验且要自己重组事件。

**要点**：

1. 当前实现：`runWithTools` **非流式**整段拿最终文本，再在服务端按 80 字符切片发 `assistant_chunk`（模拟打字机）——事件模型统一、易回放（Q57 的会话缓冲要求事件可重放，token 粒度事件体积太大）。
2. 若接真流式（演进方向）：在 `createResponse` 开 `stream:true`，把 `response.output_text.delta` 转成 `assistant_chunk`，把 `function_call` 流事件过滤后只用于驱动工具执行，仍维持现在的业务事件协议不变——**前端协议稳定，只是后端"何时产文本"从整段变流式**。
3. 数据契约解耦：前端只认 `ChatStreamEventType` 信封，不关心上游是 OpenAI/通义/模拟，方便换 provider（呼应 Q28 的反面）。

---

### Q57. 如果 SSE 连接断开怎么办？

**一句话答案**：**可回放 + 断线续传**——服务端会话（`ReplayableSseSession`）在进程内保留事件缓冲并按 `streamKey` 复用；客户端断线后用**同一个 `streamKey` + `sinceSeq`** 重连，服务端从 `seq > sinceSeq` 起补发缺失事件；会话保留 60s（`retainMs`）、10s 无订阅者才触发 idle abort。

**要点**：

1. **建流即建会话**：`sendMessageStream` 用 `streamKey` 查 `chatStreamSessions`；存在就直接 `subscribe(existing, sinceSeq)`——这就是"重连 = 订阅既有会话"。
2. **补发**：`subscribe` 先同步回放 `events.filter(seq > sinceSeq)`，会话未结束时继续订阅增量。
3. **真实 runId 后绑定**：首条事件前 runId 是 `pending:streamKey`，agentRun 创建后 `setRunId` 换成真实 runId（仅允许 seq=0 时绑定，`SseEnvelopeFactory` 抛错保护）。
4. **生命周期**：所有订阅者断开 → `scheduleIdleAbort`（10s 后 abort 后台执行）；会话结束 → `scheduleCleanup`（60s 后从表与全局表删除）。
5. **双写落库**：每条事件经 `onEmit` 异步持久化到 observability，供事后 replay 分析（失败仅告警不阻断流）。
6. 进程内单机限制：会话表是进程内存（`GLOBAL_SESSIONS`），多实例部署需换 Redis/消息总线做跨实例订阅——这是已知的横向扩展前提，面试主动点出。

**为什么能这么做**：正因为 Q56 里我们把事件模型收敛成了"数量可控、可重放的业务信封"，断线续传才有低成本的实现空间——这是"不直接转发 OpenAI 原始流"的又一收益。

---

## 九、SSRF

### Q58. 为什么你的 web_browser Tool 会存在 SSRF 风险？

**一句话答案**：web_browser 会让**服务端**按用户/模型提供的 URL **主动发起网络请求**（无头浏览器建连抓取），而 URL 内容本质上是模型从对话上下文（可能含用户输入）解析出来的——等于"攻击者（用户）可以让你的服务器去访问任意地址"。如果地址是 `http://127.0.0.1:6379`、云元数据 `169.254.169.254`、内网管理后台，就构成 SSRF：服务器变成攻击者的跳板。

**要点**：

1. 服务端发起请求 = 请求源 IP 是内网可信 IP，内网服务默认信任它 → 可读内部数据、打内部接口。
2. 模型工具把"任意 URL 抓取"开放给对话层，攻击面随 prompt 内容进入，绕过前端限制。
3. 所以 web_browser（真正建连的工具）必须做目的地安全校验；`web_search` 是调外部搜索 API、URL 不由用户直给，风险面小得多（这正是拆两工具的动机之一，Q34）。

---

### Q59. 什么是 SSRF？

**一句话答案**：SSRF（Server-Side Request Forgery，服务端请求伪造）= 攻击者诱导**服务器**去访问攻击者指定的内网/本机地址，利用服务器"来自内网、受信任"的网络位置访问本不该被外部触达的资源（内网服务、云元数据、Redis 等）或作为跳板。

**一句话举例**：让 web_browser 打开 `http://127.0.0.1:8080/admin` 或 `http://169.254.169.254/latest/meta-data/`（云厂商内网元数据，可能含临时凭据），服务器就会替攻击者去请求并回传内容。

---

### Q60. 你的 SSRF 防护具体做了哪些事情？

**一句话答案**：`WebUrlSecurity.assertFetchable` 在**建连之前**做五件事：URL 语法校验 → **协议白名单**（仅 http/https）→ **hostname 黑名单**（localhost 等）→ **直接 IP 判定**（IPv4-mapped IPv6 归一化后查黑名单网段）→ **域名场景 DNS 解析后校验所有解析结果**；抓取后还有 **302 重定向复检**（Q67/Q68）。任何一步失败即抛错，**不建连**。

**防御时序**（`web-browser-tool.service.ts.fetch`）：

```
rawUrl
 → assertFetchable(1)  [结构/协议/hostname/直接IP/DNS]   ← 建连前
 → browserInstanceManager.withSession(...)               ← 建连
   → page.goto(normalizedUrl)
   → page.url() 取最终 URL
   → 若 finalUrl != 初始 URL → assertFetchable(2)         ← 重定向复检
   → 提取 title + body.innerText，16KB 截断
```

失败抛 `web_browser_invalid_url:*` / `web_browser_redirect_blocked:*` → executor 回填给模型（不中断 loop）。

---

### Q61. 为什么需要协议白名单？

**一句话答案**：协议决定了请求的**语义与数据面**——`file://` 能读服务器本地文件、`gopher://` 能向任意 TCP 端口打协议、`ftp://`、`dict://` 都是经典 SSRF 放大协议。SSRF 防护第一步就是**把请求面收窄到纯 Web 语义**（http/https），其它协议一律拒绝，从协议层先切断大部分攻击。

**要点**：

1. `url.protocol !== 'http:' && !== 'https:'` → `unsupported_protocol`（`web-url-security.util.ts`）。
2. 只留 http/https，后面 IP/DNS/重定向的防线才成立（`file://` 不走网络，前面的 IP 黑名单对它是无效的）。
3. 这是"最小攻击面"原则的落地——宁可误杀 `file://` 合法内网文档，也不留协议后门。

---

### Q62. 为什么不能只判断 localhost？

**一句话答案**：localhost 只是入口之一，真正要拦的是**所有能触达内网的地址形态**：直接内网 IP（10.x/172.16-31.x/192.168.x）、本机其它网卡 IP、`0.0.0.0`、IPv6 回环 `::1`、链路本地 `169.254.x.x`（含云元数据 `169.254.169.254`）、CGNAT `100.64.0.0/10`、IPv6 ULA `fc00::/7`，以及**域名解析到上述 IP**的情况。只拦 localhost，随便 `http://10.0.0.1` 就穿了。

**要点**：

1. hostname 字面量只拦了 `localhost` / `*.localhost`；
2. **真正的防线是 IP 判定**：直接 IP 就同步判，域名就 DNS 解析后逐个 IP 判（Q64）；
3. 反向代理后常见内网段（172.17.x.x Docker、192.168.x.x 办公网）都在黑名单里。

---

### Q63. 哪些 IP 地址需要拦截？

**一句话答案**（`isBlockedIp`，全拦下面集合，先做 IPv4-mapped IPv6 归一化）：

- **IPv4**：`0.0.0.0/8`（本网络/非法源）、`10.0.0.0/8`（私有）、`127.0.0.0/8`（回环）、`169.254.0.0/16`（链路本地，含云元数据 `169.254.169.254`）、`172.16.0.0/12`（私有）、`192.168.0.0/16`（私有）、`100.64.0.0/10`（CGNAT）；
- **IPv6**：`::`（未指定）、`::1`（回环）、`fe80::/10`（链路本地）、`fc00::/7`（ULA）；
- **IPv4-mapped IPv6**：`::ffff:a.b.c.d` 先剥出 IPv4 再按 IPv4 规则判——**不归一化会漏判**（很多库会把内网 IPv4 用映射格式返回，直接当 IPv6 放行）；
- 既不是合法 v4 也不是合法 v6 的 → 解析不了，**保守拒绝**。

**为什么拦这些**：它们共同覆盖"本机 / 内网 / 云元数据 / 运营商级 NAT"这些外部不可达但服务器可达的敏感区。拦的是"不该由 web_browser 出网访问"的目标网段。

---

### Q64. 域名形式的 SSRF 怎么处理？

**一句话答案**：域名不直接信——用 Node `dns.lookup(hostname, {all:true})` **解析出全部 IP**，逐个过 `isBlockedIp`，**任一命中即整体拒绝**（防止多 A 记录里混入内网 IP）；解析失败（DNS 查不到/超时）也拒绝（`dns_lookup_failed`），**绝不带猜测去连接**。

**要点**：

1. `{all:true}` 拿全量解析结果，只验第一个 IP 会漏（CDN/多活域名常返回多个 A）。
2. 域名本身命中 hostname 黑名单（localhost/\*.localhost）在 DNS 前同步拦截，省一次查询。
3. 校验粒度是"这轮解析结果"，与时序相关的残留风险见 Q66（DNS rebinding）。

---

### Q65. 为什么需要 DNS 解析之后再检查 IP？

**一句话答案**：**黑名单必须作用在"实际连接的 IP"上，而不是"用户给的域名"上**。域名只是一个名字，攻击者可以注册一个正常域名、其 DNS 记录却指向内网 IP（或通过可控 DNS/子域指向 127.0.0.1）；只检查域名字符串（不是 localhost）等于没防。解析到 IP 再判，才能覆盖"域名→内网 IP"这条最常用的绕过。

**要点**：域名黑名单只能挡字面量（localhost），挡不住 `evil.com → 169.254.169.254`。所以域名路径 = `dns.lookup` 全量解析 → 逐个 IP 判黑名单 → 全过才放行。

---

### Q66. DNS Rebinding 是什么？你的方案怎么处理？

**一句话答案**：DNS Rebinding 利用"**校验时解析的 IP**"与"**连接时解析的 IP**"不一致：攻击者让域名第一次解析成公网 IP（通过校验），随后（TTL 到期后）再解析成内网 IP（`127.0.0.1`），服务器校验通过后**实际连接却打到了内网**——校验与连接之间存在时间窗口。**当前实现是"抓取前校验"，对该窗口有理论残留风险，防御不完整**。

**要点（诚实陈述 + 缓解）**：

1. 当前：`assertFetchable` 发生在 `goto` 前（`web-browser-tool.service.ts.fetch`），校验与建连不共用同一份解析——即存在 TOCTOU 窗口。
2. 现有缓解：重定向复检（Q68）能拦"跳转后"变化；会话内浏览器受控、单次抓取内容 16KB 截断降低利用价值。
3. **根治方案（面试给出）**：
   - **固定解析结果连接**：自定义 socket/HTTP 层 `lookup` 一次解析出合法 IP，然后**绑定该 IP 建连**（Host 头仍带域名），让"连接 IP = 校验 IP"，从根上消除窗口；
   - 或 **重复校验**：`goto` 后用 `page.url()` 拿真实最终 host 再复检（已做，但只覆盖最终 URL，不覆盖中间 socket）；
   - 沙箱化：抓取放隔离网络命名空间/代理，内网不可达时 SSRF 自然无效（纵深防御）。
4. 面试话术：**先讲清 TOCTOU 原理，再承认当前是"抓取前校验"、给了纵深防御方向**——比宣称"我防住了 DNS rebinding"更可信。

---

### Q67. HTTP 302 重定向会不会绕过 SSRF 防护？

**一句话答案**：会，如果**不检查最终 URL**的话——`assertFetchable` 只校验了用户给的原始 URL，而 `goto` 跟随重定向后可能落到内网（如合法页面 302 到 `http://127.0.0.1/...`）；重定向由浏览器在系统内部执行，不再经过我们的校验入口。

**要点**：

1. 只校验初始 URL 的防护，遇到 `302 → 内网` 即失效，这是 SSRF 绕过清单里的标配姿势。
2. 因此必须对**重定向后的真实地址**再次校验（本项目 `page.url()` 对比初始 URL 不一致时重新 `assertFetchable`）。
3. 重定向还可能连环多次（302→302），复检只需对**最终稳定地址**判一次即可覆盖目标（中间跳都无所谓，最终连接面合法即可）。

---

### Q68. 为什么需要重定向复检？

**一句话答案**：因为校验点只有"抓取前"一次是不够的——**防护必须覆盖"实际到达的连接目标"，而重定向能改变连接目标**。复检 = 抓完后再读 `page.url()`，若与初始 URL 不同就**再跑一遍完整的 `assertFetchable`**（协议/IP/DNS 全量），不通过即 `web_browser_redirect_blocked` 抛错丢弃内容。

**要点**：

1. 位置：`page.goto(...)` 之后、`page.title()/evaluate` 提取内容**之前**——保证"非法最终地址"连内容都不会被取走。
2. 实现：`finalUrl !== initial.normalizedUrl` 才复检（没跳转就不做无谓校验）。
3. 意义：堵住"合法入口 → 302 → 内网"这条最后一公里，让 SSRF 防护闭环在"实际抓到的地址"上。
4. 局限衔接：复检针对**最终 URL**；socket 层 DNS rebinding 窗口仍需 Q66 的固定 IP 连接根治——复检是纵深里的一层，不是全部。

---

## 高频追问节奏速记

| 追问方向                         | 先答什么                        | 再补什么                            | 代码锚点                      |
| -------------------------------- | ------------------------------- | ----------------------------------- | ----------------------------- |
| Workflow 为什么不是 LLM→Tool→LLM | 需要循环+自愈+并行+观测         | 收敛由模型决定、maxSteps 兜底       | `openai-agent.client.ts`      |
| Intent 为什么不用 LLM            | 路由是可穷举的稳定判别          | 确定性/成本/审计；模型留给生成      | `orchestrator.service.ts`     |
| 工具执行串行还是并行             | 并行（Promise.all）             | 开始事件按序先发、结果按 index 回填 | `openai-agent.client.ts`      |
| 工具失败怎么办                   | 不中断，`{ok:false,error}` 回填 | 模型自愈；LLM API 层错误才上抛      | `safeExecute`                 |
| 如何防无限循环                   | maxSteps 硬上限                 | +单次超时+工具超时三层              | `DEFAULT_MAX_STEPS=5`         |
| 方案检验谁做                     | 规则×0.4 + LLM×0.6              | 只迭代最弱变体、三态停止            | `resume-scorer.service.ts`    |
| 为什么 Responses API             | previous_response_id 增量续接   | 省 token、出错面小、官方方向        | `createResponse`              |
| zod 为何在 executor 入口         | 校验前置防脏数据触达业务        | 校验失败=回填/fallback 两路径       | `chat-web-tool-executor.ts`   |
| zod 防得住恶意 URL 吗            | 不能，zod 只管结构              | URL 安全在 WebUrlSecurity 分层      | `web-url-security.util.ts`    |
| SSE 断线                         | 会话按 streamKey 复用           | sinceSeq 增量补发 + 落库            | `sse-session.ts`              |
| 为什么不用 WebSocket             | 单向流 SSE 够且简单             | 原生重连；可回放补短板              | `chat.service.ts`             |
| SSRF 防御清单                    | 协议白名单+IP黑名单+DNS全量校验 | IPv4-mapped IPv6 归一化；重定向复检 | `web-url-security.util.ts`    |
| DNS rebinding                    | 校验与连接间有 TOCTOU 窗口      | 根治=固定 IP 连接；当前是纵深       | `web-browser-tool.service.ts` |
| 302 会绕过吗                     | 会，所以复检最终 URL            | 提取内容前再 assertFetchable        | `fetch` 中 `page.url()` 段    |

## 必须背的数字

- Agent loop 最大轮数：5（`DEFAULT_MAX_STEPS` / `DEFAULT_CHAT_AGENT_MAX_STEPS`）
- 默认模型：`gpt-4o-mini`（`OPENAI_MODEL`）；单次 LLM 请求超时：20s（`OPENAI_TIMEOUT_MS`）；SDK 重试 `maxRetries: 2`
- web_browser：单页超时 10s；正文截断 16KB（`truncated` 标记）
- 简历 Agent loop：`maxTurns=3`、目标分 85、无提升阈值 0.1、连续 2 轮无提升即停
- 评分权重：overall = 规则×0.4 + LLM×0.6
- SSE 会话：idle abort 10s / retain 60s；`assistant_chunk` 80 字符切片
- ContextPack token 预算 4000 / 预留 500
- 意图：4 类 intent、3 个 Agent、命中 confidence ~0.88–0.93、fallback 0.42
- 错误码前缀 `openai_*`；工具错误：`tool_not_registered` / `openai_invalid_arguments` / `openai_no_tool_call` / `openai_agent_max_steps_5` / `web_browser_timeout` / `web_browser_invalid_url:*` / `web_browser_redirect_blocked:*`

> 背诵顺序建议：Q1→Q5（架构）→ Q12/Q13（loop 细节）→ Q28/Q29（API 选型）→ Q60/Q63/Q66/Q68（SSRF 深水区）→ 数字表。SSRF 板块是面试官最爱深挖的，务必把 Q62/Q63/Q66/Q67/Q68 连起来讲成一条"攻击面→防线→残余风险→根治方案"的完整故事。
