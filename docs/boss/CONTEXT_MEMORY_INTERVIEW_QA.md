# 上下文与记忆管理（Context & Memory）面试追问手册

> 适用代码路径（monorepo `apps/api`）：
>
> - 记忆核心模型/分层/合并策略：`apps/api/src/memory`（memory.types / memory.store / memory-store-facade / in-memory-runtime-memory.store / prisma-persistent-memory.store / prisma-context-pack.store）
> - 上下文预算组装：`apps/api/src/memory/context-budget-manager.service.ts`、`context-pack.types.ts`、`context-pack-read.service.ts`
> - 写入侧摘要器：`apps/api/src/memory/memory-summarizer.ts`、`memory-merge.util.ts`
> - 调用链与业务记忆写入：`apps/api/src/chat/chat.service.ts`、`apps/api/src/conversation/conversation.service.ts`、`apps/api/src/resume/resume-context.service.ts`
> - 演进设计参考：`docs/CONTEXT_ENGINEERING_TODO.md`（P0 Pack 缓存 / P1 归档 / P2 读取侧摘要 / P8 分层渐进式压缩）

> 背诵策略：先背「一句话答案」，再背「要点」，关键决策问题补「为什么 + 其它方案」，最后记「代码锚点」。面试按 结论 → 要点 → 举例 作答。

> 口径说明（重要，防止被追问穿帮）：
>
> - **已落地实现**：四层记忆 + 每层条目/token 预算的"预算内挑选"、每次对话刷新历史摘要并组装 ContextPack、pack 快照落库可查询、写入侧 LLM 合并摘要（pass-through/llm/fallback 三档）、L1/L2 双层存储读写。
> - **演进设计（本文用「演进」字样标注）**：usageRatio 分级的"四级渐进式压缩"（L0–L3）与"Pack 缓存/增量构建"（阈值 0.6/0.8），目前以设计稿形式沉淀在 `docs/CONTEXT_ENGINEERING_TODO.md`（P0/P8），尚未完全落地。
> - 面试建议用两段式叙事："当前落地的是……；我后续的迭代方向是……"，既诚实又有深度。**不要把演进设计说成已上线**。

---

## 问题总览（递进逻辑）

| 阶段         | 问题范围 | 核心词                                                               |
| ------------ | -------- | -------------------------------------------------------------------- |
| 概念定位     | Q1–Q2    | 为什么做 / 上下文 vs 长期记忆                                        |
| 压缩设计     | Q3–Q7    | 四级渐进压缩 / 触发条件 / 提前触发 / 压什么留什么 / 丢信息兜底       |
| Pack 与摘要  | Q8–Q9    | Pack 缓存 / 摘要写入-读取双轨                                        |
| 双层配合     | Q10      | 短期上下文与长期用户记忆                                             |
| 记忆系统     | Q11–Q20  | 记忆准入 / 偏好跨会话 / 冲突与纠正 / 权重与遗忘 / 检索成本           |
| Token 与压缩 | Q21–Q30  | tiktoken / 统计时机 / 用量驱动 / 逐级升级与兜底 / 分账与 Tool Schema |

---

## 一、概念定位

### Q1. 你为什么要做上下文与记忆管理？原生把历史消息全部传给模型有什么问题？

**一句话答案**：因为"原生全量传历史"在**成本、质量、能力、产品化**四个维度都不可持续——上下文窗口有限但对话无界、全量塞入会稀释注意力并触发 lost-in-the-middle、且原生 API 根本记不住跨会话信息；所以我把"喂给模型的上下文"改成了**由结构化记忆按预算挑选组装出来的产物**。

**要点**：

1. **成本随长度线性上涨**：每次对话把全部历史重发给 LLM，token 费用随轮次无界增长（本项目因此给上下文设了硬预算：`CHAT_CONTEXT_PACK_MAX_TOKENS = 4_000`、预留 `RESERVED_TOKENS = 500`，见 `chat.service.ts`）。
2. **质量随长度下降**：
   - 长上下文信噪比下降，旧轮次的寒暄/纠错过程稀释当前任务信号；
   - Liu et al. 2023 的 lost-in-the-middle：位置在中间的历史信息召回率显著低于首尾，全量塞入恰恰把关键事实埋在中间；
   - 模型对"过时结论"与"最新结论"缺乏自动判别能力，容易翻旧账、自相矛盾。
3. **窗口有硬上限**：对话是无界的、窗口是有界的，二者矛盾不可调和，必须有主动的"遗忘/压缩"策略，否则到窗口上限只有粗暴截断一种结局。
4. **原生 API 无长期性**：多轮 API 只维护"当前会话上下文"，换个会话、重启服务，模型什么都不记得；简历信息、用户偏好、工具结论这种**可复用的业务知识**需要结构化地存下来，而不是指望模型背下来。
5. **产品化诉求**：本项目需要"上下文可解释"——前端/审计要能回答"模型这一轮到底看到了什么、哪条记忆为什么被丢弃"，原生历史消息堆栈做不到（落库的 `ContextPack` 快照就是为此做的）。

**为什么这么做（补充）**：

- 把问题拆成两个正交的子问题分别解决：**长期问题用"记忆存储"**（结构化、跨轮跨会话、可检索），**单次问题用"上下文预算"**（在 token 内做选择/丢弃/摘要）。混在一起只会两头都做不好。

**其它方案**（以及为什么没选）：
| 方案 | 问题 | 为什么不选 |
| --- | --- | --- |
| 滑窗截断（只留最近 N 条） | 实现最简单 | 丢事实不丢过程，没有摘要，"失忆"最严重，无法承接跨会话业务 |
| 到达窗口上限才截断/报错 | 不做预管理 | 触发太晚，压缩动作本身也要占窗口，满窗时连"压缩用的 prompt"都放不下（详见 Q5） |
| 全量靠 RAG/向量检索外挂 | 解决"找得到" | 不解决"当前这轮的状态连续性"，且额外引入检索组件；本项目场景单用户、记忆规模小，向量不是必须 |
| 让模型自己"记住" | 看似零成本 | 不可靠、不可审计，等于把状态交给概率 |

**代码锚点**：`apps/api/src/chat/chat.service.ts`（L57-59 预算常量、L330-355 每轮刷新摘要 + 组装 pack）、`apps/api/src/memory/context-budget-manager.service.ts`（L93-209 预算内挑选/丢弃）。

---

### Q2. 你这里的"上下文"和"长期记忆"有什么区别？

**一句话答案**：**记忆是"库"，上下文是"视图"**——记忆是结构化、持久化、可复用的知识单元（跨轮跨会话存在），上下文是给"当前这一次 LLM 调用"从记忆库里按预算挑选并拼装出来的一次性输入。

**要点**：

1. **长期记忆（Memory）**：`MemoryEntry` 是基本单元，带 `layer/scope/content/summary/tokenEstimate/priority/pinned/freshnessScore/relevanceScore/sourceRefs/mergeGroup/version` 等字段，落在 `MemoryStore`（L1 内存 + L2 Prisma）里，生命周期跨多轮、跨会话。
2. **上下文（Context）**：一次 `buildContextPack` 的产物 `ContextPack`——`summaryBlocks + finalPromptPreview + usage`，只包含"这一轮被预算选中"的记忆的**摘要形式**，是发给模型/展示给前端的最终形态。每个 pack 都带 `packId/generatedAt/usage/droppedMemories`，是**一次决策的可解释快照**。
3. **关系**：LLM 只见过上下文，从没见过整个记忆库。记忆库是"硬盘/长期库"，上下文是"这一轮的工作内存快照"。这也是包命名 `ContextPack`（把记忆"打包"成上下文）的由来。
4. **类比**：Mem0/Letta 的"上下文窗口当 RAM、外部存储当硬盘"；OS 里 CPU 只读 cache line，不读整个磁盘。
5. **时间尺度**：本项目四层记忆里 `resume`（简历快照）、`preference`（显示偏好）偏长期稳定，`session`（会话历史摘要槽）、`tool_result`（最近工具结果）偏短期动态——所以"上下文"本质是**长期知识 × 短期状态**在预算约束下的合流。

**为什么这么做（补充）**：

- 分离后各自有独立的优化手段：记忆层可以随便膨胀（不占模型窗口），上下文层永远受预算控制（占窗口但可控）；要加能力时互不干扰——例如做"主动检索/归档召回"只动记忆层，做"压缩级别"只动上下文层。

**其它方案**：把两者合并成单一"全量记忆即上下文"（每轮把整个库灌进窗口）——会随记忆膨胀线性压爆窗口，本质上没解决 Q1 的任何问题；本项目拆成两层的结构才能支撑后续的缓存、归档、渐进压缩。

**代码锚点**：`apps/api/src/memory/memory.types.ts`（L83-104 `MemoryEntry`）、`apps/api/src/memory/context-pack.types.ts`（L83-98 `ContextPack`）、`apps/api/src/memory/context-budget-manager.service.ts`（L93-209）。

---

## 二、压缩设计

> 前置澄清（防混淆）：本项目存在两个容易混的"四层"——
>
> - **记忆结构四层**（已落地）：`resume / preference / tool_result / session` 四个业务层，各有独立预算；
> - **渐进压缩四级**（演进）：按 usageRatio 从轻到重分 L0–L3 四档（下述 Q3–Q5 以它为主口径）。
>
> 面试被问"记忆怎么分层"答前者，被问"渐进式压缩怎么分档/什么时候触发"答后者。

### Q3. 你的四级渐进式压缩具体是哪四级？为什么要设计成四级？

**一句话答案**：渐进式压缩按"上下文使用率 usageRatio"从轻到重分四档——**L0 日常清理（每次对话）→ L1 微压缩（>50%）→ L2 全压缩（>80%）→ L3 紧急截断（>95%）**，用"分级加深"代替"一次性重压"，兼顾成本、延迟与兜底安全。

**要点**（演进设计，对应 `CONTEXT_ENGINEERING_TODO.md` P8）：

| 级别        | 触发条件         | 动作                                               |
| ----------- | ---------------- | -------------------------------------------------- |
| L0 日常清理 | 每次对话         | 丢弃过期、被 superseded 覆盖的记忆；正常预算内挑选 |
| L1 微压缩   | usageRatio > 50% | 对最旧的 session 记忆做单条摘要，腾出空间          |
| L2 全压缩   | usageRatio > 80% | 跨层重排，低优先级层整体压成一段摘要               |
| L3 紧急截断 | usageRatio > 95% | 只保留 pinned + 最近 N 条，保证请求绝不因超窗失败  |

**为什么设计成四级（而不是两级/七级）**：

1. **覆盖"成本 × 紧急度"的四个典型档位**：无操作（L0）→ 小代价单条摘要（L1）→ 中代价跨层摘要（L2）→ 极端兜底（L3）。四档对应"几乎免费/一次 LLM 调用/多次 LLM 调用/纯确定性操作"，任何使用率下都有匹配动作。
2. **避免两个极端**：
   - 只有"压/不压"两档 → 要么在 50% 使用率就做 80% 级别的重压（浪费 LLM 调用），要么拖到 95% 才一把梭（上下文突然大改，模型"失忆"感最强，风险最高）；
   - 分七八档（比如每 5% 一档）→ 档位间差异感知不明显，调参复杂、过度工程。
3. **对齐业界分层压缩理念并做了裁剪**：Claude Code 用 7 层架构（工具结果 → 微压缩 → 会话记忆 → 全压缩 → 自动记忆提取……），但那是给 200K 窗口、agentic 编程长会话设计的；我的场景窗口小、会话短，砍到 4 档足够覆盖收益的 80%。
4. **每档的触发/动作都"可观测、可解释"**：压缩级别可记录进 `ContextPack.metadata`，能回答"这一轮压缩到了什么程度、为什么"。

**其它方案**：
| 方案 | 说明 | 为什么不选 |
| --- | --- | --- |
| 连续函数式压缩 | 用一个连续阈值 + 强度参数插值 | 实现与调试成本高，收益不显著；离散档位更易观测和兜底 |
| 按消息条数触发 | 攒够 N 条就压 | 条数 ≠ token，对超长工具结果/长消息完全失真（本项目已用 token 估算 + usageRatio 而非消息数） |
| 每次对话都跑 LLM 全量摘要 | 质量最高 | 每次多一次 LLM 调用，成本与延迟不可接受；所以才要 L0/L1 把轻量档位挡住 |

**代码锚点**：演进设计见 `docs/CONTEXT_ENGINEERING_TODO.md`（P8，L272-303）。当前已落地的"预算内挑选"在 `context-budget-manager.service.ts`（L54-75 各层预算、L294-319 优先级排序、L123-158 三种丢弃判定）。

---

### Q4. 什么时候触发上下文压缩？你的触发条件是什么？

**一句话答案**：现状是写入侧压缩 + 组装侧只挑选，入口每轮全量重算；演进是在组装入口引入 usageRatio 这一个信号做两级门控——先用 Pack 缓存判断‘要不要重算’（无新写入且 <0.6 直接复用，0.6–0.8 增量，≥0.8 全量），重算时再按 50/80/95 分级决定‘压多深’（L1 单条摘要 → L2 跨层摘要 → L3 确定性截断），让压缩从‘异常处理’变成‘一等公民的分级决策’，成本档位与紧急度始终匹配，且每级可观测、可解释。”

**要点**：

1. **现状：组装侧每次对话都触发"预算管理"**（chat.service 每轮调 `buildContextPack`），它做的是"挑选 + 丢弃"，超预算的记忆记入 `droppedMemories`；真正的"摘要"发生在写入侧。
2. **现状：写入侧在合并时触发 LLM 压缩**（`MemoryStoreFacade.write` → mergeStrategy 为 `summarize` 的条目，见 `memory-summarizer.ts`）：
   - 合并后内容 **> 2_000 字符** → 尝试 LLM 压缩；
   - 内容未超阈值 → pass-through（直接拼接，不调 LLM）；
   - 超阈值但 LLM 未配置/调用失败 → fallback 确定性截断。三档保证合并永远能完成。
   - 典型例子：同一个显示偏好 key 反复表达时，`conversation.service` 用 `mergeStrategy: 'summarize'` 合并，旧偏好与新表达同 key 累加，超长后自动压成一条。
3. **现状：会话历史摘要在每轮用户消息后刷新**（`resume-context.service.ts refreshConversationHistorySummary`，best-effort 不阻断主流程）：取最近 12 条消息，抽"主要话题 / 用户关注（最近3条）/ 已给建议（最近2条）"，压成 ≤600 字符写回 session 层摘要槽。
4. **现状：内存层自动淘汰也构成一种"被动压缩"**：L1 runtime store 有容量上限（默认 200 条）LRU 淘汰 + 过期 TTL 清理，`hydrateConversation` 会顺手删除已过期记忆。
5. **演进：组装入口按 usageRatio 分级触发**（前述 L0–L3；另加 Pack 缓存门控，见 Q8）。

**为什么这么做（补充）**：

- 触发点放在"**写入时**"而不是"每次组装时"做 LLM 摘要，是因为摘要是最贵的操作，要让它只发生在"不得不合并/超长"的时刻；而**组装侧先用便宜的预算挑选**挡住大部分问题，把昂贵的 LLM 压缩留到写入侧。
- 历史摘要"每轮刷新"放在组装之前（`refreshConversationHistorySummary` 先于 `buildContextPack`），保证**当前这一轮**读到的是含上一轮结果的最新摘要——成本换新鲜度。

**其它方案**：

- 触发点也可以放在"读侧"（P2 演进：组装时对同层多条记忆做 LLM 合并摘要），代价是每轮可能多一次 LLM 调用，所以设计上限定"session 层选中 > 3 条或 usedTokens > 80%"才触发；
- 后台定时压缩（如每分钟跑批）：新鲜度差、难对齐"下一轮就要用"的时间点，不如"写入/组装时同步触发"。

**代码锚点**：`apps/api/src/memory/memory-summarizer.ts`（L21-31 阈值、L93-150 三分支）、`apps/api/src/resume/resume-context.service.ts`（L203-259 历史摘要刷新、L648-705 摘要生成）、`apps/api/src/chat/chat.service.ts`（L330-355）。

---

### Q5. 为什么不是达到模型 Context Window 上限才压缩，而是按用量比提前触发？

**一句话答案**：因为"模型窗口"不是只装历史——**生成输出也要占窗口**，而且"压缩"这个动作本身要消耗窗口和时间，等到 99% 才动手时既没空间跑压缩、又没时间重排，只剩粗暴截断这一条路；按用量比提前触发才能把压缩做得**从容、渐进、可逆**。

**要点**：

1. **要留输出空间**：调用时历史 + 系统指令 + 当前问题 + **模型即将生成的回复**共用同一个窗口。压到 95% 再回复，输出空间已不够，请求可能在生成中途截断或报 max_tokens 错误。本项目用 `reservedTokens = 500` 显式预留这段空间，本身就是"提前量"的实现。
2. **压缩动作也要占窗口**：L2/L3 需要把待压缩内容 + 压缩指令再发给 LLM 做一次推理；满窗时连这条"压缩 prompt"都塞不进去。
3. **压缩要质量，质量要时间**：越早触发，越能对"最旧单条"做精细摘要（L1 微压缩）；越晚触发，可用时间越少、动作越暴力（直接截断），上下文突变越大，模型对会话的"连续性感知"受损。
4. **给缓存/增量留决策空间**：提前看用量比才能决定"这次直接返回缓存 / 增量追加 / 全量重算"，这是 Pack 缓存（Q8）能成立的前提——到上限才动手就没有缓存可言。
5. **与业界一致**：Cursor 的 `/summarize`、Claude Code 的 `/compact` 都是**主动、提前**压缩，而不是等溢出；"按用量比分级提前触发"是这类方案的一般形态。
6. **兜底不怕估错**：即便 token 估算（字符/4）有偏差导致提前量不够，`ContextBudgetManager` 的 `pack_token_limit` 丢弃机制保证请求不会超窗（丢最不重要，而非失败）。

**为什么这么做（补充）**：压缩本质是"用信息换空间"，是一个**需要消耗资源、需要时间、需要决策**的动作，所以它的触发条件必须给这个动作留余量——这是把"压缩"当一等公民设计，而不是当异常处理。

**其它方案**：
| 方案 | 为什么不选 |
| --- | --- |
| 到达硬上限才压缩 | 无输出空间、无压缩空间、无时间，只能粗暴截断（Q1 方案里已否掉） |
| 固定消息数触发 | 与真实 token 消耗脱钩，超长工具结果会让窗口提前爆炸 |
| 每轮都压缩 | 浪费；L0 挡掉的场景不该付出压缩成本 |
| 用 90% 单一高阈值触发一次全压 | 一次大改风险高；分级（50/80/95）让小改先发生，大改只在真需要时发生 |

**代码锚点**：现状的"预留空间"在 `chat.service.ts`（L57-59）与 `context-budget-manager.service.ts`（L96-100 `availableTokens = maxTokens - reservedTokens`）；分级阈值见 `docs/CONTEXT_ENGINEERING_TODO.md`（P8 表，L280-291）。

---

### Q6. 压缩的时候具体压缩什么？哪些内容可以压缩，哪些内容必须保留？

**一句话答案**：压缩目标是"**丢过程留结论、丢冗余留唯一、丢旧留新**"——最早/最长的会话细节、过时工具结果、同 key 重复表达可以被合并或省略；而 **pinned、当前简历快照、最新偏好、当前轮消息与工具结果、溯源信息**必须保留。

**要点（现状已落地的取舍规则）**：

1. **可以被压缩 / 丢弃的**（对应代码里的丢弃路径 `layer_item_limit / layer_token_limit / pack_token_limit`）：
   - **最旧的 session 记忆**：历史摘要槽只保留"最近 12 条里的主要话题/用户关注/已给建议"，早期对话细节随逐轮覆盖而消失（`session` 层预算最小：默认 2 条 / 800 token）；
   - **冗余/过时的 `tool_result`**：只保留最近 3 条 / 1200 token；
   - **同一偏好 key 的重复表达**：mergeStrategy=summarize 把多次 `user said: ...` 合并成一条，超长后 LLM 压缩去重；
   - **寒暄、纠错、中间推理过程**：这类信息只对当时有意义。
2. **必须保留的**：
   - **`pinned` 置顶记忆**：排序里 `pinned` 最高优先（`compareMemories`），L1 淘汰时跳过 pinned，删除接口默认不删 pinned——这是"用户明确标记不可忘"的硬通道；
   - **resume 快照（当前简历上下文）**：`resume` 层拿最大预算（3 条 / 1600 token）且排在最前，是每次诊断/指导的业务底座；
   - **每个 preference key 的最新归一化值 + sourceRefs**：值是结论必须留，sourceRefs 保证"这个结论从哪条消息来"可溯源；
   - **当前轮用户消息、本轮要用的系统指令/工具结果**：用 `reservedTokens` 显式预留；
   - **合并后的 sourceRefs 与 metadata**：`memory-summarizer` 合并时 sourceRefs 去重保留、metadata 浅合并，压缩记录 `compactionMode/compactedAt` 写入 metadata。
3. **丢弃不等于删除**：被丢的只出本轮 pack，进 `droppedMemories`（带 memoryId/原因/tokenEstimate/priority/pinned/summary），记忆本体仍在 store 里，下轮可能因排序变化重新入选（详见 Q7）。

**为什么这么做（补充）**：

- 取舍的判据是**"跨轮可复用性 vs 本轮一次性"**：能跨轮复用的（简历、偏好、最新结论）压不得，本轮用完就过期的（寒暄、旧工具结果、旧细节）优先压。这一条判据统一了所有层的取舍逻辑。
- 摘要/截断都**保留摘要行与来源指针**，宁可损失"细节密度"，不损失"可解释性"。

**其它方案**：基于 relevance（RAG 相似度）淘汰 vs 本项目的固定优先级（pinned>priority>relevanceScore>freshnessScore）分层淘汰——本项目因为每层记忆少，确定性规则就够且可解释；等规模大了可引入分数阈值动态裁剪。

**代码锚点**：`context-budget-manager.service.ts`（L294-319 排序、L123-158 三种丢弃、L444-458 dropped 记录）、`memory-store-facade.ts`（L61-106 合并策略）、`in-memory-runtime-memory.store.ts`（L453-499 LRU 淘汰跳过 pinned）、`memory.types.ts`（L90 pinned、L96-97 分数）。

---

### Q7. 如果压缩以后丢失了用户之前的重要信息怎么办？

**一句话答案**：分层防丢——**丢弃是"出 pack 不进删除"、摘要保留 sourceRefs 可溯源、原始消息仍存 DB 可回溯、pinned 提供硬保护**；演进方向再加"归档层 + 主动检索"，让被挤掉的记忆能按需召回而不是真消失。

**要点**：

1. **丢弃是非破坏性的**：`buildContextPack` 只决定"这轮不选它"，写入 `droppedMemories`（带 memoryId/原因/token），**记忆条目仍完整存在 store 里**。下轮它的优先级/相关性/新鲜度变了、或预算松了，会被重新选中——不是"丢一次永久丢"。
2. **摘要不丢溯源**：LLM 压缩 prompt 显式要求"保留事实/数字/人名/未决问题"；合并后保留 `sourceRefs` 去重集合 + metadata 里 `compactionMode/compactedAt`，能回答"这条被压过的记忆从哪些来源来、什么时候压的"。
3. **原文仍在库里**：会话历史摘要只是把原文摘要进 `session` 层 memory，**原始消息在 `conversationMessage` 表里一条没少**——任何时刻可按 DB 回溯完整上下文，"摘要 = 降维保存，不是删除"。
4. **pinned 硬通道**：真正不可丢的信息（用户要求记住的、系统关键状态）置 pinned，写入/排序/淘汰/删除全链路对 pinned 放行。
5. **演进 P1（归档 + 主动召回）**：把被丢弃记忆异步落到 `archived` 作用域（带 supersededAt），再暴露 `searchArchivedMemory` 工具，让 Agent 在当前 pack 不够时**主动"回忆"**——即 Mem0/Letta 的 archival store 思路："上下文窗口当 RAM、外部存储当硬盘"。这就把记忆从"被动接受裁剪"升级成"Agent 主动按需扩展"。
6. **一致性兜底**：演进缓存方案里"intent 变化即失效 + usageRatio>80% 强制全量重算"，防止因复用旧上下文而丢信息（见 Q8）。

**为什么这么做（补充）**：对"压缩丢信息"的恐惧源于把压缩当成破坏性删除；设计上把所有压缩都做成**可逆或可溯源的降维**——要么本体还在（可重新入选/可归档召回），要么留了指针（sourceRefs/原文 DB），让"丢"从不可挽回变成"暂时不在视线内"。

**其它方案**：
| 方案 | 说明 | 为什么不选 |
| --- | --- | --- |
| 永不压缩 | 信息零丢失 | 回到 Q1 全量问题，不可扩展 |
| 压缩前让用户确认 | 增加交互负担 | 可作为"重要会话"的开关，不能默认全量确认 |
| 每次摘要都再问一遍 LLM 复核 | 追求无损 | 成本翻倍且仍不保证无遗漏；本项目用"多层冗余"而非"复核"来防丢 |
| Mem0 向量混合检索兜底 | 大而全 | 单用户简历场景规模小，向量层是过度设计；先做规则 + 归档即可 |

**代码锚点**：`context-budget-manager.service.ts`（L444-458 dropped 记录）、`memory-summarizer.ts`（L158-248 LLM 压缩保留事实、L360-384 sourceRefs/metadata 保留）、`resume-context.service.ts`（L203-259 历史摘要刷新）、演进 P1 见 `docs/CONTEXT_ENGINEERING_TODO.md`（L59-82）。

---

## 三、Pack 与摘要

### Q8. 你的 Pack 缓存是什么？为什么需要 Pack 缓存？

**一句话答案**：Pack 是每次上下文构建决策的**可解释快照**（谁被选中/被丢弃、用了多少 token、最终 prompt 长什么样），已落库并暴露查询接口；"Pack 缓存"是演进目标——在组装入口维护 `lastPackSnapshot`，按 usageRatio 决定**直接复用 / 增量追加 / 全量重算**，避免每轮重复跑"list→sort→select→save"。

**要点**：

1. **现状：pack 是审计/回放单元，不是缓存**：
   - `buildContextPack` 每次生成的完整 `ContextPack`（summaryBlocks/finalPromptPreview/usage/droppedMemories）经 `PrismaContextPackStore.save` 落库；
   - 提供 `getLatest / list / get` 查询，`conversation.service` 暴露 `/context-packs`、`/context-packs/latest`、`/context-packs/:packId` 接口，前端可查看"模型这轮看到了什么"，Observability 回放也用 packId 关联；
   - SSE `start` 事件直接带 pack 摘要，等于每轮把"上下文内容"透明地推给用户。
2. **为什么现状就值得做**：上下文组装是 **LLM 调用的同步前置步骤**，直接影响 TTFB；同时它又是一个**决策点**，需要落痕才能解释"模型为什么答成这样/漏了什么"。
3. **演进：Pack 缓存（P0）解决"重复计算"**：
   - 在 `ContextPackStore` 之上维护会话级 `lastPackSnapshot`（`generatedAt / lastMemoryUpdatedAt / intent / usageRatio`）；
   - 进入 `buildContextPack` 先比对：本轮无新记忆写入且 intent 未变 → 直接返回上次 pack；
   - `usageRatio < 0.6` → 返回缓存；`0.6 ≤ usageRatio < 0.8` → **增量模式**（只追加新记忆，不重排）；`usageRatio ≥ 0.8` → 全量重算；
   - 失效条件：新记忆写入 / intent 变化 / 手动 invalidate。
4. **为什么需要缓存（收益）**：大多数连续轮次之间并没有新记忆写入，却每次全量 DB list + 排序 + 选择 + 落库；预期降低 60%+ 的上下文构建开销、缩短 TTFB；同时"pack 落库即天然快照"使缓存可审计、可回放，不会黑盒化。

**为什么这么做（补充）**：缓存的关键不是"存一份数据"，而是**脏标记判断**——用什么判断"上下文没变"（无新写入 + intent 不变 + 低 usageRatio）。把缓存条件设计成与"记忆写入事件"和"意图路由结果"耦合，比单纯 TTL 更准：intent 变了立刻失效，防止旧上下文带错方向；usageRatio 高了强制全量，防止增量累积误差。

**其它方案**：
| 方案 | 说明 | 为什么不选 |
| --- | --- | --- |
| 完全不缓存 | 现状 | 简单正确，但每轮重复计算拖慢 TTFB |
| 纯 TTL 缓存 | 到点即失效 | 与"内容是否真变化"脱钩，可能用过期上下文或白白重算 |
| Redis/外部缓存 | 跨进程共享 | 单机单进程场景 L1 Map + 落库快照已够；引入 Redis 是过度设计 |
| DB 物化视图 | 由 DB 算好 | 计算逻辑（排序/挑选/摘要）在应用层，物化到 DB 不自然，且丢失决策解释 |
| 无条件增量拼接 | 只追加不失效 | 越攒越长且失去重排，需以 intent/usageRatio 门控（本项目选择带门控的增量） |

**代码锚点**：`context-pack.types.ts`（L83-98 ContextPack）、`prisma-context-pack.store.ts`（L74-83 upsert 落库）、`context-pack-read.service.ts`（L9-15 getLatest）、`conversation.service.ts`（L337-351 readLatestContextPack）；演进 P0 见 `docs/CONTEXT_ENGINEERING_TODO.md`（L29-55）。

---

### Q9. 摘要是怎么生成、保存和读取的？为什么要做"摘要写入/读取双轨"？

**一句话答案**：一条记忆同时保存**全文轨（content）与摘要轨（summary）**，写入时"双写"、读取时"摘要优先、全文兜底"——写入侧负责"合并变长后的压缩"，读取侧负责"用最省 token 的形式进 pack"，两条轨互相备份，摘要失真或缺失时永远有全文可回退、可再压缩。

**要点（生成 → 保存 → 读取 三阶段）**：

1. **摘要生成（两条生成路径）**：
   - **写入侧合并摘要**（`DefaultMemorySummarizer`）：同一 mergeGroup 再次写入时，新旧内容先拼接，超过 2_000 字符才走 LLM 压缩；生成结果同时含 `content`（压缩后全文）和 `summary`（≤280 字符）。分三档：`pass-through`（不超阈值直接透传，不调 LLM）/ `llm`（LLM 压缩）/ `fallback`（LLM 不可用时的确定性截断），并把 `compactionMode/compactedAt` 写进 metadata 溯源。
   - **会话历史摘要**（`resume-context.service`）：每轮从最近消息确定性抽取"主要话题/用户关注/已给建议"，生成 ≤600 字符摘要，以 replace 语义写 session 摘要槽（content 与 summary 同值，metadata 再存一份结构化字段）。
2. **摘要保存（双写）**：`MemoryEntry` 结构上 `content`（全量/原文）与 `summary`（摘要）**两个字段同时落库**（如偏好记忆：content=`display_preference key=value; user said: 原文`，summary=`Display preference: key=value`）。全文轨保证"将来还能再合并/再压缩"（每次 summarize 都需要 previous.content 作为输入），摘要轨保证"高频低成本的读取/展示/估算"。
3. **摘要读取（双读，摘要优先 + 兜底）**：
   - pack 组装 `renderMemorySnippet` 优先取 `memory.summary`，为空才退回 `content`（`memory-summarizer.ts` 的 resolveTokenEstimate 也是 `summary || content` 估 token）；
   - resume 上下文读取历史摘要时先试 metadata 结构化轨，再试 `summary || content` 文本轨；
   - 读取侧始终有回退链：metadata → summary → content，任何一层缺失都不断链。

**为什么做"写入/读取双轨"（补充）**：

1. **成本不对称**：LLM 摘要贵、只该发生在写入（数据变化）时；读取（每次组装）廉价高频，只能消费已经存在的摘要——所以摘要必须在**写入时提前算好并保存**，而不是读取时现算（现算=每轮多一次 LLM 调用）。
2. **防"摘要套摘要"失真**：只存摘要、删除全文会导致多轮迭代后摘要由摘要生成，信息逐级衰减；保留全文轨，每次合并都基于**真实原文**重新压缩，失真可控。
3. **读取自愈**：读取侧摘要缺失/为空时自动回落全文，不会因为摘要生成失败（LLM 抖动、未配置 key）就让上下文空掉。

**其它方案**：
| 方案 | 说明 | 为什么不选 |
| --- | --- | --- |
| 只存全文 | 信息最全 | 读取成本高；展示、估算、预算挑选都要全文扫一遍 |
| 只存摘要 | 最省 | 摘要不可再被精确合并/再压缩，信息永久损失（违反 Q7 的可逆原则） |
| 读取时现算摘要（P2 演进） | 语义合并多条记忆 | 成本高；可作为"组装侧对低优先级层做整体压缩"的补充，不能替代写入侧摘要 |
| summary 作为可空弱字段 | 实现省事 | 会让读取方到处判空兜底，不如双写 + 回退链一次定义清楚 |

**代码锚点**：`memory-summarizer.ts`（L71-150 三档合并、L301-340 摘要解析与 fallback、L404-407 token 估算）、`memory.types.ts`（L89-90 content/summary 双字段）、`memory-store-facade.ts`（L258-291 summarize 写入）、`context-budget-manager.service.ts`（L325-336、L421-428 读取摘要优先）、`resume-context.service.ts`（L648-705）；演进 P2 见 `docs/CONTEXT_ENGINEERING_TODO.md`（L86-112）。

---

## 四、双层配合

### Q10. 短期上下文和长期用户记忆是怎么配合的？

我的实现里其实会把“存储层级”和“语义生命周期”分开看。

存储层面是 L1 + L2：L1 是进程内的 Runtime Memory，主要作为当前会话的热点工作集，有 TTL、容量限制和 LRU；L2 是 Prisma 持久化存储，负责跨进程、跨重启保存。

语义上则分成长期信息和短期信息。比如 resume snapshot、用户 preference 属于比较稳定的长期信息；conversation history summary、最近的 tool result 属于短期或 Session 级信息。

所以不能简单地认为 L1 就等于短期、L2 就等于长期。比如 history summary 虽然语义上属于短期，但我仍然会把它持久化到 L2，这样进程重启以后可以重新 hydrate 到 L1。

两层之间主要通过 MemoryStoreFacade 协作。

读取时采用 cache-aside：先查 L1，miss 以后查 L2，L2 命中再回填 L1。

写入时采用 write-through：先写 L2，再更新或者失效 L1。这里 L2 是持久化层，L1 是可重建缓存，所以不会把 L1 当成最终事实源。

Session 启动的时候会通过 hydrateConversation，从 L2 加载当前会话需要的 Memory，形成 L1 的 Runtime Working Set。

到了真正构建 Context 的时候，我不会把 L1/L2 的数据原样全部塞给模型，而是把它们统一转换成 Context Candidate。

长期 Memory 提供用户背景，比如简历和偏好；Session Memory 提供当前任务的历史状态，比如最近对话摘要；Runtime Context 提供当前用户消息和 Tool Result。

然后 ContextPack 根据当前问题的相关性、重要性、时效性以及 Token Budget 做筛选，最终把真正需要的上下文交给 Agent。

另外我对 History Summary 做了一个比较重要的约束：它虽然会持久化，但它不是事实源，而是一个可重建的压缩缓存。真正的历史事实还是来自 conversationMessage。如果 Summary 丢失，可以重新从原始消息构建。

所以整体来说就是：

L2 负责持久化，L1 负责运行时加速；长期 Memory 提供稳定的用户背景，短期 Context 提供当前任务现场，最后通过 Context Assembly 按相关性和 Token Budget 合并成 ContextPack。

**要点**：

1. **短期 = L1 + 当前轮状态**：
   - `InMemoryRuntimeMemoryStore`：进程内 Map，带 TTL（默认可配）、容量上限（默认 200 条）、LRU 淘汰（pinned 豁免），只存"当前进程当前会话活跃的记忆"；
   - 会话历史摘要槽（session 层）、最近的 tool_result 都属于短期：每轮被刷新/覆盖，代表"最近发生过什么"。
2. **长期 = L2 + 结构化槽位**：
   - `PrismaPersistentMemoryStore`：所有 memory 落 `conversationMemory` 表，重启不丢、跨会话可查，是"真源"；
   - resume 快照槽（mergeGroup=`resume_snapshot`，replace 语义）、conversation_history_summary 槽、每 key 一条的 preference 记忆，都是"业务状态在长期库里的固定槽位"；
   - scope 语义预留 `conversation/user/global` 三档，为未来"跨会话/跨用户复用"留了扩展点。
3. **两者配合的三条关键路径**（都在 `MemoryStoreFacade`）：
   - **读（cache-aside + 回填）**：`get/list` 先查 L1，miss 再查 L2，命中后写回 L1（`set`），下次走内存；
   - **写（write-through）**：`write` 先落 L2（`persistentMemoryStore.save`）再更新 L1，两层永远一致；`patch/delete` 同理双写双删；
   - **会话启动（hydrate）**：`hydrateConversation` 从 L2 拉取该会话活跃记忆、顺手清理过期项，然后 `clearConversation` 后整体灌入 L1——"长期库 → 短期工作集"的显式预热。
4. **语义分层决定"长期成分多少"**：`resume/preference` 层记忆稳定、跨轮有效（偏长期）；`session/tool_result` 层每轮变动（偏短期）。所以"上下文 = 长期知识（resume/preference）→ 中期结论（session 摘要）→ 短期现场（tool_result + 本轮消息）"在预算内合流，对应层顺序 `resume → preference → tool_result → session` 的固定优先级（`DEFAULT_CONTEXT_BUDGET_LAYER_ORDER`）。
5. **缺失时的降级**：L1 丢（进程重启）→ 读 L2 回填；L2 也缺（新会话）→ 从原始业务表重建（如 resume 上下文从 `resumeLibraryItem` 重算、历史摘要从 `conversationMessage` 重抽）。

**为什么这么做（补充）**：短期与长期本质是**同一份记忆的两种生命周期视图**，所以核心矛盾是"一致性 + 成本"：L1 求快（避免每轮打 DB）、L2 求真（持久 + 可重建），中间用 write-through 和 hydrate 两条路径把两层粘起来，保证"快"不以"丢"为代价。这也是把抽象拆成 `RuntimeMemoryStore / PersistentMemoryStore / MemoryStore(facade)` 三个接口的原因——调用方只见门面，底层实现可整体替换（如 L1 换 Redis、L2 换别的 DB 都不动业务）。

**其它方案**：
| 方案 | 说明 | 为什么不选 |
| --- | --- | --- |
| 只用 DB 不用内存缓存 | 实现最简单 | 每轮上下文组装都打 DB，TTFB 差；记忆读取在关键路径上 |
| 只用内存不落库 | 最快 | 重启全丢，无法跨会话/审计 |
| L1 每次全量热载 | 简单粗暴 | 会话长时预热成本高，不如"get miss 再回填 + 写入即更新" |
| Redis 作 L1 | 跨进程共享 | 单机部署下进程内 Map 足够，Redis 引入运维成本；接口已预留可替换 |

**代码锚点**：`memory.store.ts`（L23-103 三个抽象接口）、`memory-store-facade.ts`（L38-59 读回填、L61-106 写双写、L147-166 touch/hydrate）、`in-memory-runtime-memory.store.ts`（L453-499 LRU/TTL）、`prisma-persistent-memory.store.ts`（L125-184 hydrateConversation 清过期 + 预热）、`resume-context.service.ts`（L82-198 业务槽位读写）。

---

## 五、记忆系统（第二优先级）

### Q11. 你怎么判断一条信息应该进入长期记忆？

**一句话答案**：不是"所有信息都入库"，而是**由业务事件 + 显式提取器决定**——只有"能被结构化、对未来轮次有复用价值、且有明确来源可溯源"的信息才写记忆，分三类来源：简历业务基线（resume）、可归一化的用户偏好（preference）、对话结论摘要（session）。

**要点（现状已落地）**：

1. **resume 层：业务事件显式写入**。用户选定简历（`setActiveResumeContext`）时写入/替换 `resume_snapshot` 槽，这是业务底座，不是聊天里抽出来的。
2. **preference 层：规则提取器 + 白名单准入**。`conversation.service.captureDisplayPreferences` 从用户消息里用 `extractDisplayPreferenceCandidates` 提取候选——候选必须命中枚举化的 `category/key`，值必须归一化到合法枚举（`isDisplayPreferenceKey/Value`），命中才写；并带 `sourceRefs`（原文片段）做证据。**命中不了白名单的"随口一句话"不会进记忆**。
3. **session 层：对话结论的降维摘要**。不是把每轮消息存进去，而是把最近消息压成"主要话题/用户关注/已给建议"摘要槽（replace 语义），保留的是**结论和当前关注点**，不是过程。
4. **判断的两条硬标准**：`mergeGroup`（这条信息属于哪个可合并的业务槽/key）必须有，保证它可归并、不重复堆积；`sourceRefs` 必须有，保证任何时候能回答"它从哪来"。
5. **短期/长期由 layer + scope 表达，不靠猜**：`resume/preference` 是跨轮稳定语义，`session/tool_result` 是轮次语义；scope 决定复用边界（conversation/user/global 三档，见 memory.types）。

**为什么这么做（补充）**：记忆写得太随便会污染上下文（一条噪声记忆会长期占用预算并干扰排序），所以准入要走"**事件触发 + 结构化校验 + 来源记录**"三条闸，宁缺毋滥——这也是"记忆数量可控"（Q14）的前提。

**其它方案**：演进方向是**LLM 主动抽取**（Mem0 式：每轮结束让模型判断哪些事实值得长期记，再落库）；与"规则提取"相比它能处理开放语义，但多一次 LLM 调用、有幻觉风险、需要置信度闸门，所以先用确定性规则打底。

**代码锚点**：`resume-context.service.ts`（L82-107 简历快照写入）、`conversation.service.ts`（L426-500 偏好捕获 + 白名单校验）、`memory.types.ts`（L63-69 sourceRefs、L88-91 双字段）。

---

### Q12. 用户偏好是怎么跨会话保存的？

**一句话答案**：偏好以"**每个 key 一条记忆 + mergeGroup 归并**"的结构化形态写入持久层 L2（DB），同会话内跨轮次、跨服务重启都还在；当前以 conversation 作用域为主，真正"跨不同会话复用"的 user 作用域是已预留、待落地的演进。

**要点（现状）**：

1. **结构化槽位**：每个偏好 key（如"语言=中文"）是独立记忆条目，`content` 存归一化值 + 原文证据，`summary` 存一句话结论，`metadata` 存 `category/key/normalizedValue/sourceKind/mergeGroup`（`conversation.service.toDisplayPreferenceMemoryWriteInput`）。读取时按 key 去重、取最新（`resume-context.service` 的 `readDisplayPreferencesFromMemoryEntries`）。
2. **持久层保证"不丢"**：所有记忆落 `conversation_memories` 表（Prisma，见 schema），进程重启、服务重启都不丢；L1 内存只是缓存。
3. **同会话多轮覆盖**：同 key 再次表达时按 mergeGroup 合并（详见 Q13），始终是"一条活动记录"，不会堆积 N 条"喜欢 A/喜欢 B"。
4. **读取端**：每次组装会话上下文时 `list({layer:'preference'})` 拉出（上限 20 条），作为 display preferences 段注入 instructions。
5. **跨会话边界（诚实口径）**：当前写入都是 `scope: 'conversation'`，因此偏好跟着会话走；要做"换一个新会话还记得上次的偏好"，需要把记忆的合并/查询维度从 conversation 上移到 user（`scope:'user'` + 按 userId 落库/查询）——这是结构上已预留、尚未落地的演进。

**为什么这么做（补充）**：偏好和简历不同，它的语义是"一条事实的最新状态"，所以要**可归并、可覆盖、去重**，而不是像聊天记录那样追加——mergeGroup + 单条活动记录 + 枚举归一化是这套结构的核心。

**其它方案**：
| 方案 | 说明 | 为什么不选 |
| --- | --- | --- |
| 单独建 `UserPreference` 表 | 直白 | 会和 memory 系统两套读写逻辑并存；偏好也要参与权重/预算/合并，不如复用统一记忆管线 |
| 直接存在 user 配置 JSON | 最快 | 无溯源、无版本、无合并策略，追不上"用户改口"场景 |
| 演进：scope=user 的记忆 | 跨会话 | 与上表方案比，只是把"归属维度"从 conversation 换成 user，其余能力全复用 |

**代码锚点**：`conversation.service.ts`（L466-500 偏好写入结构）、`resume-context.service.ts`（L141-158 读取偏好）、`memory.types.ts`（L21-23 scope 三档）、`prisma/schema.prisma`（L161-191 `conversation_memories` 表）。

---

### Q13. 如果用户之前说喜欢 A，后来又说喜欢 B，你的记忆怎么处理？

**一句话答案**：两条表达落在**同一个 mergeGroup（同一偏好 key）**上，由该组的 `mergeStrategy` 决定：`replace` 是"新胜旧"（删旧建新），`summarize` 是"合并成一条紧凑记录"，`append` 是"拼接证据"；同一 key 永远只有一条活动记忆，不会两条 A/B 同时长期共存。

**要点**：

1. **冲突的"域"是 mergeGroup**：`findMergeCandidate` 只找 `conversationId + mergeGroup` 里最新的一条（按 updatedAt desc），所以"喜欢 A"和"喜欢 B"是同一冲突域内的两次写入，而不是两条独立记忆。
2. **三种合并策略**（`MemoryStoreFacade.write`）：
   - `replace`：先把旧条目 `deleteFromStores`，再建新条目，返回 `replacedMemoryId`——**最新的 B 是唯一存活值**（典型应用：resume 快照、历史摘要槽）；
   - `summarize`：调摘要器把新旧合并为一条（≤2000 字符时 pass-through 拼接，超长 LLM 压缩去重）——适合"同 key 累积证据"；
   - `append`：纯拼接，保留全部历史片段。
3. **版本与排序托底**：合并后 `version++`；即使短期并存，`compareMemories` 按 priority/updatedAt 排序，最新表达优先进 pack。
4. **诚实指出现状的坑（也是面试亮点）**：当前偏好捕获走 `mergeStrategy:'summarize'`，语义是"追加证据"（`user said: 喜欢A` 拼 `user said: 喜欢B`），适合累积型偏好；但对"改口型"纠正（先 A 后 B），summarize 会把两条并存到超长才压缩，**可能造成旧值 A 与新值 B 冲突**。正确做法应是：归一化值有明确唯一性时改用 `replace`（同 key 覆盖）或先 deleteMany 旧组再写新值——这正是 Q20"纠正"要解决的问题。

**为什么这么做（补充）**：冲突处理必须落在"**槽位语义**"上而不是通用规则上——`replace/summarize/append` 三者本质是"状态 vs 累积 vs 历史"三种业务语义的映射：状态类（当前选哪份简历、当前偏好值）必须新胜旧，证据类（用户说过哪些话）可以累积。把策略做成写入参数的 mergeGroup 属性，而不是写死在存储层。

**其它方案**：时间线版本保留（软删除旧值、只在新版打 superseded）适合审计但记忆膨胀；人工确认冲突成本高，只该用于高影响场景；向量语义合并适合开放记忆，当前枚举化偏好用不上。

**代码锚点**：`memory.types.ts`（L29-35 mergeStrategy 三值）、`memory-store-facade.ts`（L61-106 三分支、L168-192 findMergeCandidate）、`conversation.service.ts`（L470-478 偏好合并策略）、`memory-merge.util.ts`。

---

### Q14. 长期记忆越来越多怎么办？是不是所有历史记忆每次都要检索？

**一句话答案**：不是。**持久库负责"存"，不负责"每轮全量读"**——每轮只从"当前会话 + 目标层 + 未过期"里按索引拉一小批，再在 4000 token 预算内选 Top N；真正会膨胀的是库，但库有 LRU/TTL、槽位 replace、预算丢弃和（演进）遗忘/归档四层"瘦身阀"，且查询永远带 conversationId + layer + mergeGroup 条件，DB 有对应联合索引。

**要点**：

1. **检索范围天然受限**：`buildContextPack` 的 list 只查 `{conversationId, layers:四层, includeExpired:false}`，schema 上有 `[conversationId, layer, updatedAt]` 等索引（L186-189）；不是全局向量扫库，也不是把整个记忆库灌进模型。
2. **预算再截流**：查出的记忆还要过"层条目数 + 层 token + 包 token"三重预算，实际进 pack 的每条层最多 2–4 条，数量级很小。
3. **存储层瘦身阀**：
   - L1 缓存：容量上限（默认 200 条）+ TTL + LRU 淘汰（Q15）；
   - 槽位式覆盖：resume 快照、历史摘要槽都是 replace，**只留一条最新**，天然不增长；
   - 偏好同 key 合并（Q13），不随轮次堆积；
   - 过期记忆：`expiresAt` + hydrate 时顺手删除（prisma-persistent 的 `hydrateConversation` 会把过期行删掉）。
4. **演进（P1/P7）**：被预算丢弃的记忆异步归档到 `archived` 作用域，并暴露 `searchArchivedMemory` 让 Agent **按需主动检索**（而不是每轮全量）；长期未访问的低分记忆后台降级/归档。这就是"窗口当 RAM、外部存储当硬盘"，把检索成本从"每轮固定全量"变成"按需召回"。

**为什么这么做（补充）**：要区分"**存了多少**"与"**读了多少**"两个指标——只有读侧与预算强相关，存侧可以宽松。架构上把"宽进"的持久层和"严出"的预算层解耦，才不用为了让检索便宜而牺牲记忆完整性。

**其它方案**：向量库全局语义检索（规模大才值得；单用户会话级记忆规模下，conversationId+layer 结构化查询已经能把候选压到几十条，向量是过度设计）；每轮全量重算 pack（现状的痛，见 Q8 缓存演进）。

**代码锚点**：`context-budget-manager.service.ts`（L101-106 查询范围、L54-75 层预算）、`in-memory-runtime-memory.store.ts`（L453-499 淘汰）、`prisma-persistent-memory.store.ts`（L125-184 hydrate 清过期）、`prisma/schema.prisma`（L186-189 索引）。

---

### Q15. 你说的"遗忘曲线"具体是怎么设计的？

**一句话答案**：分两层——**已在落地的是 LRU + TTL 的机制性遗忘**（缓存层按最近访问淘汰、按过期时间清理，字段 `lastAccessedAt/accessCount` 已在表里）；**演进目标是 Ebbinghaus 指数衰减的遗忘分**（`score = accessCount × exp(-距上次访问天数/7)`），让低频记忆随时间平滑沉底、腾出预算，而不是靠"刚好满 200 条才触发一次暴力淘汰"。

**要点**：

1. **现状：机制性遗忘（已实现）**：
   - `touch(memoryId)` 更新 `lastAccessedAt` 并把 `accessCount++`（memory-store-facade 与 runtime store）；
   - L1 容量超限（默认 200）时 LRU 淘汰：先删过期，再选 unpinned 中 `accessCount` 最小 → `lastAccessedAt` 最早者淘汰（`evictOverflow / selectEvictionCandidate`）——这是"最近最少使用"的经典遗忘；
   - `expiresAt` TTL：可给临时记忆（如 tool_result）设过期时间，到期自动失效并从 L1 删除、hydrate 时从 DB 清掉。
2. **演进：遗忘曲线（P7，设计）**：
   - 在 `compareMemories` 的排序分里加入时间衰减因子：`forgetScore = accessCount × exp(-daysSinceLastAccess / 7)`；
   - 效果：高频访问的记忆持续高权"浮现"，长期未访问的低权"沉底"到预算之外，而不是被硬删；
   - 后台任务可把低于阈值的记忆归档到长期库（对接 P1），实现"主动遗忘 ≠ 删除"。
3. **与人类记忆规律的对应**：Ebbinghaus 遗忘曲线主张"记忆强度随无复习时间指数衰减"，`exp(-t/τ)` 的半衰期形式正是把这条认知规律翻译成可计算的排序因子。

**为什么这么做（补充）**：遗忘的目的是**为高价值新记忆腾出预算**，所以遗忘必须是"可解释的降权"而不是"不可控的删除"——LRU 保证最近使用过的一定留，指数衰减保证"衰减速度可调（半衰期 τ）"，两者结合既兜底了短时抖动，又平滑了长期冷落。

**其它方案**：纯 LRU/LFU（只认最近/最频，会误杀"低频但重要"）、只按时间衰减（把高频记忆也按死衰减，不合理）、背景定期全库重排序（与"下轮就要用"脱节）。指数衰减 + LRU 兜底是性价比最高的组合。

**代码锚点**：`in-memory-runtime-memory.store.ts`（L157-170 touch、L453-499 LRU/TTL）、`memory.types.ts`（L74-77 访问字段、L40-48 orderBy 字段）、演进 P7 见 `docs/CONTEXT_ENGINEERING_TODO.md`（L242-268）。

---

### Q16. 记忆的权重由哪些因素决定？

**一句话答案**：权重是**五级复合排序**：`pinned`（置顶）> `priority`（业务优先级）> `relevanceScore`（相关性）> `freshnessScore`（新鲜度）> `updatedAt/createdAt`（时间），此外层本身还有"层预算优先级"（resume 排最前、拿最大预算），层内超预算时按该排序从尾丢弃。

**要点（现状代码）**：

1. **层优先级（第一维）**：`DEFAULT_CONTEXT_BUDGET_LAYER_ORDER = resume → preference → tool_result → session`，层序决定谁先被挑选、谁后丢；各层 token/item 额度不同（resume 最高）。
2. **条目标签（第二维）**：`compareMemories` 严格按 `pinned → priority(数值大优先) → relevanceScore → freshnessScore → updatedAt → createdAt` 逐级比较，任何一级分出胜负就不再往后比。
3. **分数字段来源**：`priority` 由业务写入时给定（默认 0）；`relevanceScore/freshnessScore` 目前默认 0，字段已入表并参与排序、可被检索排序（`orderBy` 支持按它们排），但写入方暂未赋值——这是"权重骨架已搭好、赋值策略待激活"的诚实状态。
4. **访问维度**：L1 淘汰用 `accessCount/lastAccessedAt`（LRU），L2 索引含 `priority` 与 `updatedAt`。

**为什么这么做（补充）**：排序字段的顺序就是"取舍哲学"的优先级——**用户显式要求（pinned）> 业务重要性（priority）> 与当前任务的语义匹配（relevance）> 时效（freshness）> 最后才是新旧**。这样设计保证"重要但不新"的记忆不会被"新但不重要"的挤出（Q18 的答案基础）。

**其它方案**：加权求和单分排序（如 `0.4relevance+0.4freshness+0.2priority`）实现简单但会互相掩盖（一条 pinned 会被一条超高 fresh 顶掉）；本项目用**字典序逐级比较**，语义更可解释、更可控。演进可按场景换成加权分（如引入遗忘分 `forgetScore`）。

**代码锚点**：`context-budget-manager.service.ts`（L18-23 层序、L294-319 复合排序）、`memory.types.ts`（L92-98 权重字段）、`prisma/schema.prisma`（L170-181 字段 + 索引）。

---

### Q17. 什么情况下一个记忆会被降权？

**一句话答案**：被降权 = "本轮上下文里排不上号"，主要有四类：**被同 mergeGroup 的新写入覆盖/替换、超预算被 dropped、缓存层 LRU/TTL 淘汰、以及（演进）遗忘分随时间沉底**——降权≠删除，大多只影响"本轮 pack 选没选它"，本体仍在库。

**要点**：

1. **同组覆盖（结构性降权）**：同 mergeGroup 再来一次写入（replace/summarize），旧版本 `version++` 或直接 `replacedMemoryId` 删除——旧值失去"唯一活动"地位。
2. **预算丢弃（选择层降权）**：`buildContextPack` 中超出 `layer_item_limit / layer_token_limit / pack_token_limit` 的记忆被写入 `droppedMemories`（带原因），本轮不参与 prompt——下轮排序/预算变化可能重新入选。
3. **缓存淘汰（L1 层降权）**：`accessCount` 低、长时间未被 `touch`、或命中 TTL，被 LRU/过期清理移出内存——但 DB 仍在，`hydrateConversation` 或 miss 回填可恢复（Q18 详述）。
4. **分数降权（演进 P7）**：遗忘曲线把"长期未访问"的记忆从排序高位平滑移到低位，让位给活跃记忆。
5. **显式降权**：`patch` 可主动改 `priority`、加/去 `pinned`、设 `expiresAt` 让记忆尽快过期——给"产品侧想让某条记忆淡出"留了口子。

**为什么这么做（补充）**：降权要"可解释、可恢复"，所以每条降权路径都留痕：dropped 有 reason、覆盖有 replacedMemoryId、过期有时间戳——这正是为了回答 Q18"重要记忆会不会被误降权"。

**其它方案**：物理删除（不可恢复，误删风险高）；"永不降权只升权"（记忆库持续膨胀、低质记忆占预算，不可行）。当前"降权为主、显式删除为辅"是最稳的取舍。

**代码锚点**：`context-budget-manager.service.ts`（L123-158、L444-458）、`memory-store-facade.ts`（L73-81 replace 删旧、L108-127 patch）、`in-memory-runtime-memory.store.ts`（L437-499）。

---

### Q18. 如果一个很久没使用的记忆实际上非常重要，会不会被错误遗忘？

**一句话答案**：分两层看——**持久层几乎不会丢**（LRU/TTL 只作用于 L1 缓存，DB 里仍在，可随时回填/恢复）；真正可能"隐形"的是 pack 选择层（长时间不活跃的非 pinned 记忆会被排到预算外）。兜底靠 **pinned 硬保护 + priority 业务分 + （演进）重要度与新鲜度分离的双通道排序 + 归档可召回**。

**要点**：

1. **缓存淘汰 ≠ 记忆删除**：`evictOverflow` 只在 L1 Map 超容量时淘汰 unpinned；被淘汰条目仍完整存在 `conversation_memories` 表，下次 `get/list` miss 会从 L2 回填。所以"很久没用"最坏结果是"多一次 DB 读"，不是"永久遗忘"。
2. **pinned 是硬豁免**：排序置顶、LRU 淘汰跳过 pinned、deleteMany 默认不删 pinned、hydrate 保留——用户/系统认为"永远重要"的就 pinned。
3. **bucket 风险与缓解（诚实点）**：非 pinned 且"重要但不常被选中"的记忆，在**选择层**确实可能因排序靠后长期进不了 pack——但这与"遗忘"不同，它是预算下的优先级问题。缓解手段：
   - 写入时给业务基线记忆设 `priority`（resume/preference 是业务显式写入，天然带高语义权重）；
   - 演进 P7 把"重要度"（priority/pinned）与"新鲜度"（时间衰减）**做成两个独立通道**，而不是合进一个总分——新鲜度只决定"同优先级内的次序"，重要度决定"它整体排在哪"，避免低频重要项被新鲜高频项挤掉；
   - 演进 P1 归档 + 主动检索：即使长期不进 pack，也可被 Agent 按需 `searchArchivedMemory` 召回。
4. **根本保障**：Q16 的字典序排序本身就是保护——`pinned`、`priority` 排在最前，时间只作为**最后一级 tie-breaker**，所以"重要但旧"不会因为"旧"就被淘汰，只会被"更重要的新记忆"挤占预算。

**为什么这么做（补充）**：对抗"错误遗忘"的核心是**把遗忘做得可逆、可解释**（Q15/Q17 的延续）：缓存层可回填、选择层可重入、归档层可检索，遗忘永远不是终点而只是"暂时降维"。

**其它方案**：彻底移除遗忘机制（库无限膨胀，低质记忆反而挤掉真重要记忆）；只按优先级永不看时间（短期高频的新记忆永远进不来）。重要度/新鲜度分离是平衡点。

**代码锚点**：`in-memory-runtime-memory.store.ts`（L453-499 淘汰跳过 pinned）、`memory-store-facade.ts`（L38-59 miss 回填）、`context-budget-manager.service.ts`（L294-319）、演进 P1/P7 见 `docs/CONTEXT_ENGINEERING_TODO.md`。

---

### Q19. 记忆之间发生冲突怎么办？

**一句话答案**：冲突被限定在"**同一 mergeGroup + 同一 layer**"的域内解决，用写入方的 `mergeStrategy` 显式声明语义——`replace` 新胜旧、`summarize` 合并去重、`append` 保留全部；不同组、不同层的记忆各自独立，不互相覆盖。

**要点**：

1. **冲突域的界定**：`findMergeCandidate` 按 `conversationId + mergeGroup` 找**最新**一条（updatedAt desc, limit 1）。没有 mergeGroup 的记忆互相不冲突（各自独立条目）。
2. **策略执行**（MemoryStoreFacade.write）：
   - `replace`：旧条目先从 L1/L2 双删，再写新条目（保留 replacedMemoryId 供审计）；
   - `summarize`：调 `DefaultMemorySummarizer`——新旧 content 合并，超 2000 字符走 LLM 压缩（去重 + 保留事实/数字/来源），否则 pass-through；
   - `append`：拼接并 `version++`。
3. **业务冲突 vs 存储冲突**：
   - **存储级冲突**（同 key 同组）→ 上面三种策略覆盖；
   - **语义级冲突**（如一条说"喜欢 A"另一条"喜欢 B"，不同组或不同 key）→ 由**排序与选择**裁决（谁 priority/freshness 高谁先进 pack），且 pack 会把两者都带进去，让模型看到证据——这是"宁可暴露给模型去判断，也不偷偷删一条"。
4. **版本与溯源**：合并 `version++`、`metadata` 记录 `compactionMode/compactedAt`、sourceRefs 保留，冲突过程可回看。
5. **诚实指出演进缺口**：对"同 key 改口（A→B）"这类语义冲突，`summarize` 会并存而非覆盖，理想做法是给归一化偏好用 `replace` + 给旧版打 `superseded`（时间线保留但状态唯一）。

**为什么这么做（补充）**：冲突不可怕，可怕的是**隐式覆盖**（没留痕地删掉旧事实）。显式策略 + 版本 + 溯源让每次冲突解决都可解释；而"该覆盖还是该累积"不该由存储层猜，应由写入方用 mergeStrategy 表达业务语义。

**其它方案**：无条件最后写入胜出（会丢 A 的历史证据）；向量/LLM 语义合并（开放语义才需要，成本高）；冲突时弹窗问用户（交互成本高，只适用高影响场景）。

**代码锚点**：`memory-store-facade.ts`（L61-106、L168-192）、`memory-summarizer.ts`（L93-150）、`memory.types.ts`（L29-35）、`memory-merge.util.ts`。

---

### Q20. 如果用户明确纠正了之前的记忆，你怎么更新或者删除旧记忆？

**一句话答案**：纠正属于"状态覆盖"语义，走 **replace 覆盖（同 mergeGroup 删旧建新，留 replacedMemoryId）** 或 **patch 定点修改**；整组作废用 `deleteMany({layer, mergeGroup, includePinned})`。演进上为"改口"补一个显式纠正事件 + superseded 时间线，避免旧值残留误导模型。

**要点（现状能力）**：

1. **replace（推荐给"用户改口"）**：写入同 mergeGroup、`mergeStrategy:'replace'` → 旧条目先删（`deleteFromStores`）再写新值，`replacedMemoryId` 标明"哪条被顶掉了"。项目里 resume 快照与历史摘要槽都用 replace 实现"永远只有一份最新"。
2. **patch（定点修正）**：已知 memoryId 时局部改 `content/summary/priority/pinned` 等，适合"这条值错了/要降权"而不想重建来源链。
3. **deleteMany（整组作废）**：如用户取消选择简历 → `deleteMany({conversationId, layer:'resume', mergeGroup:'resume_snapshot', includePinned:true})` 清空该组（resume-context L93-99）。
4. **依赖可覆盖的结构才能纠正**：偏好同 key 归并（Q13）、简历快照单槽（replace）、历史摘要单槽（replace）——正因这些"槽位语义"存在，"纠正"才有明确的落点。
5. **诚实指出当前缺口**：偏好捕获目前固定走 `summarize`（累积语义），所以用户**说"我喜欢 A"再改口"我喜欢 B"**时现状是并存合并，不是覆盖；要支持纠正需要：检测到同 key 归一化值**变化**时改用 replace（或先删旧组再写），这是明确的设计演进点——面试可以主动讲出这个"发现的坑 + 修法"，比背标准答案有说服力。

**为什么这么做（补充）**：纠正的本质是"**旧事实已失效，继续让它和最新值并存会误导模型**"，所以必须区分两种写入：累积证据（summarize/append）与状态刷新（replace）。让 mergeStrategy 由"纠不纠正"决定，而不是一刀切。

**其它方案**：软删除 + 版本保留（保审计但读侧要过滤 superseded，复杂度高，适合合规场景）；直接 DB 行删除不留痕（本项目 delete 前有 deleteMany/显式调用 + pack 与记忆都是可审计记录，留有 `droppedMemories`/context-pack 历史，够用）。

**代码锚点**：`memory-store-facade.ts`（L73-81 replace、L108-127 patch、L138-145 deleteMany）、`resume-context.service.ts`（L93-99 清空组、L245-258 摘要槽 replace）、`conversation.service.ts`（L470-478 偏好 summarize——演进改 replace 的落点）。

---

## 六、Token 与压缩（第三优先级）

> 前置口径：项目**现状**的 token 估算是"**字符数/4 的启发式 + 写入/合并时缓存 tokenEstimate 字段**"（`memory-summarizer.ts` 与 `context-budget-manager.service.ts`）；**tiktoken / 真实 tokenizer 是演进 P5**。下方 Q21 按"为什么应该用 tiktoken"答，同时如实说明现状，避免被追问穿帮。

### Q21. 为什么使用 tiktoken，而不是简单按照字符串长度估算 Token？

**一句话答案**：tiktoken 用**与模型一致的 BPE 词表**做精确切分，而字符长度对 Token 数是无意义的——尤其中文（1 字 ≈ 1.5–2 token，数字/代码/英文更偏 1 token），按 `字符/4` 估算会把中文成本低估 50% 以上，导致预算误判（以为没超实际超了）；token 是"钱和窗口"，不该用近似量去管。

**要点**：

1. **BPE 对齐模型词表**：tiktoken 按模型 family 加载对应 encoding（如 cl100k_base），与模型真正切分一致；字符数是语言学单位，与 tokenizer 无关。
2. **现状说明（诚实口径）**：当前代码在 `memory-summarizer.estimateTokens` 与 `context-budget-manager.resolveTokenEstimate` 用 `ceil(length/4)` 兜底估算，并在写/合并时把结果缓存进 `tokenEstimate` 字段。**演进 P5** 把它替换为 tiktoken：写入时精确算一次、读取直接用缓存，O(1)。
3. **为什么不在读取时现算**：读取（pack 组装）在 LLM 调用关键路径上，每次对每条记忆跑 tokenizer 是浪费；"**写入时算一次存字段，读取时只加**"才是正解（tokenEstimate 列默认 0 正是为这个准备的）。
4. **估算不精确的连锁风险**：预算判断失真 → 要么过早压缩（浪费），要么"以为没超实际超了"导致请求 400；前者损失质量，后者直接失败。

**其它方案**：
| 方案 | 说明 | 为什么不选（或何时用） |
| --- | --- | --- |
| `字符数/4`（现状） | 零依赖最快 | 中英混排失真大，只配做 fallback |
| 在线 tokenizer API 现算 | 最准 | 每次组装都发网络请求，慢且贵 |
| 按语言的加权系数（中文×2） | 比 /4 好 | 仍是统计近似，单条长文本方差大，不能保证不超 |
| tiktoken 本地编码（演进） | 准 + 快 + 离线 | 与模型编码一致；需要与模型 family 绑定（Q23） |

**代码锚点**：`memory-summarizer.ts`（L404-407 现状估算）、`context-budget-manager.service.ts`（L321-336 resolveTokenEstimate）、`prisma/schema.prisma`（L169 tokenEstimate 列）、演进 P5 见 `docs/CONTEXT_ENGINEERING_TODO.md`（L188-210）。

---

### Q22. Token 统计具体是在什么时候进行的？

**一句话答案**：原则是"**内容变化时算、组装决策时读**"——写入/合并（记忆变化）时计算并缓存 `tokenEstimate`，构建 pack（决策）时读取累加得到 usage 快照，避免在每条关键路径上重复编码。

**要点（现状）**：

1. **合并/压缩时重算**：`DefaultMemorySummarizer.createResult` 每次 summarize 后重算 token 数（pass-through 取新旧累加；llm/fallback 取压缩后估算），写回该条记忆的 `tokenEstimate` 字段。
2. **组装时读取 + 兜底估算**：`ContextBudgetManager.resolveTokenEstimate` **优先用字段缓存值**；没有缓存值（如老数据默认 0）才用 `summary||content` 的字符估算，并在挑选过程中逐条累加。
3. **每次组装产出一个 usage 快照**：`ContextPack.usage = {maxTokens, reservedTokens, usedTokens, droppedTokens}`——**Token 用量被物化成快照落库**，这是后续"按用量比分级触发压缩"（Q24）的数据来源，也是可观测/回放的依据。
4. **演进（P5 正式化）**：写入入口统一用真实 tokenizer 算一次缓存，删除现在的读侧兜底估算；统计时点收敛到"**写时计算、读时消费**"一个时点。

**为什么这么做（补充）**：统计时点的选择本质是**缓存策略**——token 数是"随内容变、不随时间变"的派生量，最适合写入时算好缓存；把计算放在读侧意味着 N 次读取做 N 次重复编码，而放写侧是 1 次。

**其它方案**：每次读都实时 tokenize（贵）；异步后台补算（时点滞后，可能拿旧值做决策）。"写时算 + 字段缓存 + 读时兜底"是平衡点。

**代码锚点**：`memory-summarizer.ts`（L258-299 createResult）、`context-budget-manager.service.ts`（L325-336、L177-185 usage）、`context-pack.types.ts`（L33-38 usage）。

---

### Q23. 不同模型的 Tokenizer 不一样，你怎么保证估算准确？

**一句话答案**：token 估算必须**绑定模型族**（记录该记忆面向哪个模型、用对应的 encoding），并在写入时缓存；同时承认"估算是给预算决策用的，不是计费"，用**预留空间 + 多重丢弃兜底**吸收残余误差，最后可用服务端真实 `usage` 回传做闭环校准。

**要点**：

1. **tokenizer 与模型族一一对应**：tiktoken 的 `cl100k_base/o200k_base` 等分别对应不同模型族；演进实现时给估算器按 `modelName` 分发，或按家族缓存 `(model, text) → tokens`。
2. **误差不致命的三个缓冲**：
   - 本项目估算目标是"保证不超窗"，不是计费——允许 ~10% 误差；
   - `reservedTokens=500` 是显式安全垫，吸收系统指令与输出预留的偏差；
   - 即使估算失误，`pack_token_limit` 丢弃与（演进）L3 硬兜底保证请求不因长度失败。
3. **多模型场景**：本项目主链路用 OpenAI 兼容接口（chat 用 Responses API，摘要器走 Dashscope OpenAI 兼容），可在 `metadata` 里记录生成该记忆所用的 model 族，读取侧按需换算。
4. **闭环校准（演进）**：把服务端返回的真实 `usage.prompt_tokens/completion_tokens` 回传，与预估对比，按模型计算"平均偏差系数"反向修正估算（Observability 已有 usage/审计通道可挂）。

**为什么这么做（补充）**：模型的 token 化是**词表确定性的**，所以"准确"不是玄学而是"选对词表"；剩下的工程问题只有一个——**估算与真实之间留多大安全垫**。用预留 + 兜底吸收残差，比追求 100% 精确编码更划算。

**其它方案**：对所有模型用同一 encoding（模型差异大时不可靠）；直接依赖服务端报错来发现超限（把失败当校准手段，体验差）；字符级加权估算（省事但不稳，Q21 已否）。最稳的是"按模型族 tokenizer + 写入缓存 + 真实 usage 校准"三件套。

**代码锚点**：演进 P5 见 `docs/CONTEXT_ENGINEERING_TODO.md`（L188-210）；现状安全垫在 `chat.service.ts`（L57-59）。

---

### Q24. 你的压缩流程是怎么根据 Token 用量决定下一步操作的？

**一句话答案**：每次组装都产出 `usage` 快照，算 `usageRatio = usedTokens / (maxTokens - reservedTokens)`；入口按它做**三级门控**——足够空（<0.6）直接复用/返回，中等（0.6–0.8）只增量追加不重排，偏满（≥0.8）全量重算并按用量比选压缩级别（演进，见 Q25）；让"每次组装是可观测、可缓存、可解释的决策"。

**要点**：

1. **用量先被物化**：`ContextPack.usage` 每次组装都落库（Q22），所以"用量比"是现成数据，不需要另做统计。
2. **演进决策链（P0/P8）**：
   - 进 `buildContextPack` → 读 `lastPackSnapshot`：无新写入且 intent 未变 → 直接复用上次 pack；
   - `usageRatio < 0.6` → 返回缓存（没必要重算）；
   - `0.6 ≤ usageRatio < 0.8` → **增量模式**（只把新记忆 append 进选中集，不做全局重排，省算力）；
   - `usageRatio ≥ 0.8` → 全量重算 + 进入压缩分级（Q25）。
3. **压缩级别由用量比选择**：L1(>50%)/L2(>80%)/L3(>95%)，每级执行完**重算 usageRatio**，形成闭环（Q25/Q26）。
4. **为什么把决策放"入口"而不是"执行中途"**：入口决策可缓存、可跳过；执行中途决策难以复用结果。用量比 + 是否脏（新写入/intent 变化）是判断上下文是否值得重算的两个信号。

**为什么这么做（补充）**：用量比是"压缩成本收益"的最佳代理变量——上下文越满，多算一次的边际收益越大；越空，越应该直接返回缓存。按阈值阶梯处理 = 把算力花在刀刃上。

**其它方案**：每轮无条件全量重算（现状，正确但浪费，Q8 已分析）；只按条数触发（不反映 token 真实占用）。用量比分档是兼顾准确与开销的折中。

**代码锚点**：`context-pack.types.ts`（L33-38 usage）、`context-budget-manager.service.ts`（L177-185）、演进 P0/P8 见 `docs/CONTEXT_ENGINEERING_TODO.md`。

---

### Q25. 四级压缩之间是怎么逐级升级的？

**一句话答案**：四级是按"**动作力度 × 触发阈值**"从小到大排的阶梯（L0 日常清理 → L1 微压缩 → L2 全压缩 → L3 紧急截断），每级做完**重算 usageRatio**，仍超当前档阈值就升到下一级，直到用量回落或到达 L3；同级不重复执行，升级路径是单调收敛的。

**要点（演进 P8）**：

1. **四级定义回顾**（与 Q3 表一致）：L0 每次对话清理过期/被覆盖记忆；L1（>50%）对最旧 session 条目做单条摘要；L2（>80%）低优先级层整体压成一段摘要并跨层重排；L3（>95%）只留 pinned + 最近 N 条。
2. **升级判定是反馈循环**：每级执行完 → 重新计算 `usageRatio` → 若仍超本级阈值 → 升一级；若已回落 → 停在当前级结束。不是一次性选死级别。
3. **单调性保证收敛**：每级产出必然比上级小（L1 只动最旧单条；L2 合并整层；L3 数量级截断），因此循环不可能震荡；同时设迭代上限，异常时直接落 L3 兜底。
4. **禁止跳级的原则**：只要用量比没到 95% 就先走 L1/L2 的"温和路径"，避免为了省事直接上 L3 把上下文突然大改（Q5 的"渐进"动机）。
5. **级别可见**：把"本次走了哪一级、每级省了多少 token"写进 pack metadata，便于观测与调阈值。

**为什么这么做（补充）**：把压缩做成"阶梯 + 反馈"而不是"一次到位"，是因为**每一步压缩都有质量代价**（摘要=信息降维），系统应该在"刚够用"的档位停下，而不是默认做最狠的。

**其它方案**：根据 usageRatio 一次性映射到固定级别执行（无重算闭环——若 L1 后仍 >80%，只能等下一轮才压，中间可能超窗）；连续强度参数插值（不可观测、调参难）。

**代码锚点**：演进 P8 见 `docs/CONTEXT_ENGINEERING_TODO.md`（L280-291）；现状"逐层丢弃"的单调顺序在 `context-budget-manager.service.ts`（L116-163）。

---

### Q26. 如果压缩一级之后 Token 还是超限怎么办？

**一句话答案**：说明"当前这档的压缩量不够结构性超额"，按**反馈循环逐级升级**：L1 只压最旧单条不够 → 升 L2 做跨层整体压缩 → 还不够 → 升 L3 做确定性截断；每级都重算用量比，越级只在用量比已跨档时发生，且每级幂等不重复。

**要点（演进）**：

1. **先判断超额性质**：如果压完 L1 仍超，大概率不是"差一点"，而是**预算结构本身放不下**（如某层超长条目多）——单条摘要解决不了，要升 L2 从"层"粒度处理。
2. **L2 的增量手段**：对低优先级层（session/tool_result）做整层 LLM 摘要，把 N 条压成 1 段；跨层重排（利用首尾注意力区）；对同层可合并条目走 summarize 归并。
3. **重算 + 收敛判定**：执行后重算 usageRatio；超当前档阈值才继续升，回落即停；设循环上限（如 3 次），超限直接 L3。
4. **现状可对照的机制**：`ContextBudgetManager` 本身就是"预算不够就逐条丢并记录 reason"的单调循环——演进只是把"逐条丢"升级为"先摘要、再逐层压、最后丢"。

**为什么这么做（补充）**：压缩必须"**先瘦身后节食**"——先用无损/低损手段（单条摘要→整层摘要）尽可能保留信息，真的还不够才做有损丢弃；跳过 L1/L2 直接丢会把本可保留的信息白白扔掉。

**其它方案**：一次 L3 到底（省代码但过度损失，且上下文突变）；反复跑同一档（不升级则死循环不收敛）。逐级升级 + 重算闭环是收敛且有界质量损失的唯一解。

**代码锚点**：演进 P8 见 `docs/CONTEXT_ENGINEERING_TODO.md`；现状预算循环的"单调递减 + 原因记录"可参照 `context-budget-manager.service.ts`（L123-163）。

---

### Q27. 如果压缩到了最后一级还是超限怎么办？

**一句话答案**：L3 本身就是**确定性保底**，它的产物一定会把用量压回窗口内——只保留 pinned + 最近 N 条 + 本轮输入，N 可缩到 0；若极端到单条内容就超窗，做**字符级硬截断**；最终原则是"宁可丢记忆，不让请求因超窗失败"，必要时给出"上下文已精简"的降级提示。

**要点（演进 + 现状兜底）**：

1. **L3 是纯确定性操作**：不依赖 LLM/网络，内容单调变小，必然收敛——这是它作为"最后一道"的资格。
2. **窗口的最终构成**：系统指令 + pinned 记忆 + 最近 N 条会话摘要 + 当前用户消息；`reservedTokens` 已给本轮输入/输出留位。
3. **单条超窗的极端情况**：写入侧已用 2000 字符阈值阻止单条无限膨胀（Q9），理论不会发生；万一发生，L3 对单条做字符级截断到预算内。
4. **宁可失败留给"请求层"而非"上下文层"**：如果 memory 无论如何塞不进，就让 memory 全部退出本次 pack（记入 droppedMemories + 提示），保证 LLM 请求本体不 400——**超窗错误应在组装期被消灭，而不是推到模型 API 那一步**。
5. **可观测与用户感知**：记录"L3 触发、丢弃了哪些、最终 usedTokens"，前端可见；长会话可引导用户开新会话（把当前摘要作为下轮起点）。

**为什么这么做（补充）**：压缩链的每一级（L0→L3）都是"在预算内尽量多保留"，最后一级的意义不是"压得更聪明"，而是"**保证存在一个一定成功的极小上下文**"——用确定的截断替代不确定的失败。

**其它方案**：直接报"上下文过长请开新会话"（把可以避免的失败抛给用户，体验最差）；自动切更大窗口模型（贵、且换模型可能改变行为风格）。L3 保底 + 提示是新会话前的最后缓冲。

**代码锚点**：现状的"预留 + 丢弃保证不超窗"在 `chat.service.ts`（L57-59）与 `context-budget-manager.service.ts`（L96-100）；演进 L3 见 `docs/CONTEXT_ENGINEERING_TODO.md`（L280-291）。

---

### Q28. 压缩的时候如何保证最近几轮对话不被压缩掉？

**一句话答案**：架构上"最近几轮原文"根本不进记忆预算，所以不存在被压掉的问题——**当前用户消息永远 verbatim 作为本轮输入**；历史则通过**每轮刷新的会话摘要槽**保留"最近 3 条用户关注 + 最近 2 条已给建议"，压缩永远从最旧的记忆开始（updatedAt 排最后），最近的天然在保护区内。

**要点（现状已落地）**：

1. **当前消息不参与记忆压缩**：用户消息作为 `input` 直接发给模型，永不进 memory 层、不占 pack 预算。
2. **会话摘要槽就是"最近几轮的保险"**：`refreshConversationHistorySummary` 每轮把最近 12 条消息生成摘要，其中**用户关注固定取最近 3 条、已给建议固定取最近 2 条**（`resume-context.service`），所以"刚聊的"总是以最高保真形式留在摘要里；该槽是 session 层、replace 语义、每轮更新。
3. **压缩方向 = 从最旧剪**：`compareMemories` 里 updatedAt 越新越靠前，预算超限从队尾（最旧）开始丢（L1 也明确"对**最旧的** session 条目做摘要"）；tool_result 只保留最近几条。
4. **排序保护**：最近写入的记忆 freshness/updatedAt 高 → 在同层内排在前面 → 在预算里先被选中、后被丢弃。
5. **pinned 硬保护**（Q18 复用）。

**为什么这么做（补充）**：对话的连贯性依赖"**上一轮说了什么**"的绝对保真，而"很早以前说过什么"只需要要点。把"当前输入"和"最近摘要"划为保护区、"更早历史"划为可压区，本质是**按时间把保真度分层**——与 LLM 对近期 token 注意力更强的特性一致。

**其它方案**：压缩时显式把"最近 K 轮原文"作为高优先层一起塞入（比摘要保真，但 K 轮原文占预算大，长会话会失效）；完全不保护最近（会"断片"，不可接受）。当前"当前轮原文 + 最近摘要 + 从旧剪起"是成本与连贯性的平衡点。

**代码锚点**：`resume-context.service.ts`（L203-259 摘要刷新、L671-693 最近 3+2 抽取）、`context-budget-manager.service.ts`（L294-319 updatedAt 排序）、演进 L1 见 `docs/CONTEXT_ENGINEERING_TODO.md`。

---

### Q29. 系统 Prompt、Tool Definition、历史消息、Memory 分别占多少 Token？

**一句话答案（诚实口径）**：项目目前没有做"一次请求逐段精确分账"——因为该架构**不把原始历史消息整体发给模型**（无 transcript 段），token 大头被"预算墙"管住：**memory/上下文段 ≤4000（预留 500 后可用 3500），其中 resume≤1600 / preference≤400 / tool_result≤1200 / session≤800**；历史消息以"≤600 字会话摘要"进 instructions；Tool Definition 每 Agent 至多 2 个、schema 已精简，占比很小。精确分账是演进（回传真实 usage 打点）。

**要点**：

1. **Memory 段（大头，预算墙内）**：`CHAT_CONTEXT_PACK_MAX_TOKENS=4000`、`RESERVED=500` → 可用 3500。默认分层上限：resume 3 条/1600、preference 4 条/400、tool_result 3 条/1200、session 2 条/800（层上限合计恰为 4000，与包预算对齐）；另有 system 层 1 条/400 预留。
2. **历史消息段（不按原文计）**：LLM 输入里没有原始多轮 transcript——历史以"会话摘要（≤600 字符）+ resume 上下文 + 显示偏好"拼进 `instructions` 前缀（`agent-executor.buildInstructions`），所以历史对窗口的占用是**恒定小量**，不随会话变长而增长。
3. **系统 Prompt 段**：Agent 配置的 `systemPrompt`（固定、精简）+ buildInstructions 拼出的上下文前缀，量级小且确定。
4. **Tool Definition 段**：每个 Chat Agent 的 `toolNames` 只有 `web_search/web_browser` 两个联网工具（`agent.config.ts`），转成 JSON Schema 时还会剥掉 `$schema` 元信息（`tool-registry.stripJsonSchemaMeta`），占比很低；JD 解析等专用工具走独立薄客户端，不混进 Chat Agent。
5. **精确化路径（演进）**：在 LLM 客户端回传真实 `usage.prompt_tokens`，按"system / instructions / tools / user input"分段打点（Observability 已有 usage/审计通道），形成可对账的分账报表；在这之前，"预算墙 + 预留 500"负责保证不超窗。

**为什么这么做（补充）**：与其逐段精算，不如先让"**会膨胀的段**（memory、历史）被硬预算和摘要管死，把"不会膨胀的段"（system/tools）做到足够小"。膨胀控制比测量更根本——测量只是让你知道超了，预算墙让它超不了。

**其它方案**：每次请求逐段真实 tokenize 精确上报（准但要引入成本/链路改动，放演进）；只统计 memory 段忽略其他（会低估，本项目用预留 500 吸收）。当前"预算墙 + 预留 + 精简 tools"与演进"真实 usage 打点"是渐进的两步。

**代码锚点**：`chat.service.ts`（L57-59）、`context-budget-manager.service.ts`（L54-75 分层上限）、`agent.config.ts`（L41-51 toolNames）、`agent-executor.service.ts`（L88-96、L162 起 buildInstructions）、`tool-registry.ts`（L102-109 精简 schema）。

---

### Q30. 你怎么避免 Tool Schema 本身占用大量 Context？

**一句话答案**：核心是**只给 Agent 它真正用得到的工具，而不是把全量工具库塞进去**——工具按 `agent.config.toolNames` 裁剪（每个 Chat Agent 只挂 web_search/web_browser 两个），schema 由 zod 单一来源转 JSON Schema 并剥掉 `$schema` 等元信息；演进再加"按意图动态裁剪 + 大 schema 拆小/描述精简"。

**要点（现状已落地）**：

1. **按 Agent 裁剪（最有效的一招）**：`ToolRegistry.toOpenAiTools({names})` 只转换 names 里的工具（`tool-registry.ts` L61-75），而 executor 传的是 `config.toolNames`（`agent-executor` L88-96）——Chat Agent 只有 2 个联网工具，JD/简历解析工具根本不会进它的请求，schema 总占用被数量级压低。
2. **schema 单一来源 + 精简**：所有工具参数 schema 都是 zod（不手写 JSON Schema），`z.toJSONSchema` 转换时 `stripJsonSchemaMeta` 删掉 `$schema`，避免无谓字节；description 写作时保持精炼。
3. **避免重复注册/全局膨胀**：`ToolRegistry` 是 Map，重名直接抛错；业务侧各自注册各自工具（JD 解析走独立薄适配器 `OpenAIJdLlmParserClient`），不存在"全局工具越挂越多、每个请求全量带上"。
4. **strict 模式不收额外字段**：strict 下只把已有 properties 设为 required + 禁额外字段，不增加 schema 体积。

**为什么这么做（补充）**：Tool Schema 占的 token 与"可用工具数量"成正比、与"本轮意图是否用得上"无关——所以省 token 的第一原则是**减少暴露面**（按 Agent/意图裁剪），而不是优化单个 schema 的字数。schema 微调省的是常数，裁剪省的是线性项。

**其它方案**：
| 方案 | 说明 | 为什么不选 |
| --- | --- | --- |
| 全量工具每次带上 | 简单 | schema 占用随工具库线性涨，且无关工具干扰模型选择 |
| 让模型动态声明要什么工具 | 少传 schema | 引入"先问后答"往返，复杂且不稳 |
| 大 schema 拆分/参数引用 | 需要时再传详情 | 适合超大 schema 场景；本项目工具参数小，裁剪已够 |
| 基于 intent 动态裁剪子集（演进） | 更细 | 需意图→工具映射表；作为裁剪的自然深化 |

**代码锚点**：`tool-registry.ts`（L61-75 按 names 裁剪、L102-109 剥元信息）、`agent.config.ts`（L41-51 每 Agent 2 工具）、`agent-executor.service.ts`（L88-96 传入 toolNames）、`openai-jd-llm-parser.client.ts`（专用单工具客户端）。

---

## 附：一张图串起全链路

```text
用户消息
  │
  ▼
refreshConversationHistorySummary（短期：把上一轮结果写成 session 摘要槽，best-effort）
  │
  ▼
ResumeContextService.buildConversationContext（读 resume/preference/session 槽位 → 结构化业务上下文）
  │
  ▼
ContextBudgetManager.buildContextPack（预算 4000 = maxTokens，预留 500）
  │  ├─ list(四层记忆, 未过期) → 分层 + 排序(pinned>priority>relevance>freshness)
  │  ├─ 逐层挑选：受 层maxItems / 层maxTokens / pack可用token 三重约束
  │  ├─ 超限 → droppedMemories(记录原因)
  │  └─ 生成 summaryBlocks + finalPromptPreview + usage → 落库(可查/可回放)
  │
  ▼
AgentExecutor（LLM + 工具循环）
  │
  └─ 工具结果/新结论 → MemoryStore.write
       ├─ mergeStrategy=summarize + 超2000字符 → LLM 合并摘要（pass-through/llm/fallback）
       ├─ 写 L2(Prisma 真源) → 更新 L1(内存工作集)   ← 长期×短期 的粘合点
       └─ 记忆带 layer/mergeGroup/sourceRefs，供下一轮 buildContextPack 重新挑选
```
