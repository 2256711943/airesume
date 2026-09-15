请基于我现有的 Agent 上下文管理代码，完成一次“History Summary 从事实源降级为压缩缓存”的重构。

## 一、改造目标

当前架构大致是：

用户消息
→ appendMessage
→ refreshConversationHistorySummary
→ buildConversationContext
→ buildContextPack
→ agentExecutorService.execute
→ LLM

目前 History Summary 被当成了比较重要的上下文来源，并且是在当前用户消息 append 后立即刷新，然后参与本轮 LLM 请求。

我希望将它调整为：

> History Summary 只是 Recent Conversation 的“压缩缓存”，不是事实源，也不是长期记忆。

真正的事实源仍然是 conversationMessage，以及已有的结构化 Memory。

---

## 二、核心原则

### 1. Summary 不再作为事实源

不要让其他 Memory 再基于旧 Summary 进行事实继承。

也就是说，禁止形成：

Summary A
→ 生成 Summary B
→ 生成 Summary C
→ 不断基于旧 Summary 递归压缩

避免摘要中的信息错误长期累积和信息漂移。

Summary 应该被视为：

> 从原始 conversationMessage 中重新计算得到的一个可丢弃、可重建的缓存。

如果 Summary 丢失，可以通过历史消息重新生成。

---

### 2. 当前请求不要使用包含当前消息的 Summary

目前可能存在：

用户消息 N
→ appendMessage
→ Summary(N)
→ 当前请求使用 Summary(N)
→ input 又是 User Message N

这样会导致当前用户消息同时出现在 Summary 和 input 中，产生重复上下文。

希望改成：

当前请求：

Summary(N-1)

- 必要的历史消息
- Current User Message(N)

即：

> 本轮 LLM 请求使用“上一状态的历史摘要”，当前用户消息只作为当前 input 进入模型。

---

### 3. Summary 更新应该发生在本轮对话完成之后

推荐生命周期：

User Message N
→ appendMessage
→ buildConversationContext
→ buildContextPack
→ agentExecutorService.execute
→ Agent 完成
→ 异步/后台 refreshConversationHistorySummary
→ 生成 Summary(N)

即：

Summary(N) 应该描述“已经完成的历史”，而不是描述正在进行的当前请求。

如果现有架构因为事务或一致性原因不适合完全异步，请保持功能正确的前提下，实现“本轮请求不读取本轮新生成 Summary”的效果。

---

## 三、Summary 的生成规则

Summary 生成时：

### 原始数据源

优先从 conversationMessage / 原始消息记录重新构建。

不要：

- 基于旧 Summary 再摘要
- 基于 ContextPack 再摘要
- 基于 LLM 最终回答的二次总结作为唯一事实来源
- 从其他已经压缩过的 Summary 递归生成

如果现有代码只能通过最近 N 条 conversationMessage 生成 Summary，可以保留这个策略。

当前规则是：

- 最近 12 条消息
- 纯规则抽取
- 不调用 LLM
- 最大 600 字符

暂时不要为了这个改造引入 LLM Summary。

---

## 四、Summary 的定位

请在代码和必要的注释中明确：

History Summary：

- 是 Recent Context 的压缩缓存
- 是可重建的
- 是可丢失的
- 不是长期记忆
- 不是用户事实数据库
- 不是 Session Decision 的事实源
- 不是 Profile / Preference 的事实源
- 不能反向覆盖结构化 Memory

建议在代码注释中体现类似：

“History Summary is a rebuildable cache of recent conversation context, not the source of truth.”

---

## 五、Context 读取逻辑

重新检查 buildConversationContext。

目标是让不同上下文的职责更加清晰：

Persistent Memory：

- 简历快照
- 用户长期偏好
- 用户稳定信息

Session Memory：

- 当前任务相关信息
- 已确认的决策
- 重要事件
- 未解决问题（如果现有系统已有这些概念则复用）

Recent Context：

- History Summary
- 必要的最近消息

Runtime Context：

- 当前用户消息
- Tool Call
- Tool Result

本次重点只是：

> 不再把 History Summary 当成事实源。

---

## 六、数据一致性

请重点检查以下问题：

### 情况 1：Summary 更新失败

不能影响本轮 Agent 请求。

也就是说：

Summary 更新失败
≠
Agent 请求失败

因为 Summary 只是缓存。

---

### 情况 2：Summary 丢失

系统应该仍然能够正常工作。

允许：

historySummary = null / empty

然后使用必要的最近消息或其他 Memory。

---

### 情况 3：Summary 过期

不要把 Summary 当成绝对可靠的数据。

它应该具有类似：

summaryVersion
updatedAt
sourceMessageSeq / sourceMessageId

这样的元数据（如果现有数据结构允许，优先增加；如果改动成本过大，请至少保留可以判断其对应历史位置的字段）。

目标是能够知道：

> 这个 Summary 是基于哪一段 conversationMessage 生成的。

---

## 七、并发和竞态

请检查以下竞态：

用户连续快速发送：

Message N
Message N+1
Message N+2

如果 Summary 更新是异步的，不能出现：

Summary(N+2)
被较晚完成的 Summary(N)
覆盖。

需要确保 Summary 更新具有单调性。

例如可以使用：

- sourceMessageSeq
- version
- updatedAt
- optimistic locking

等现有项目适合的方式。

原则：

> 新版本 Summary 不能被旧版本 Summary 覆盖。

---

## 八、缓存更新策略

优先采用：

原始消息
→ 重新计算 Summary
→ replace 固定 session summary slot

而不是：

旧 Summary
→ append 新消息
→ 再次压缩

这样可以避免 Summary 递归污染。

如果现有 replace 机制已经存在，请尽量复用。

---

## 九、不要过度修改现有系统

这是一次针对 Summary 生命周期和职责的重构，不是重新设计整个 Memory 系统。

请遵守：

1. 尽量复用现有接口
2. 尽量复用现有 Memory Store
3. 不修改 Agent Loop 的核心行为
4. 不修改 Tool Calling 行为
5. 不修改 SSE 协议，除非确实需要
6. 不删除现有 ContextPack 审计能力
7. 不引入新的第三方依赖
8. 不为了这个改造引入 LLM Summary
9. 不做与本目标无关的大规模重构

---

## 十、请先分析，再修改

在真正修改代码之前，请先检查项目中的：

- appendMessage
- refreshConversationHistorySummary
- buildConversationContext
- buildContextPack
- Memory Store / Memory Repository
- conversationMessage 数据结构
- Agent Executor
- ContextPack 持久化
- SSE ContextPack 推送
- Summary slot 定义

先给出：

### 1. 当前 Summary 的完整生命周期

从：

Message 写入
→ Summary 生成
→ Summary 存储
→ Summary 读取
→ ContextPack
→ LLM

### 3. 给出最小改造方案

说明：

- 哪些代码需要修改
- 哪些代码可以保持不动
- Summary 的生成时机如何调整
- 如何避免旧 Summary 覆盖新 Summary
- 如何保证 Summary 失败不影响 Agent

然后再开始修改。

---

## 十一、完成修改后请提供验证结果

至少验证以下场景：

### Case 1

历史：

User A
Assistant A

当前：

User B

确认：

LLM 使用的是：

Summary(A)

- User B

而不是：

Summary(A+B)

- User B

  ***

### Case 2

Summary 丢失：

确认 Agent 仍然能够正常执行。

---

### Case 3

Summary 更新失败：

确认 Agent 本轮请求仍然成功。

---

## 十二、最终输出

修改完成后请告诉我：

1. 修改了哪些文件
2. 每个文件改了什么
3. 修改后的完整数据流
4. 如何解决并发覆盖
5. 测试了哪些场景
6. 是否存在兼容性风险

不要为了“看起来更完整”而引入额外架构。

本次改造最重要的验收标准只有一句话：

> History Summary 可以随时删除并重新从 conversationMessage 构建，而不会影响系统事实正确性；同时本轮 Agent 不依赖刚刚生成的 Summary。
