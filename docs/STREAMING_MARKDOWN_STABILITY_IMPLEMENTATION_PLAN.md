# 流式 Markdown 渲染稳定性实施计划书

> 覆盖范围：AI 对话场景下「SSE 分片 → 消息级 buffer → 流式 Markdown 稳定渲染 → 终态兜底校验」完整链路。
> 技术栈依据：Nuxt4 + Vue3 + TypeScript + markdown-it 14.x（`apps/web`）。

---

## 1. 文档目标

本文档面向实施阶段，指导解决**流式 Markdown 在 chunk 边界被切断时产生的临时渲染异常**，并给出可直接照做的分阶段实施步骤。

本计划书重点回答：

- 问题根因是什么，项目当前是否已处理
- 分层 FSM 如何设计，状态与迁移如何定义
- 流式阶段与最终阶段各自保证什么
- 先做什么、后做什么，每阶段交付什么
- 如何验收、有哪些回归风险

本文档不展开逐行代码实现，但给出关键接口签名与状态定义作为实现契约。

---

## 2. 背景与问题定义

### 2.1 问题现象

AI 回复以 SSE 增量（chunk）到达。由于 **chunk 的切分位置与 Markdown 语法边界完全无关**，直接把每个 chunk 当完整 Markdown 片段渲染，会在流式过程中出现：

| 现象                     | 触发条件                                     | 用户可见后果                                                                     |
| ------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------- |
| 加粗标记外露             | `**加粗` 只到一半                            | 先显示字面量 `**加粗`，后续突然变粗，行宽/行高跳变                               |
| 代码块背景闪动           | ` ``` ` 未闭合                               | markdown-it 按 CommonMark 规范把后续全部内容吸入代码块，闭合符到达后整块"缩回去" |
| 表格错乱重排             | 表头已到、分隔行未到                         | 表头被渲染成普通文本，分隔行到达后整块重排                                       |
| 行内代码/删除线/链接外露 | `` `code ``、`~~del~~`、`[文字](http` 未闭合 | 符号外露，闭合后突变                                                             |
| 大块非空行抖动           | 追加内容反向改变前文解析                     | setext 标题、链接引用定义导致已渲染区域重排                                      |

### 2.2 根因

Markdown 是**上下文相关**的语法：一个结构是否成立，取决于后续输入。而流式增量是**前缀不确定**的输入流，两者天然冲突。

三条具体冲突：

1. **块级结构依赖未来行**：围栏代码块必须看到闭合行才算结束；表格必须先看到 `|---|` 分隔行才能确认表头是表头。
2. **行内结构依赖未来字符**：`**` 必须成对，单侧到达时语义未定。
3. **chunk 可切在任意字节位置**：包括 `*` + `*`、`\r` + `\n`、` ` `+` ` ``。

### 2.3 现状盘点（项目当前实现）

经代码核查，**项目当前没有任何针对符号截断的处理逻辑**，只有三个间接缓解项：

| 缓解项                    | 位置                                                                                                               | 实际作用                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `html: false`             | [index.vue L20-24](../apps/web/pages/index.vue#L20-L24)、[resume.vue L49-53](../apps/web/pages/resume.vue#L49-L53) | 未闭合 HTML 标签不被解析，不会破坏 DOM、无 XSS 风险。是安全底线，不是渲染方案        |
| `assistant_done` 整体替换 | [useResumeConversation.ts L499-511](../apps/web/composables/useResumeConversation.ts#L499-L511)                    | 流结束后用最终完整内容覆盖 `content`，**最终态一定正确**；但流式过程中的抖动未被消除 |
| markdown-it 自身容错      | CommonMark 规范                                                                                                    | 未闭合围栏会"扩展到文末"自动闭合，程序不崩，但视觉上反而制造了大块闪动               |

**结论**：流式阶段完全没有保护，问题真实存在且可复现。

### 2.4 渲染范围澄清

以下两个事实决定了本次改造的落点，避免范围误判：

- **只有聊天气泡走 Markdown 渲染**：[index.vue L196-201](../apps/web/pages/index.vue#L196-L201)、[resume.vue L615-617](../apps/web/pages/resume.vue#L615-L617) 两处 `v-html`。
- **简历流预览不走 Markdown**：[ResumeFormBubble.vue L187-188](../apps/web/components/resume/ResumeFormBubble.vue#L187-L188) 的 `streamPreview` 是纯文本插值（`{{ }}`），数据源见 [useResumeGeneration.ts L170-174](../apps/web/composables/useResumeGeneration.ts#L170-L174)。

因此**主战场是聊天消息**，简历流无需改造。

---

## 3. 范围定义

### 3.1 本期范围

- 新增流式 Markdown 稳定性内核：行装配器 + 块级 FSM + 行内平衡器（零新增依赖）
- 新增 Vue 派生层：消息级 buffer、渲染结果缓存、缓存失效规则
- 新增 `StreamingMarkdown` 组件，替换两处 `v-html` 调用点
- 落地终态兜底：DONE 全量重解析 + 真截断的安全降级
- 收敛重复代码：两处独立 `MarkdownIt` 实例、两处 `renderMarkdown`、两份 `.markdown-body` scoped 样式
- 补齐单测与 e2e 回归

### 3.2 非本期范围

- 引入第三方增量解析库（`streaming-markdown` / `remend` 等）
- 块级 HTML 缓存（P2 备选，见 §11.3）
- 服务端输出侧的 Markdown 规范化
- 语法高亮、代码块复制按钮、Mermaid 等增强渲染
- 简历流预览的 Markdown 化改造
- 历史消息的重新解析（历史消息 `streaming` 为 `undefined`，直接走最终态路径）

---

## 4. 前置条件与约束

### 4.1 已具备资产（直接复用）

| 资产             | 位置                                                                   | 作用                                                                     |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| markdown-it 14.x | [package.json L22](../apps/web/package.json#L22)                       | 渲染器，本期不升级、不换库                                               |
| 类型声明占位     | [markdown-it.d.ts](../apps/web/types/markdown-it.d.ts)                 | `declare module 'markdown-it'` 无类型；本方案只用 `render()`，可原样保留 |
| 分帧渲染引擎     | [useSseRenderEngine.ts](../apps/web/composables/useSseRenderEngine.ts) | 打字机 120 字/秒 + rAF 分帧，渲染入口天然按帧节流                        |
| 消息模型         | [resume.ts L157-162](../apps/web/utils/resume.ts#L157-L162)            | `ChatMessage` 已有 `streaming?: boolean` 字段，可直接复用                |
| 异常标记         | [useSpanStore.ts L1842](../apps/web/composables/useSpanStore.ts#L1842) | 已有 `stream_incomplete` 异常类型，可联动                                |
| 测试设施         | vitest（`*.test.ts` 同目录）+ Playwright                               | 内核可纯函数单测                                                         |

### 4.2 硬约束

| 约束                           | 说明                                                                                                                                                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **markdown-it 无增量 API**     | `md.parse(src, env)` 每次都是全量、无状态解析，`env` 只透传外部变量，不是可续传游标。因此"保留 parser state"必须落成**自研扫描器持有状态**，不能依赖 markdown-it 内部状态                                                           |
| **零新增依赖**                 | 与既有取向一致：[SSE 架构文档 §4.4](./Technical%20Architecture/SSE_STREAM_RENDER_ARCHITECTURE.md) 已明确"自研 200 行状态机即可覆盖且零依赖，放弃 xstate"。增量库输出自有 AST/DOM，与现有 `v-html` + scoped `:deep()` 样式体系冲突大 |
| **不得污染 `message.content`** | `content` 同时被"复制"按钮（[index.vue L222](../apps/web/pages/index.vue#L222)）与持久化复用，补全结果只能存在于渲染侧派生值                                                                                                        |
| **渲染配置固定**               | `breaks: true, linkify: true, html: false`。本方案的正确性论证强依赖这三个配置，改动需重新评估                                                                                                                                      |
| **e2e 选择器稳定**             | [resume-flow.spec.ts L485](../apps/web/e2e/resume-flow.spec.ts#L485) 依赖 `.chat-message.assistant .markdown-body`，组件化后该 class 必须保留                                                                                       |

---

## 5. 总体方案

### 5.1 分层架构

```
                    SSE chunk 流（边界与语义无关）
                              │
                    ┌─────────▼──────────┐
                    │  L0 行装配器        │  唯一与 chunk 打交道的地方
                    │  Line Assembler    │  产出：只含完整行的行流
                    └─────────┬──────────┘
                              │  完整行
                    ┌─────────▼──────────┐
                    │  L1 块级 FSM       │  只认「行」与「空行」两种原子
                    │  Block FSM         │  产出：blockSafeOffset + 残余
                    └─────────┬──────────┘
                              │  blockSafeOffset 之后的残余
                    ┌─────────▼──────────┐
                    │  L2 行内平衡器      │  只作用于最后一行
                    │  Inline Balancer   │  产出：inlineSafeOffset
                    └─────────┬──────────┘
                              │
              ┌───────────────┴────────────────┐
              ▼                                ▼
      safe → markdown-it.render()      tail → 纯文本插值
      （v-html 提交渲染 HTML）          （打字机可见的中间态 + 光标）
```

**设计要点**：不要让 FSM 去"容忍任意切断"——那是在给出题人递刀。正确做法是**分层消除** chunk 边界。

### 5.2 核心设计原则

| 原则                  | 说明                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **P1 边界消除优先**   | 只要保证 FSM 输入恒为"以 `\n` 结尾的完整行"，则 `*`+`*`、` ` `+` ` ``、`\r`+`\n` 等问题在 L0 全部消失，L1/L2 无需感知 |
| **P2 最小拦截集**     | 并非所有块都需要 hold。在 `breaks:true, html:false` 下只有三种结构需要 hold（见 §6.3.1），状态数从十几个降到 4 个     |
| **P3 渲染与数据分离** | 补全/切分只作用于"渲染副本"，原始 `content` 不变                                                                      |
| **P4 两层保证分离**   | 流式阶段保证"尽可能连续稳定"，终态阶段保证"结构正确"，两者目标不同、不可互相替代                                      |
| **P5 宁可保守不可猜** | 有歧义的结构（单个 `*`/`_` 强调）不参与判断，宁可短暂显示字面量，也不误判吞掉整段                                     |

---

## 6. 详细设计

### 6.1 输出契约

内核对外只暴露一个纯函数结果：

```ts
interface StableMarkdownSlice {
  /** 已确认结构稳定的前缀，可交给 markdown-it 渲染 */
  safe: string;
  /** 未稳定尾巴，以纯文本渲染，不解析 Markdown */
  tail: string;
  /** 诊断信息，供埋点与单测断言 */
  diagnostics: {
    fenceOpen: boolean;
    tablePending: boolean;
    inlineUnbalanced: boolean;
  };
}
```

`safe` 与 `tail` 必须满足 **`safe + tail === raw`**（不丢字符、不重排字符），这是全链路最重要的不变式。

### 6.2 L0：行装配器

```ts
interface LineAssembler {
  /** 追加 chunk，返回本次新产出的「完整行」（含行尾换行符） */
  push(chunk: string): string[];
  /** 流终止时吐出未终结的残行（无 \n 结尾），交 L2 处理 */
  flushPending(): string | null;
  reset(): void;
}
```

三条实现规则：

1. **换行符三态识别**：必须同时支持 `\r\n` / `\r` / `\n`。SSE chunk 可能以 `\r` 结尾、`\n` 开头，被拆开是常态。因此判定 `\r` 时，**若 `\r` 位于 chunk 末尾则暂不外吐**，等下一个 chunk 首字符确认是否为 `\n`。这是最容易遗漏的一个 bug。
2. **`pendingLine` 不参与任何语义判断**：不 trim、不做前缀匹配、不做符号统计。
3. **对外只暴露行序号**：字符偏移由装配器统一换算，避免 CRLF 长度差 1 导致 L1/L2 错位。

**收益**：chunk 边界在 L0 被彻底消灭。L1 与 L2 永远不会看到"半个 `**`"。

### 6.3 L1：块级 FSM

#### 6.3.1 关键洞察：大部分块不需要 hold

在 `breaks: true, html: false` 配置下逐类验证"追加内容是否改变已渲染部分"：

| 块类型         | 追加行为                                 | 已渲染部分是否变化 | 结论                        |
| -------------- | ---------------------------------------- | ------------------ | --------------------------- |
| 段落           | `a<br>b` 追加 `c` → `a<br>bc`            | 否                 | **追加安全**，可直接进 safe |
| 标题           | `## t` 以行尾结束，追加只影响下一行      | 否                 | **追加安全**                |
| 列表           | `- a` 追加 `\n- b` → 仅新增 `<li>`       | 否                 | **追加安全**                |
| 引用块         | 同上                                     | 否                 | **追加安全**                |
| 分隔线         | 单行自闭合                               | 否                 | **追加安全**                |
| **围栏代码块** | 未闭合时 markdown-it 吞掉后续全部内容    | 是                 | **必须 hold**               |
| **表格**       | 缺分隔行时整块是普通段落，补齐后全部重排 | 是                 | **必须 hold**               |
| **缩进代码块** | 空行后 4 空格缩进会整块变代码            | 是                 | **必须 hold**               |

> 该结论依赖 `breaks: true`（段内换行渲染为 `<br>`，最后一行追加不影响前文）与 `html: false`（无 HTML 块吞噬）。若配置变更，本表需重新验证。

#### 6.3.2 状态定义

```ts
type BlockState =
  | { kind: "root" }
  | { kind: "fence"; marker: "`" | "~"; len: number; heldAtLine: number }
  | { kind: "table"; heldAtLine: number }
  | { kind: "indentedCode"; heldAtLine: number };
```

`heldAtLine` 是**回退点**，不是"暂停标志"。`blockSafeOffset` 只在 hold 解除时推进到回退点之后。

#### 6.3.3 迁移表

输入事件 = 一行。先剥离容器前缀（`>` 计数 + 列表缩进）得到"有效内容"，再分类。

| 当前态       | 行分类                                                         | 动作                     | 次态         | blockSafe 推进 |
| ------------ | -------------------------------------------------------------- | ------------------------ | ------------ | -------------- |
| root         | 空行                                                           | —                        | root         | ✅ 至该行末    |
| root         | 围栏开启（缩进 ≤3 且 `^(`{3,}\|~{3,})`）                       | 记录 marker/len/回退点   | fence        | ❌             |
| root         | 空行后 4 空格缩进                                              | 记录回退点               | indentedCode | ❌             |
| root         | 表格候选（含 `\|` 且非空行）                                   | 记录回退点，pending 一行 | root         | ❌             |
| root         | 其它                                                           | —                        | root         | ✅ 至该行末    |
| fence        | 闭合行（同 marker、`len ≥ 开启 len`、缩进 ≤3、无 info string） | —                        | root         | ✅ 至该行末    |
| fence        | **其它一切行**（含空行、异种 marker）                          | 消费                     | fence        | ❌             |
| table        | 表格行（含 `\|`）                                              | —                        | table        | ❌             |
| table        | 非表格行                                                       | 回退至 `heldAtLine` 起点 | root         | ✅ 至上一行末  |
| indentedCode | 空行或仍 4 空格缩进                                            | —                        | indentedCode | ❌             |
| indentedCode | 其它                                                           | —                        | root         | ✅ 至上一行末  |

#### 6.3.4 guard 条件（必须写死，否则误判）

- **围栏 marker 不可混用**：` ``` ` 开的必须 ` ``` ` 闭合，`~~~` 开的必须 `~~~` 闭合。
- **闭合行不得携带 info string**。
- **围栏内的行不参与行内符号统计，也不参与表格候选判断**。这是"正则补符号"方案的经典翻车点。
- **表格候选需要 pending 一行**：`| a | b |` 单独出现时无法判定为表格，必须等下一行看是否为 `|---|` 分隔行。分隔行到达 → 进 table 态并回退至表头行起点；未到达 → 该行为普通段落，可立即进 safe。这是 L1 唯一需要"多看一眼"的地方。

### 6.4 L2：行内平衡器

只处理 `blockSafeOffset` 之后至 buffer 末尾的残余，逐字符扫描，输出 `inlineSafeOffset`：

```ts
function findInlineSafeOffset(text: string): number;
```

跟踪规则（只处理**无歧义**结构）：

| 结构                  | 处理                                            |
| --------------------- | ----------------------------------------------- |
| `\` 转义              | 跳过下一个字符                                  |
| `` ` `` 序列          | 记录长度，找等长闭合；找不到则切点 = 反引号起点 |
| `**` / `__`           | 配对计数；奇数则切点 = 最后一个未匹配标记起点   |
| `~~`                  | 同 `**`                                         |
| `[` … `]` … `(` … `)` | 括号深度未归零则切点 = `[` 起点                 |

**刻意不处理**：单字符 `*` / `_` 强调。它们与列表符号 `- ` / `* ` 天然歧义，强行判断会把整段吞进斜体。宁可让单 `*` 短暂显示为字面量——可控的视觉损失优于语义误判。

最终输出：

```
safe   = buffer.slice(0, inlineSafeOffset)
tail   = buffer.slice(inlineSafeOffset)
```

### 6.5 回改前文的三个暗坑

以下结构会让**新加入的行反向改变已渲染内容**，破坏 `blockSafeOffset` 单调性。这是设计中最易被忽略的部分：

| 坑               | 触发                                     | 后果                                        | 处理                                                                          |
| ---------------- | ---------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| **setext 标题**  | 已渲染 `abc`，新来一行 `---` 或 `===`    | `abc` 由段落变为 `<h1>/<h2>` 被重排         | 检测 `^(-{1,}\|={1,})\s*$`；命中则**回退 blockSafe 至上一段起点**，整段重渲染 |
| **链接引用定义** | 已渲染 `[x]`，后续才来 `[x]: http://...` | markdown-it 文档级解析，前面的 `[x]` 变链接 | 检测 `^\s*\[[^\]]+\]:\s*\S+`；命中则**回退至 0** 全量重渲染                   |
| 行内 HTML 注释   | `<!--` 未闭合吞掉后续                    | `html: false` 已规避                        | 无需处理                                                                      |

> **实现要求**：`blockSafeOffset` **不保证单调**，每次由"原始 buffer + 当前 FSM 状态"重新计算。**禁止**实现为 `Math.max(prev, next)`，否则上述三种回退会失效。

### 6.6 最终态两层兜底

流式阶段的稳定性与最终阶段的正确性是**两个独立保证**，分别落在不同路径：

#### 第一层：正常完成（DONE / assistant_done）

- 复用既有逻辑：[useResumeConversation.ts L499-511](../apps/web/composables/useResumeConversation.ts#L499-L511) 已用最终完整内容整体覆盖 `content`。
- 本期新增：**触发缓存失效 + 全量重解析**，并做一次兜底校验——若全量解析后仍检测到未闭合结构，仅打点记录，**不修改内容**（内容已是服务端权威版本）。

#### 第二层：异常终止（真截断）

判定条件：流终止时 `streaming === true` 且未收到 `assistant_done` / `done`（即 `error` / `canceled` / 重试耗尽）。

处理策略——**识别并安全降级，而非正则无脑补符号**：

```ts
function finalizeTruncatedMarkdown(raw: string): {
  text: string;
  truncated: boolean;
  reasons: string[];
};
```

- 补齐**顶层未闭合围栏**（使代码块边界确定，避免吞掉后续提示文案）；
- 丢弃**最后一个未完成块**（半截表格、未闭合引用的尾部残片）；
- `truncated = true` 时在 UI 明确标注"本次回复未完成"，**静默补符号是禁止项**。

例外：若服务端返回的是**完整错误信息**（`target.content` 为错误文案而非部分流内容），走普通渲染路径，不走降级。

### 6.7 状态生命周期与重建

重连时前端会 `reset()` 打字机并 `dispose()` 渲染引擎（[useResumeGeneration.ts L326-328](../apps/web/composables/useResumeGeneration.ts#L326-L328)），但**消息 buffer 是连续的**（`sinceSeq` 补发历史事件后继续 append，[useResumeConversation.ts L491-498](../apps/web/composables/useResumeConversation.ts#L491-L498)）。

因此 FSM 必须提供两个入口：

```ts
interface MarkdownStreamFsm {
  /** 增量推进：CL0 已保证输入为完整行 */
  advance(completeLine: string): void;
  /** O(n) 全量重放：用于内容被整体替换或缓存失效 */
  rebuild(buffer: string): void;
}
```

`rebuild` 是**必需项而非可选项**：不能假设 `assistant_done` 的最终内容与增量累加结果逐字一致（服务端可能清洗/重组），不一致时必须重建而非拼接旧缓存。

---

## 7. 集成点与改动清单

### 7.1 新增文件

| 文件                                                | 职责                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `apps/web/utils/markdown-stream.ts`                 | 内核：`LineAssembler` + `BlockFsm` + `findInlineSafeOffset` + `finalizeTruncatedMarkdown` + 共享 `MarkdownIt` 实例 |
| `apps/web/utils/markdown-stream.test.ts`            | 内核单测（随机切分幂等性等）                                                                                       |
| `apps/web/composables/useStreamingMarkdown.ts`      | Vue 派生层：消息级 buffer、渲染结果缓存、缓存失效                                                                  |
| `apps/web/composables/useStreamingMarkdown.test.ts` | 派生层单测                                                                                                         |
| `apps/web/components/chat/StreamingMarkdown.vue`    | 渲染组件：`safe` → `v-html`，`tail` → 纯文本 + 光标                                                                |

### 7.2 修改文件

| 文件                                                                                     | 改动                                                                                                             |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [pages/index.vue](../apps/web/pages/index.vue)                                           | 删除 L7 import、L20-24 实例、L60-61 `renderMarkdown`；替换 L200 `v-html` 为组件；L522+ `.markdown-body` 样式收敛 |
| [pages/resume.vue](../apps/web/pages/resume.vue)                                         | 删除 L5 import、L49-53 实例、L381-382 `renderMarkdown`；替换 L617 `v-html` 为组件；L950+ 样式收敛                |
| [composables/useResumeConversation.ts](../apps/web/composables/useResumeConversation.ts) | `error` / `canceled` 分支（L535+）接入真截断判定与安全降级                                                       |

### 7.3 组件接口

```vue
<!-- 用法 -->
<StreamingMarkdown :markdown="message.content" :streaming="message.streaming" />
```

组件内部：

```vue
<div class="markdown-body" v-html="rendered.safe" />
<span v-if="rendered.tail" class="md-streaming-tail">
  {{ rendered.tail }}<i class="md-caret" />
</span>
```

- `streaming === false` 时 `tail` 恒为空，自动退化为单块 `v-html`，**零额外开销**。
- `.markdown-body` class 必须保留（e2e 依赖）。
- `message.streaming` 已在 [index.vue L219](../apps/web/pages/index.vue#L219) 用于控制操作按钮显隐，可直接复用。

### 7.4 样式

- `.md-streaming-tail`：继承正文字体，不加任何 Markdown 样式，**必须保留 `white-space: pre-wrap`**（否则多空格与换行丢失）。
- `.md-caret`：1px 竖条 + 呼吸动画。
- 样式新增位置随 `.markdown-body` 样式收敛一并处理，避免两页各写一份。

---

## 8. 分阶段实施步骤

> 阶段 1 是整个方案唯一有技术难度的部分，**必须先把内核与单测跑绿再动 UI**，这样任何渲染问题都能定位到"内核"还是"接线"。

### 阶段 0：语义边界定义（无代码）

**交付**：本节已完成（见 §6.1 / §6.6），确认以下定义后即可进入阶段 1。

| 定义项            | 结论                                                       |
| ----------------- | ---------------------------------------------------------- |
| 稳定前缀 `safe`   | 文首至"最后一个已确认闭合的顶层块"结尾                     |
| 未稳定尾巴 `tail` | `safe` 之后全部内容，纯文本渲染                            |
| 需拦截的块        | 仅围栏代码块、表格、缩进代码块（§6.3.1）                   |
| 真截断判定        | 流终止时 `streaming === true` 且无 `done`/`assistant_done` |
| 降级动作          | 补齐顶层围栏 + 丢弃末尾未完成块 + UI 标注，禁止静默补符号  |

**DoD**：上述五项无异议。

### 阶段 1：内核纯函数 + 单测

| 步骤 | 内容                                                       |
| ---- | ---------------------------------------------------------- |
| 1.1  | `LineAssembler`：实现完整行产出、CRLF 暂存、`flushPending` |
| 1.2  | `BlockFsm`：实现 §6.3.2 状态与 §6.3.3 迁移表、§6.3.4 guard |
| 1.3  | `findInlineSafeOffset`：实现 §6.4 结构跟踪                 |
| 1.4  | `finalizeTruncatedMarkdown`：实现 §6.6 第二层              |
| 1.5  | 共享 `MarkdownIt` 实例工厂，统一配置 `breaks/linkify/html` |
| 1.6  | 单测，覆盖 §9.1 全部用例                                   |

**DoD**：`npm run test` 通过（web 包），内核覆盖率覆盖 §9.1 全部用例；幂等性断言通过。

### 阶段 2：Vue 派生层

| 步骤 | 内容                                                              |
| ---- | ----------------------------------------------------------------- |
| 2.1  | 消息级 buffer：按 `messageId` 维护 FSM 状态与已渲染结果           |
| 2.2  | `computed` 派生 `{ safe, tail }`，**不写回 `message.content`**    |
| 2.3  | 节流：长度增量阈值 + 时间阈值双闸，命中则复用上次 HTML            |
| 2.4  | **缓存失效**：若新 `markdown` 不以旧内容开头 → `rebuild` 全量重建 |

**DoD**：派生层单测通过；内容整体替换场景有专门用例。

### 阶段 3：组件化并接入

| 步骤 | 内容                                                                                     |
| ---- | ---------------------------------------------------------------------------------------- |
| 3.1  | 新建 `StreamingMarkdown.vue`，实现 §7.3 接口                                             |
| 3.2  | 替换 [index.vue L200](../apps/web/pages/index.vue#L200)                                  |
| 3.3  | 替换 [resume.vue L617](../apps/web/pages/resume.vue#L617)                                |
| 3.4  | 删除两处重复 `MarkdownIt` 实例、两处 `renderMarkdown`、两份 `.markdown-body` scoped 样式 |

**DoD**：两页功能正常；e2e `.markdown-body` 选择器仍命中；`npm run typecheck` 通过。

### 阶段 4：终态兜底

| 步骤 | 内容                                                                       |
| ---- | -------------------------------------------------------------------------- |
| 4.1  | `assistant_done`：触发缓存失效 + 全量重解析 + 兜底校验打点                 |
| 4.2  | `error` / `canceled`：区分"完整错误信息"与"部分流内容被中断"两种情形       |
| 4.3  | 重试耗尽（`useSseSupervisor` 失败）接入 4.2，联动 `stream_incomplete` 异常 |
| 4.4  | UI 明示"本次回复未完成"                                                    |

**DoD**：手工构造中断场景，UI 无破版、有明确提示。

### 阶段 5：样式

| 步骤 | 内容                                               |
| ---- | -------------------------------------------------- |
| 5.1  | `.md-streaming-tail`（含 `white-space: pre-wrap`） |
| 5.2  | `.md-caret` 光标动画                               |
| 5.3  | 确认 `streaming → false` 时无布局跳动              |

**DoD**：追加内容时无行高/背景跳变。

### 阶段 6：验证

| 步骤 | 内容                                                                        |
| ---- | --------------------------------------------------------------------------- |
| 6.1  | 跑通 §9.2 e2e 回归                                                          |
| 6.2  | 执行 §9.3 性能验证                                                          |
| 6.3  | 更新 [MAINTENANCE_GUIDE.md](./MAINTENANCE_GUIDE.md) §7 常见踩坑（新增一条） |

**DoD**：§9 全部验证项通过。

---

## 9. 测试计划

### 9.1 内核单测用例清单（`markdown-stream.test.ts`）

**装配器（L0）**

1. chunk 边界切在 `\r` 与 `\n` 之间
2. chunk 边界切在 `\n` 之后（脏 chunk）
3. 单 chunk 含多行
4. 空 chunk / 纯 `\n` chunk
5. `flushPending` 返回无换行残行

**FSM（L1）**

6. 围栏跨 chunk 开闭
7. 围栏内出现 `**` 不参与行内统计
8. 围栏 marker 混用（` ``` ` 开、`~~~` 闭）不闭合
9. 闭合行携带 info string 不闭合
10. 表格：表头到达但分隔行未到达 → 整体进 tail
11. 表格：分隔行到达 → 整表进入 safe
12. 表格中途插入非表格行 → 正确回退
13. 空行后 4 空格缩进 → 进 indentedCode
14. setext 触发行 `---` / `===` → 回退重渲染
15. 链接引用定义 `[x]: url` → 回退至 0
16. 列表、引用块嵌套时不误判围栏

**平衡器（L2）**

17. `` ` `` 未闭合 → 切点在反引号
18. `` ` `` 等长闭合匹配
19. `**` 奇数个 → 切点在最后未匹配标记
20. `\*` 转义不计数
21. 单 `*` / `_` **不参与**判断（负向断言）
22. `[文字](http` 未闭合 → 切点在 `[`

**不变式（最关键）**

23. **幂等性**：对任意切分点序列 `split(text)`，逐段 `push` 得到的结果必须等于整段一次性 `rebuild(text)`
24. **完整性**：任意时刻 `safe + tail === raw`
25. **单调性**：在**不含** setext 触发行与 linkref 定义的前提下，`blockSafeOffset` 单调不减

> 用例 23 建议用随机切分点做属性测试（多次随机种子），是验证整套 FSM 是否成立的最短路径。

### 9.2 e2e 回归

- [resume-flow.spec.ts](../apps/web/e2e/resume-flow.spec.ts) 全量通过
- 重点确认 L485 的 `.chat-message.assistant .markdown-body` 选择器仍命中
- 补充一条：流式过程中断言 tail 元素存在、`streaming` 结束后 tail 消失

### 9.3 性能验证

| 项           | 方法                                | 通过标准                                      |
| ------------ | ----------------------------------- | --------------------------------------------- |
| 长回复帧耗时 | Performance 面板录制一次 3 万字回复 | 长任务（>16ms）频率不高于改造前               |
| 节流有效性   | 对比节流开/关的解析调用次数         | 解析次数与字符数非线性增长                    |
| 内存         | 连续 10 轮对话后检查 FSM 状态与缓存 | 无泄漏、无 O(n) 累积                          |
| 复杂度       | 单帧耗时随文本长度变化              | 除 `rebuild` 外应近似常数（只扫新增行与残余） |

### 9.4 回归命令

```bash
cd apps/web
npm run test        # 单测
npm run test:e2e    # e2e
npm run typecheck   # 类型检查
npm run lint:check  # 规范检查
```

---

## 10. 风险与回归点

| 风险                                                   | 影响                                | 缓解                                                   |
| ------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------ |
| 组件化破坏 e2e 选择器                                  | e2e 失败                            | 保留 `.markdown-body` class（§4.2 硬约束）             |
| `assistant_done` 内容与增量累加不一致                  | 渲染出旧缓存拼接的错误内容          | 前缀一致性校验 + `rebuild`（§6.7）                     |
| 实现时把 `blockSafeOffset` 写成 `Math.max(prev, next)` | setext / linkref 回退失效，出现重排 | §6.5 明确禁止；单测用例 14/15 覆盖                     |
| 单 `*` 强调误判                                        | 整段被吞进斜体                      | P5 原则：单字符强调不参与判断（§6.4）                  |
| markdown-it 配置被后续改动                             | 本方案正确性论证失效                | §4.2 硬约束 + §6.3.1 表头声明依赖前提                  |
| 节流阈值过于激进                                       | 打字机出现卡顿感                    | 阈值与打字机速率（120 字/秒）联调；先保守后收紧        |
| 缩进代码块在聊天场景误判                               | 正常缩进文本被 hold 进 tail         | 仅"空行后 4 空格"才进 indentedCode；其余缩进按普通文本 |

---

## 11. 关键决策记录

### 11.1 自研扫描器 vs 引入增量库

**决策**：自研。

**理由**：与项目既有取向一致（[SSE 架构文档 §4.4](./Technical%20Architecture/SSE_STREAM_RENDER_ARCHITECTURE.md) 明确"自研状态机，放弃 xstate"）；第三方增量库输出自有 AST/DOM，与现有 `v-html` + scoped `:deep()` 样式体系冲突；markdown-it 本身无增量 API，混用两套解析器会增加不确定性。

### 11.2 三层拆分 vs 单层扫描

**决策**：三层。

**理由**：L0 消除 chunk 边界、L1 消除块级歧义、L2 消除行内歧义，各层职责单一且可独立单测。若合并为单层，`*`+`*` 这类跨 chunk 问题会渗透到块级逻辑中，状态数爆炸。

### 11.3 块级 HTML 缓存：暂不做

**决策**：本期只做"长度 + 时间双阈值节流"，块级缓存列为 P2 备选。

**理由**：markdown-it 解析 1 万字远低于 1ms，真实风险只在数万字长回复，节流足以兜住。而块级缓存有真实语义坑——逐块单独渲染会破坏跨块的 link reference 定义（定义在一个块、引用在另一个块），需要额外的降级判断，属于"为性能引入正确性风险"。

### 11.4 `tail` 用纯文本而非解析渲染

**决策**：`tail` 一律纯文本插值。

**理由**：`tail` 本身就是"语义未定"的部分，解析它等于又一次猜测。以纯文本呈现，用户看到的是打字机真实的中间态（半截 `**` 就是半截 `**`），视觉上最自然，且不存在误判风险。

---

## 附录 A：关键文件索引

**新增**

- `apps/web/utils/markdown-stream.ts` — 内核（行装配 + 块级 FSM + 行内平衡 + 终态降级）
- `apps/web/utils/markdown-stream.test.ts` — 内核单测
- `apps/web/composables/useStreamingMarkdown.ts` — Vue 派生层
- `apps/web/components/chat/StreamingMarkdown.vue` — 渲染组件

**现状（本次改造点）**

- [apps/web/pages/index.vue](../apps/web/pages/index.vue) — 首页对话区 Markdown 渲染
- [apps/web/pages/resume.vue](../apps/web/pages/resume.vue) — 简历页对话面板 Markdown 渲染
- [apps/web/composables/useResumeConversation.ts](../apps/web/composables/useResumeConversation.ts) — 聊天流事件处理与终态分支

**参考（不改动）**

- [apps/web/composables/useSseRenderEngine.ts](../apps/web/composables/useSseRenderEngine.ts) — 分帧渲染管线与打字机
- [apps/web/utils/sse.ts](../apps/web/utils/sse.ts) — SSE 信封解析与 seq 去重
- [docs/Technical Architecture/SSE_STREAM_RENDER_ARCHITECTURE.md](./Technical%20Architecture/SSE_STREAM_RENDER_ARCHITECTURE.md) — 流式渲染架构参考

## 附录 B：术语表

| 术语             | 含义                                                           |
| ---------------- | -------------------------------------------------------------- |
| chunk            | SSE 单次推送的增量文本片段                                     |
| safe             | 已确认结构稳定的前缀，可安全交给 markdown-it                   |
| tail             | 未稳定尾巴，以纯文本渲染                                       |
| blockSafeOffset  | `safe` 的结束偏移（块级维度）                                  |
| inlineSafeOffset | `safe` 的结束偏移（行内维度），≥ `blockSafeOffset`             |
| hold             | FSM 对某块暂缓推进 safe 的行为，记录 `heldAtLine` 作为回退点   |
| 真截断           | 流异常终止且内容不完整的情形（区别于服务端返回的完整错误信息） |
| DONE             | 流正常结束事件（聊天流 `done` / `assistant_done`）             |
