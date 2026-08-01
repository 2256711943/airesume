# DISPLAY_PREFERENCE_MVP_PLAN.md

## 1. 目标

实现一套面向**当前会话**的显式显示偏好采集与注入方案，满足以下能力：

- 只采集用户明确表达的显示偏好，不推断隐式偏好
- 偏好写入统一走 `summarize` 合并策略
- 仅做单会话 MVP，不做跨会话长期画像
- 不引入打分模型，不做权重学习
- 保持偏好注入可解释、可追溯

## 2. 设计原则

- 偏好只接受显式来源
- 偏好以会话内生效为准
- 合并优先复用现有 `MemoryStore` 的 `summarize`
- 冲突处理采用确定性规则，不做评分排序
- 注入层只消费结构化偏好，不直接拼接原始对话

## 3. 范围定义

### 3.1 采集范围

仅采集显示类偏好：

- 语言偏好
- 语气偏好
- 长度偏好
- 结构偏好
- 格式偏好
- 代码/示例偏好
- 输出顺序偏好

### 3.2 非目标

- 隐式偏好推断
- 用户长期画像
- 跨会话偏好继承
- 打分与置信度学习
- 个性化推荐

## 4. 总体架构

### 4.1 分层

1. 显式来源层
- 用户文本中的明确偏好表达
- UI 中的显式选项切换
- 手动覆盖操作

2. 偏好归一层
- 将自然语言偏好映射到固定分类
- 生成规范化 key/value
- 不产生新偏好，只做归并和标准化

3. 偏好记忆层
- 写入 `layer=preference`
- `scope=conversation`
- 合并策略统一使用 `summarize`

4. 注入编排层
- 在生成 `context pack` 前读取当前会话偏好
- 将偏好作为独立块注入 prompt
- 由编排器控制顺序与优先级

### 4.2 数据流

`explicit source -> normalize/classify -> memory.write(summarize) -> preference resolve -> context pack inject`

## 5. 偏好模型

### 5.1 分类维度

单会话 MVP 仅定义 7 类显示偏好，所有偏好都必须能落到 `category + key + value` 三元组。

#### 1. `language`

用于约束回答使用的语言或双语形式。

- `key`: `response_language`
- `value` 可选：
  - `zh-CN`
  - `en-US`
  - `bilingual`
- 示例：
  - “请用中文回答”
  - “后面都用英文”
  - “中英双语都给我”

#### 2. `tone`

用于约束表达风格和语气，不涉及内容取舍。

- `key`: `response_tone`
- `value` 可选：
  - `professional`
  - `friendly`
  - `direct`
  - `formal`
  - `concise`
- 示例：
  - “语气专业一点”
  - “直接一点，别太客套”
  - “口吻友好一点”

#### 3. `length`

用于约束输出篇幅，不涉及信息优先级打分。

- `key`: `response_length`
- `value` 可选：
  - `short`
  - `medium`
  - `long`
- 示例：
  - “简短回答”
  - “详细一点”
  - “别写太长”

#### 4. `format`

用于约束输出展示格式。

- `key` 可选：
  - `output_format`
  - `markdown_preference`
- `value` 可选：
  - `plain_text`
  - `markdown`
  - `table`
  - `bullet_list`
  - `numbered_list`
- 示例：
  - “用表格给我”
  - “直接纯文本就行”
  - “用 markdown 列出来”

#### 5. `structure`

用于约束段落组织方式和回答骨架。

- `key` 可选：
  - `response_structure`
  - `section_policy`
- `value` 可选：
  - `answer_first`
  - `summary_then_detail`
  - `steps_first`
  - `sections_required`
- 示例：
  - “先给结论再展开”
  - “先总结，再给细节”
  - “按步骤写”

#### 6. `example_style`

用于约束示例和代码示例的展示方式。

- `key` 可选：
  - `example_policy`
  - `code_example_policy`
- `value` 可选：
  - `with_examples`
  - `without_examples`
  - `with_code`
  - `without_code`
  - `minimal_examples`
- 示例：
  - “给我带例子”
  - “不要代码示例”
  - “最好给一个最小示例”

#### 7. `output_order`

用于约束多块内容的展示顺序。

- `key`: `content_order`
- `value` 可选：
  - `issues_then_fix`
  - `plan_then_details`
  - `result_then_reason`
  - `code_then_explanation`
- 示例：
  - “先说问题，再说怎么改”
  - “先给方案，再补细节”
  - “先给结果，后面再解释”

### 5.1.1 分类边界

- `language`、`tone`、`length`、`format`、`structure`、`example_style`、`output_order` 之外的偏好，MVP 一律不入库
- “目标岗位”“关注技能”“想优化哪段经历” 这类内容偏好不属于显示偏好，暂不纳入本方案
- 单条表达可拆成多条偏好，例如“中文、简短、先结论后细节”可拆成 3 条

### 5.1.2 归一化规则

- 同义表达统一收敛到固定枚举值，不保留自由文本作为生效值
- 原始表达保存在 `content` 或 `sourceRefs` 指向的源记录中
- 若表达无法稳定映射到已有枚举，则本次不写入偏好 memory
- 不允许为便于合并而创造用户未明确说过的 value

### 5.2 记忆字段

建议偏好 memory 统一包含：

- `memoryId`
- `conversationId`
- `runId`
- `layer`
- `scope`
- `category`
- `key`
- `value`
- `normalizedValue`
- `sourceKind`
- `sourceRefs`
- `mergeGroup`
- `mergeStrategy`
- `summary`
- `content`
- `expiresAt`
- `createdAt`
- `updatedAt`

### 5.3 来源类型

MVP 仅允许 3 种显式来源，且都必须能定位到具体来源记录。

#### 1. `user_text`

来自用户消息中的明确显示偏好表达。

- 触发条件：
  - 出现“请用中文”“简短一点”“用表格”“先给结论”这类明确指令
  - 偏好指向回答展示方式，而不是业务内容本身
- 不采集：
  - 语义模糊的习惯推断
  - 从多轮行为中反推的隐式偏好
  - 普通业务需求中的内容约束
- 推荐 `sourceRefs`：
  - `kind`: `conversation_message`
  - `sourceId`: `messageId`
  - `fragment`: 命中的原文片段

#### 2. `ui_toggle`

来自前端显式偏好控件的选择结果。

- 触发条件：
  - 用户在偏好面板中选择语言、格式、长度等选项
  - 用户通过显式 UI 开关调整当前会话回答样式
- 不采集：
  - 默认值初始化
  - 系统预填但用户未确认的值
- 推荐 `sourceRefs`：
  - `kind`: `preference_ui_event`
  - `sourceId`: `eventId`
  - `metadata`: `controlId`、`selectedValue`

#### 3. `manual_override`

来自用户对已有偏好的手动覆盖或删除。

- 触发条件：
  - 用户明确替换某条生效偏好
  - 用户在偏好面板中关闭、移除或重置某条偏好
- 语义要求：
  - 该来源优先级高于普通 `user_text`
  - 仅在当前会话中生效
- 推荐 `sourceRefs`：
  - `kind`: `preference_override_event`
  - `sourceId`: `overrideEventId`
  - `metadata`: `targetCategory`、`targetKey`、`operation`

### 5.3.1 来源优先级

单会话 MVP 使用确定性优先级，不做打分：

1. `manual_override`
2. `ui_toggle`
3. `user_text`

同一来源类型下，按 `updatedAt` 最新优先。

### 5.3.2 来源入库约束

- 所有来源都必须可追溯到真实记录，不允许写入“推测来源”
- 没有明确来源对象时，不生成 preference memory
- 来源只描述“这条偏好从哪里来”，不承担偏好合并逻辑
- 来源类型扩展必须新增枚举和解析规则，不能复用现有类型偷渡

## 6. 合并策略

### 6.1 统一规则

- 偏好写入统一使用 `summarize`
- `mergeGroup` 以 `category + key` 为主
- 同组条目只保留一份对外生效的偏好摘要
- `sourceRefs` 必须保留，用于追溯显式来源

### 6.2 冲突处理

- 最新的显式表达优先
- 旧偏好不删除原始来源，只从当前生效集合中退出
- 若同一条偏好被重复确认，则合并为同一规则

### 6.3 合并约束

- 不允许总结出用户没说过的新偏好
- 不允许把语义推断成长期习惯
- 不允许通过模型评分决定保留顺序

## 7. 注入编排

### 7.1 编排链路

1. `PreferenceSourceCollector`
2. `PreferenceNormalizer`
3. `PreferenceMemoryWriter`
4. `PreferenceResolver`
5. `ContextPackBuilder`

### 7.2 注入时机

- `conversation.created` -> 初始化空偏好上下文
- `user_message.received` -> 捕获显式偏好
- `preference.updated` -> 刷新当前会话偏好
- `agent.step.started` -> 生成本轮注入块

### 7.3 注入顺序

- system
- resume
- preference
- tool_result
- session

## 8. 前端结构

- `usePreferenceStore`：管理当前会话偏好列表与显式编辑
- `PreferencePanel`：展示已生效偏好与来源
- `PreferenceInspector`：查看单条偏好的来源与合并结果
- `ContextBudgetCard`：展示偏好占用与注入结果

## 9. 实施阶段

### Phase 1: 显式采集

- 定义偏好分类与来源类型
- 接入用户文本中的显式偏好抽取
- 接入 UI 显式切换

### Phase 2: 合并写入

- 复用 `MemoryStore.write()`
- 偏好条目统一走 `summarize`
- 完成同组合并与摘要保留

### Phase 3: 单会话注入

- 实现偏好解析器
- 接入 `ContextPackBuilder`
- 让 agent 读取结构化偏好块

### Phase 4: 可视化与验证

- 增加偏好面板
- 展示来源、合并结果和当前生效值
- 补齐显式/冲突/覆盖场景测试

## 10. 验收标准

- 用户明确说“中文回答”后，后续会话会稳定注入该偏好
- 用户改成“英文回答”后，当前会话生效值会更新
- 系统不会自动推断未表达过的偏好
- 偏好合并过程可追溯到原始来源
- 单会话内偏好注入稳定，无需重复输入

## 11. 风险与约束

- 如果显式来源不足，偏好集合应保持为空
- `summarize` 必须避免补充新语义
- 单会话 MVP 不应过早扩展成用户级画像
- 解析规则过宽会误收集普通描述，必须严格限定显式表达

## 12. 待补充内容

- 显式偏好抽取规则清单
- 偏好分类与 key 映射表
- `ContextPack` 中偏好块的最终字段
- UI 面板交互细节
