# 上下文工程执行计划

## 目标

把当前“消息拼接式上下文”升级为可分层、可裁剪、可解释的上下文工程系统，支持多轮简历优化、Agent 协作和会话恢复。

## 方案核心

- 原始对话消息不直接等价于最终 prompt。
- 上下文按 `session`、`resume`、`preference`、`tool_result` 四层管理。
- 每次 Agent 执行前由 `context budget manager` 做筛选、压缩和注入。
- 记忆支持 `pin`、摘要压缩、过期淘汰和手动移除。
- 前端提供上下文来源、占用预算和注入结果的可视化能力。

## 数据模型

建议统一成以下记忆层级：

- `session_memory`
- `resume_memory`
- `user_preference_memory`
- `tool_result_memory`
- `system_context`

每条 memory 建议包含：

- `memoryId`
- `conversationId`
- `runId`
- `layer`
- `scope`
- `content`
- `summary`
- `tokenEstimate`
- `priority`
- `pinned`
- `freshnessScore`
- `relevanceScore`
- `sourceRefs`
- `createdAt`
- `updatedAt`
- `expiresAt`

每次注入建议产出一个 `context pack`：

- `packId`
- `conversationId`
- `intent`
- `maxTokens`
- `selectedMemoryIds`
- `droppedMemoryIds`
- `summaryBlocks`
- `finalPromptPreview`
- `generatedAt`

---

## 内存与持久化分层

### 分层架构

现有代码中 `ResumeContextService.buildConversationContext()` 每次 agent step 都直接查 Prisma，没有运行时缓存。改造后分三层：

```
┌─────────────────────────────────────────────────┐
│  L1: 运行时缓存 (Runtime Memory Store)            │
│  作用域：当前会话生命周期                           │
│  存储：Map<memoryId, MemoryEntry> + LRU           │
│  目的：避免每次 agent step 都查库                   │
├─────────────────────────────────────────────────┤
│  L2: 持久化层 (Persistent Memory Store)           │
│  作用域：跨会话、跨页面刷新                         │
│  存储：ConversationMemorySlot (现有) →            │
│        升级为独立表 ConversationMemory             │
│  目的：会话恢复、断线重连后恢复上下文                │
├─────────────────────────────────────────────────┤
│  L3: 源数据层 (Source Data)                       │
│  作用域：全局，不属于 memory 系统                   │
│  存储：ResumeLibraryItem / ConversationMessage     │
│        / ToolCallLog 等原始业务表                  │
│  目的：memory 的 sourceRefs 指向这里，              │
│        摘要丢失时可追溯到原始内容                   │
└─────────────────────────────────────────────────┘
```

### L1 运行时缓存 (MemoryStore)

替换现有 `ResumeContextService.buildConversationContext()` 的直接查库模式。在服务端内存中维护一份当前会话的活跃 memory 缓存。

**核心能力：**
- 按 `memoryId` 读写单条 memory
- 按 `conversationId` 和 `layer` 批量查询
- LRU 淘汰策略：优先淘汰已过期的，其次淘汰访问次数最少的，最后淘汰最久未访问的
- 定时清理过期条目

**配置项：** 最大条目数（如 200 条）、条目 TTL（如 30 分钟）、清理间隔（如 5 分钟）

### L2 持久化存储

现有 `ConversationMemorySlot` 是 `slotKey/slotValue` 的通用键值模式，无法按 layer/priority/expiresAt 过滤。建议新建 `ConversationMemory` 数据表，字段包括：

- **标识字段：** `id`、`conversationId`、`runId`
- **分层字段：** `layer`（session / resume / preference / tool_result / system）、`scope`（conversation / user / global）
- **内容字段：** `content`（原始或摘要后的文本）、`summary`（可选摘要）、`tokenEstimate`（预估 token 数）
- **排序筛选字段：** `priority`（优先级，越大越优先保留）、`pinned`（是否固定）、`freshnessScore`（新鲜度分数）、`relevanceScore`（相关性分数）
- **追溯字段：** `sourceRefs`（指向源数据的引用列表）
- **合并字段：** `mergeGroup`（同组合并标识）、`mergeStrategy`（append / replace / summarize）
- **时间字段：** `expiresAt`（过期时间）、`createdAt`、`updatedAt`

按 `conversationId + layer`、`conversationId + priority`、`conversationId + expiresAt` 和 `mergeGroup` 建立索引。

### 读写路径

**写入：** Agent 或 Tool 调用 MemoryStore 写入时，直接写入 L1 运行时缓存，同时异步落库 L2（通过队列，不阻塞 agent 执行）。

**读取：** ContextBudgetManager 读取时优先查 L1 缓存，命中则直接返回；未命中则查 L2 持久化存储并回填 L1。

**恢复：** 页面加载时从 L2 读取当前会话的全部活跃 memory，初始化 L1 缓存，同时清除已过期的条目。

**淘汰：** L1 按 LRU + TTL 淘汰；L2 中 `expiresAt < now` 的条目被 budget manager 自动忽略，定时后台任务物理删除。

### 与现有代码的衔接

1. **`ResumeContextService`** 内部注入 `MemoryStore`，`buildConversationContext()` 改为通过 MemoryStore 按 conversation 和 layer 查询，不再直接查 `ConversationMemorySlot`。

2. **`ConversationService.setResumeContext()`** 改为写入 MemoryStore，指定 `layer=resume`、`mergeGroup=selected_resume_ids`、`mergeStrategy=overwrite`。

3. **`AgentExecutorService`** 在 `execute()` 的工具回调中调用 MemoryStore 写入 tool result，`mergeGroup` 按工具名区分、`mergeStrategy` 使用 append 模式。

4. **前端 `useContextStore`** 改名为 `useMemoryStore`（避免与 trace 的 `useSpanStore` 命名混淆），消费来自 API 的记忆列表，不直接读写 DB。

---

## 记忆合并策略

### 为什么需要合并

现有代码中：
- 连续调用 3 次 `jd_parse_and_score` → 3 条独立 `tool_result` 进入 prompt
- 用户说 2 次"不要用第一人称" → 2 条重复偏好
- 多次 `assistant_done` 生成摘要 → 旧摘要未被替代

合并的目的是：**减少 prompt 中的冗余信息，同时不丢失语义完整性**。

### 合并模式

每条 memory 写入时通过 `mergeGroup` + `mergeStrategy` 决定合并行为：

| mergeStrategy | 行为 | 典型场景 |
|---|---|---|
| `replace` | 同 mergeGroup 的新条目直接替换旧条目 | 简历快照更新、JD 解析结果更新 |
| `append` | 新内容追加到旧条目后 | 多次 tool call 的日志累积 |
| `summarize` | 新旧内容合并后调用 LLM 重新摘要 | 偏好累积、多轮对话的会话摘要刷新 |

### 合并触发时机

每次向 MemoryStore 写入时，根据 `mergeGroup` + `mergeStrategy` 判断：
- 不存在同 `conversationId + mergeGroup` 的活跃条目时，直接新建
- 存在同组条目时，根据策略决定行为：replace（替换 content/summary）、append（追加内容）、summarize（合并后调用轻量摘要并更新 tokenEstimate）

### 各 layer 的合并策略

| Layer | mergeGroup 示例 | mergeStrategy | 说明 |
|---|---|---|---|
| **resume** | `selected_resume_ids` | `replace` | 用户换简历时整条替换，不保留历史版本 |
| **resume** | `resume_summary_v1` / `resume_summary_v2` | `append` | 多版简历摘要共存，各自独立 |
| **tool_result** | `jd_parse_and_score` (按 tool 名) | `replace` | 同一 tool 的最新结果覆盖旧结果 |
| **tool_result** | `search_docs` | `append` | 多次搜索文档的结果合并为一条 |
| **session** | `conversation_history_summary` | `summarize` | 每次 `assistant_done` 用 LLM 合并新旧摘要 |
| **preference** | `writing_style` | `summarize` | 用户多次提出偏好后合并为一条规则集 |
| **preference** | `target_role` | `replace` | 用户重新选岗位时直接覆盖 |

### summarize 合并策略

`summarize` 是最复杂的合并策略，分为三个等级：
- **轻量合并：** 当新旧内容总长度低于阈值（如 2000 字符）时，直接拼接内容，不调用 LLM
- **LLM 合并：** 超出阈值时，调用 LLM 对新旧摘要进行合并生成新摘要，同时保留完整原始内容用于追溯
- **降级合并：** 没有 LLM 可用时，取最近两条摘要截断拼接作为 fallback

关键原则：合并后始终保留 `sourceRefs`，确保可以从摘要追溯到原始内容。

### 合并后的字段变化

合并操作对 memory 字段的影响：

| 字段 | replace | append | summarize |
|---|---|---|---|
| `memoryId` | 不变 | 不变 | 不变 |
| `content` | 替换为新内容 | 追加新内容 | 追加新内容 |
| `summary` | 重新生成 | 保留旧值 | LLM 合并摘要 |
| `tokenEstimate` | 重新估算 | 累积 | 取摘要估算 |
| `sourceRefs` | 替换为新引用的数组 | 追加新引用的数组 | 合并两个数组 |
| `updatedAt` | 更新 | 更新 | 更新 |
| `version` | +1 | +1 | +1 |

### 与前端可视化

`ContextBudgetCard` 对合并后的 memory 展示：合并次数、最新更新时间、合并后的摘要，以及展开查看原始内容的入口。

`MemoryInspectorPanel` 中每条合并后的 memory 可展开查看 `sourceRefs` 指向的原始记录。

---

## 注入时机

- `conversation.created` -> 初始化 system / resume context
- `route_decision` -> 按意图筛选候选 memory
- `agent.step.started` -> 生成本轮 `context pack`
- `tool.call.finished` -> 写入工具结果记忆
- `assistant_done` -> 生成会话摘要和偏好更新
- `resume.variant.selected` -> 提升用户偏好权重

## 前端结构

- `useMemoryStore`：负责 memory 入库、打分、裁剪和 pack 生成（与 trace 的 `useSpanStore` 区分命名）。
- `useMemoryPanel`：管理 pin/unpin、过滤、删除和手动摘要。
- `ContextBudgetCard`：展示 token 预算、已选上下文和裁剪结果。
- `MemoryInspectorPanel`：查看单条 memory 来源、命中原因和关联 run。
- `useResumeConversation`：不再直接拼接全部历史，而是消费 `context pack`。

## 实施步骤

1. 定义 memory / context pack 数据结构与存储接口。
2. 把简历快照、会话摘要、用户偏好、工具结果拆成独立 memory 源。
3. 先在 ResumeContextService 内部实现 context budget manager，收敛到 resume + session 两层。
4. 再扩展到 tool_result 和 preference 层。
5. 增加前端 memory 面板与预算卡片，支持来源追踪和手动干预。
6. 接入会话恢复逻辑，支持重进页面后恢复上下文状态。
7. 补齐 memory 版本更新、过期淘汰和偏好提升策略。
8. 清理直接基于历史消息全量拼 prompt 的旧逻辑。

## 验收标准

- 多轮追问后 prompt 长度可控，不因历史累积失控。
- 同一简历会话切换意图时，上下文注入能随任务变化而收敛。
- 用户可看到“哪些上下文被注入、哪些被裁剪、为什么被裁剪”。
- 会话恢复后 memory 状态不丢失，且不会重复注入旧工具结果。
- 偏好选择能影响后续生成，不需要每轮重复输入相同约束。

## 风险与控制

- 记忆分层过多时，先保证 `resume` 和 `tool_result` 两层稳定再扩展。
- 摘要压缩不能覆盖原始内容，必须保留 sourceRefs 便于追溯。
- 上下文预算计算要和模型 token 估算解耦，避免强绑定单一模型。
- UI 不要让用户直接编辑底层 prompt，只暴露 memory 和注入结果。
