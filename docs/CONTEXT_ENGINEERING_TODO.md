# 上下文与记忆系统优化待办

> 本文档基于对 `apps/api/src/memory/` 现有实现的代码审计,记录待落地的优化项。
> 每项任务包含:做什么、方案、为什么这么做、相比现有实现的好处。
> 末尾附面试话术,便于在面试场景中清晰表达设计思路。

## 一、现状速览

当前上下文与记忆系统由以下核心模块组成:

- [context-budget-manager.service.ts](../apps/api/src/memory/context-budget-manager.service.ts):在 token/条目预算内从各层挑选记忆,生成 `ContextPack`
- [memory-summarizer.ts](../apps/api/src/memory/memory-summarizer.ts):记忆合并时的 LLM 摘要器(写入侧)
- [memory-store-facade.ts](../apps/api/src/memory/memory-store-facade.ts):runtime + persistent 双层存储门面
- [chat.service.ts](../apps/api/src/chat/chat.service.ts):每次对话调用 `buildContextPack` 组装上下文

**关键观察**:

1. 每次用户对话都会调用 `buildContextPack`,但它做的是"挑选 + 丢弃",不是"摘要"
2. LLM 摘要只在记忆合并写入时触发(mergeStrategy=summarize 且内容 > 2000 字符),不在构建 prompt 时触发
3. 超预算的记忆只记录到 `droppedMemories` 字段,没有降级到长期存储
4. 预算配置是静态的,不随意图变化
5. token 估算用 `字符数 / 4`,中英文混合时误差大
6. `MemoryEntry` 已有 `lastAccessedAt`/`accessCount` 字段,但 `buildContextPack` 完全没用上

---

## 二、待办任务清单(按优先级)

### P0:ContextPack 缓存与增量构建

**做什么**

在 `buildContextPack` 入口加缓存判断,避免每次对话都全量重算。

**方案**

- 在 `ContextPackStore` 之上维护一个会话级的 `lastPackSnapshot`(含 `generatedAt`、`lastMemoryUpdatedAt`、`intent`、`usageRatio`)
- 进入 `buildContextPack` 时先比对:
  - 若本次对话间无新记忆写入,且 `intent` 未变,直接返回上次 pack
  - 若 `usageRatio < 0.6`,返回缓存
  - 若 `0.6 ≤ usageRatio < 0.8`,走增量模式(只追加新记忆,不重排)
  - 若 `usageRatio ≥ 0.8`,走全量重算
- 缓存失效条件:新记忆写入、`intent` 变化、手动 `invalidate`

**为什么这么做**

- 当前每次对话都全量跑 `list → group → sort → select`,即使本次对话没有任何新记忆
- 上下文组装是同步阻塞 LLM 调用的前置步骤,延迟直接影响首字节时间(TTFB)
- 业界(Cursor `/summarize`、Claude Code `/compact`)都是按需触发,不是每次都跑

**相比现有实现的好处**

- 减少无谓的 DB 查询和排序计算,预期降低 60%+ 的上下文构建开销
- TTFB 缩短,用户体验更顺滑
- 为后续引入"渐进式压缩"提供触发点

---

### P1:被丢弃记忆降级到长期存储

**做什么**

超预算被丢弃的记忆不要只记录到 `droppedMemories` 字段就消失,要异步落到 `archived` 存储,供 Agent 主动检索。

**方案**

- 复用现有 `PersistentMemoryStore`,新增 `scope: 'archived'` 作用域
- 在 `buildContextPack` 末尾,把 `droppedMemories` 异步写入归档(不阻塞主流程)
- 暴露 `searchArchivedMemory(query, intent)` 工具,让 Agent 在当前 pack 不足时主动召回
- 归档记忆带 `supersededAt` 时间戳,支持时序查询

**为什么这么做**

- 当前丢弃即消失,丢失了用户长期偏好和早期决策上下文
- Mem0/Letta 的核心思想就是"archival store + 主动检索",把上下文窗口当 RAM,外部存储当硬盘
- Agent 不应该被 200K 窗口限制死,应该能按需扩展

**相比现有实现的好处**

- 跨会话记忆不再丢失,长周期任务能延续
- Agent 获得"主动回忆"能力,而不是被动接受预算裁剪
- 归档可审计、可重放,便于排查"为什么 Agent 忘了某事"

---

### P2:读取侧摘要器(Context Summarizer)

**做什么**

新增读取侧的 LLM 摘要能力,把同层多条记忆压成一段,而不是简单字符串拼接。

**方案**

- 新建 `ContextSummarizer` 服务,复用 `DefaultMemorySummarizer` 的 Dashscope 调用
- 触发条件:
  - `session` 层选中 > 3 条时,合并成一段摘要
  - 整体 `usedTokens > 80% maxTokens` 时,对低优先级层做整体压缩
- 输入从"新旧两条"扩展为"同层多条"
- 摘要结果带 `sourceMemoryIds`,便于溯源

**为什么这么做**

- 当前 `buildBlockContent` 只是 `- ${summary || content}` 的字符串拼接,没有语义压缩
- 写入侧的 summarizer 解决"单条记忆膨胀",读取侧需要解决"多条记忆拼接过长"
- Claude Code 第 4 层"全压缩"就是这种思路:窗口逼近时对历史做整体摘要

**相比现有实现的好处**

- 同样 token 预算下能塞入更多有效信息
- 减少 lost-in-the-middle 问题(中部信息被压缩,关键事实前移)
- LLM 看到的是连贯摘要,而不是散落的条目列表

---

### P3:Intent 驱动的动态预算

**做什么**

用 `routeDecision.intent` 动态调整每层预算,而不是用静态的 `DEFAULT_LAYER_LIMITS`。

**方案**

```ts
function resolveLayerLimitsByIntent(intent: string): LayerLimits {
  if (intent.includes('code')) {
    return { tool_result: { maxItems: 5, maxTokens: 2000 }, session: { maxItems: 1, maxTokens: 400 } };
  }
  if (intent.includes('chat')) {
    return { session: { maxItems: 4, maxTokens: 1600 }, tool_result: { maxItems: 1, maxTokens: 400 } };
  }
  return DEFAULT_LAYER_LIMITS;
}
```

- 在 `buildContextPack` 入口根据 `input.intent` 解析预算
- 保留 `layerLimits` 覆盖参数作为人工干预兜底

**为什么这么做**

- 当前代码任务和闲聊拿到的 `tool_result` 预算一样,明显不合理
- `routeDecision.intent` 已经存在,但只用于路由,没有反哺上下文构建
- Mem0 的 hierarchical memory(user/session/agent)本质就是按场景分配预算

**相比现有实现的好处**

- 不同任务类型获得最合适的上下文配比
- 提高 Agent 在特定任务上的表现(代码任务多看工具结果,闲聊多看历史)
- 预算配置可演进,不写死

---

### P4:细化丢弃原因与可观测

**做什么**

扩展 `ContextPackDropReason`,区分不同丢弃原因,便于后续调优。

**方案**

```ts
type ContextPackDropReason =
  | 'layer_item_limit'      // 现有
  | 'layer_token_limit'     // 现有
  | 'pack_token_limit'      // 现有
  | 'expired'               // 新增:过期
  | 'low_relevance'         // 新增:相关性低于阈值
  | 'superseded'            // 新增:被同 mergeGroup 更新版本覆盖
  | 'stale_tool_result';    // 新增:工具结果已失效
```

- 在 `toDroppedMemory` 调用前根据记忆状态判定原因
- 输出到 `ContextPack.droppedMemories`,前端可视化面板可分类展示

**为什么这么做**

- 当前三种原因都是"预算超限",无法区分"该删的"和"误删的"
- 调优时需要知道:是预算太小,还是记忆没及时清理
- LangGraph 的可观测性就是这么做的:每个状态变化都有原因

**相比现有实现的好处**

- 调优有数据支撑,不再凭感觉
- 前端可向用户解释"为什么这条记忆没被使用"
- 为后续自动化淘汰策略(superseded 自动删)打基础

---

### P5:Token 估算替换为真实 tokenizer

**做什么**

把 `字符数 / 4` 换成精确的 tokenizer 估算。

**方案**

- 引入 `tiktoken` 或 `@anthropic-ai/tokenizer`
- 在 `MemoryStoreFacade.write` 时算一次,缓存到 `tokenEstimate` 字段
- `resolveTokenEstimate` 优先用缓存值,不再每次估算

**为什么这么做**

- 中文 1 字 ≈ 1.5-2 token,`/4` 严重低估中文成本
- 预算判断不准,实际 token 消耗可能比预估高 50%+
- 主流方案(LangChain、Mem0)都缓存精确 token 数,避免重复计算

**相比现有实现的好处**

- 预算判断准确,不会出现"以为没超实际超了"的线上事故
- 写入时算一次,读取时直接用,性能更好
- 可统计真实成本,便于做成本归因

---

### P6:位置感知的 Prompt 布局

**做什么**

利用"注意力位置效应"优化摘要块顺序,对抗 lost-in-the-middle。

**方案**

- 在 `buildSummaryBlocks` 中重排:
  - 最前:`pinned`、`preference`(系统级,高注意力区)
  - 中间:`tool_result`(长内容,即使被弱化也有结构化信息兜底)
  - 最后:与当前 `intent` 最相关的 `session` 记忆(末尾高注意力区)
- 新增 `position` 权重字段,参与排序

**为什么这么做**

- Liu et al. Stanford 2023 证明长上下文中部信息召回率显著下降
- 当前按 `DEFAULT_CONTEXT_BUDGET_LAYER_ORDER` 硬编码顺序,没考虑注意力分布
- Claude Code 在 `/compact` 后会"重新注入最近读的文件、计划",本质就是把关键信息放末尾

**相比现有实现的好处**

- 同样的 token 预算,模型对关键信息的利用率更高
- 减少"明明在上下文里却答错"的幻觉
- 不增加任何成本,只是排序调整

---

### P7:访问追踪与遗忘曲线

**做什么**

激活 `lastAccessedAt` / `accessCount` 字段,引入时间衰减因子。

**方案**

- 每次选中某条记忆后调用 `memoryStore.touch(memoryId)`
- 在 `compareMemories` 排序中加入遗忘因子:
  ```ts
  const forgetScore = memory.accessCount * Math.exp(-daysSinceLastAccess / 7);
  ```
- 长期未访问的记忆主动降权,腾出预算给新记忆
- 可选:定期跑后台任务,把低分记忆归档(对接 P1)

**为什么这么做**

- 当前 `MemoryEntry` 已经有这两个字段,但 `buildContextPack` 完全没用,等于浪费
- Ebbinghaus 遗忘曲线是认知科学经典模型,Zep/Graphiti 也用它做时序衰减
- 不引入遗忘机制,记忆库会无限膨胀,旧记忆挤占新记忆预算

**相比现有实现的好处**

- 记忆库自动"瘦身",不需要人工清理
- 高频访问的记忆自动浮现,低频记忆自动沉底
- 让 Agent 行为更接近人类记忆规律

---

### P8:分层渐进式压缩(参考 Claude Code 7 层)

**做什么**

把当前的"单次挑选 + 丢弃"升级为多级压缩策略。

**方案**

定义压缩级别:

| 级别 | 触发条件 | 动作 |
|---|---|---|
| L0 日常清理 | 每次对话 | 丢弃过期、被覆盖的记忆 |
| L1 微压缩 | usageRatio > 50% | 对最旧 session 记忆做单条摘要 |
| L2 全压缩 | usageRatio > 80% | 跨层重排,低优先级层整体摘要 |
| L3 紧急截断 | usageRatio > 95% | 只保留 pinned + 最近 N 条 |

- 在 `buildContextPack` 入口根据 `usageRatio` 选择级别
- 每级对应不同的压缩管线

**为什么这么做**

- 当前是"一刀切"的预算挑选,没有渐进式策略
- Claude Code 的 7 层架构证明:从轻量清理到全量压缩渐进触发,比一次性重压更稳
- 不同级别对应不同延迟和成本,可以按场景选择

**相比现有实现的好处**

- 避免在 50% 使用率时就做 80% 级别的压缩,节省 LLM 调用
- 紧急情况下有兜底策略,不会直接报错
- 可观测:每个 pack 记录使用了哪一级压缩

---

## 三、实施顺序建议

1. **第一阶段(快速见效)**:P0(pack 缓存) + P5(tokenizer) —— 1-2 天,立即降本提速
2. **第二阶段(能力补齐)**:P1(归档存储) + P2(读取侧摘要) —— 新增服务,不动现有逻辑
3. **第三阶段(智能调优)**:P3(intent 预算) + P4(细化原因) + P6(位置布局) —— 调优阶段
4. **第四阶段(长期演进)**:P7(遗忘曲线) + P8(分层压缩) —— 接近 Claude Code 水平

---

## 四、面试话术

> 以下话术按"项目背景 → 问题诊断 → 方案设计 → 技术深度 → 反思与权衡"组织,可直接在面试中分段表达。

### 1. 项目背景(30 秒)

"我在做一个 AI 简历优化系统,后端是 NestJS,有 Agent 编排、工具调用、多轮对话。每次用户发消息,会先从分层记忆系统里挑选记忆组装成 ContextPack,再喂给 LLM。记忆分四层:session、resume、preference、tool_result,每层有独立的 token 和条目预算。"

### 2. 问题诊断(60 秒)

"做完之后我做了次代码审计,发现几个问题:

第一,**每次对话都全量重算上下文**,即使本次对话没有任何新记忆写入,也会跑一遍 list → sort → select,这 unnecessarily 拖慢了 TTFB。

第二,**超预算的记忆直接丢弃就消失了**,只记录到 droppedMemories 字段,没有降级到长期存储,导致跨会话的早期决策上下文丢失。

第三,**LLM 摘要只在写入侧触发**,读取侧只是简单字符串拼接,没有语义压缩能力。

第四,**预算是静态的**,代码任务和闲聊拿到的 tool_result 预算一样,明显不合理。

第五,**token 估算用字符数除以 4**,中文严重失真,实际消耗可能比预估高 50%。

第六,**MemoryEntry 已经有 lastAccessedAt 和 accessCount 字段,但 buildContextPack 完全没用上**,等于浪费。"

### 3. 方案设计(90 秒)

"我设计了 8 个优化项,按优先级排:

**P0 是加 ContextPack 缓存**,根据 usageRatio 走增量或全量,预期降低 60% 的构建开销。

**P1 是被丢弃记忆降级到 archived 存储**,暴露 searchArchivedMemory 工具让 Agent 主动召回,这就是 Mem0 和 Letta 的 archival store 思路——把上下文窗口当 RAM,外部存储当硬盘。

**P2 是读取侧摘要器**,在 session 层选中超过 3 条、或整体使用率超过 80% 时,调用 LLM 把多条记忆压成一段。这参考了 Claude Code 的全压缩层。

**P3 是 intent 驱动的动态预算**,我已经有 routeDecision.intent,直接用它反哺上下文构建,代码任务多给 tool_result 预算,闲聊多给 session 预算。

**P4 是细化丢弃原因**,从三种扩展到七种,区分过期、低相关、被覆盖等,为后续自动化淘汰打基础。

**P5 是把 token 估算换成 tiktoken**,写入时算一次缓存到 tokenEstimate 字段。

**P6 是位置感知布局**,利用 Liu et al. Stanford 2023 的 lost-in-the-middle 研究结论,把 pinned 和 preference 放最前,最近相关记忆放最后,长内容放中间。

**P7 是激活访问追踪**,引入 Ebbinghaus 遗忘曲线,accessCount 乘以 exp(-daysSinceLastAccess/7),长期未访问的记忆自动降权。

**P8 是分层渐进式压缩**,参考 Claude Code 的 7 层架构,从 L0 日常清理到 L3 紧急截断,按 usageRatio 渐进触发。"

### 4. 技术深度(120 秒,挑 2-3 个深入讲)

**深入讲 P0(缓存)**:"缓存的核心是脏标记判断。我在 ContextPackStore 之上维护 lastPackSnapshot,记录 generatedAt、lastMemoryUpdatedAt、intent、usageRatio。进入 buildContextPack 时先比对:无新记忆且 intent 未变直接返回;usageRatio < 60% 走增量,只追加不重排;≥ 80% 走全量。这样既省计算,又保证关键场景的上下文质量。"

**深入讲 P1(归档存储)**:"归档不是简单搬数据。我把 droppedMemories 异步写入 scope='archived' 的同一张表,带 supersededAt 时间戳。然后暴露 searchArchivedMemory 工具,Agent 在当前 pack 不足时主动召回。这就是把 Agent 从'被动接受预算裁剪'升级为'主动回忆',接近 Mem0 的 hierarchical memory 设计。"

**深入讲 P6(位置感知)**:"这个不增加任何成本,只是排序调整。Liu et al. 2023 的实验表明,长上下文中部信息的召回率比首尾低 20-30%。当前 buildSummaryBlocks 按 DEFAULT_CONTEXT_BUDGET_LAYER_ORDER 硬编码顺序,没考虑注意力分布。我重排为:最前放 pinned 和 preference(系统级,高注意力区),中间放 tool_result(长内容,即使被弱化也有结构化信息兜底),最后放与当前 intent 最相关的 session 记忆(末尾高注意力区)。同样 token 预算,模型对关键信息的利用率显著提升。"

### 5. 反思与权衡(60 秒)

"这套方案有几个权衡我刻意想清楚过:

**第一,缓存 vs 实时性**。缓存的代价是可能用旧上下文,所以我加了 intent 变化即失效的策略,并在 usageRatio > 80% 时强制全量重算。

**第二,LLM 摘要 vs 成本**。读取侧摘要会多调一次 LLM,所以我只在 session 层 > 3 条或使用率 > 80% 时触发,而不是每次都摘要。

**第三,复杂度 vs 收益**。P8 的 7 层压缩确实有过度工程风险,所以我把它放最后,前 7 项已经能覆盖 80% 的收益。Claude Code 的 7 层是给 200K 窗口的 Agentic 编程场景设计的,我的场景规模小一些,不必照搬。

**最后,我没有为了显得高级就硬上知识图谱**。Zep/Graphiti 的时序知识图谱适合企业级多实体场景,我的是单用户简历优化,向量 + 分层 + 归档已经够用,过度设计反而增加维护成本。"

### 6. 一句话总结(15 秒)

"简单说,我把上下文系统从'每次全量挑选 + 静态预算 + 丢弃即消失',升级为'按需缓存 + 动态预算 + 归档可召回 + 渐进式压缩',核心思想是让 Agent 像人一样分层记忆、按需回忆、主动遗忘。"

---

## 五、参考实现

- Claude Code 7 层架构:工具结果存储 → 微压缩 → 会话记忆 → 全压缩 → 自动记忆提取 → 做梦机制 → 跨 Agent 通信
- Cursor `/summarize`:Dynamic Context Discovery,长输出落盘只留指针
- Mem0:向量 + 图 + BM25 混合检索,SDK 2.0 单通道抽取
- Zep/Graphiti:时序知识图谱,双时态跟踪事实有效期
- Letta(原 MemGPT):LLM 自治记忆,内存块 + 归档存储
- LangGraph:checkpointer(短期) + BaseStore(长期) + LangMem(语义/程序性)
