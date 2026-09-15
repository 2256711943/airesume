# SSE 分帧渲染管线 + 打字机 + 背压 面试追问手册

> 适用代码路径（monorepo `apps/web` 前端 + `apps/api` 后端）：
>
> - 分帧渲染引擎（核心）：`apps/web/composables/useSseRenderEngine.ts`
> - SSE 生命周期状态机 / 监督器：`apps/web/composables/useSseMachine.ts` / `useSseSupervisor.ts`
> - 业务装配（简历生成 / AI 聊天）：`apps/web/composables/useResumeGeneration.ts` / `useResumeConversation.ts`
> - 信封解析与 seq 去重：`apps/web/utils/sse.ts`；渲染阶段映射：`apps/web/utils/sse-events.ts`
> - 服务端可回放会话：`apps/api/src/common/sse-session.ts`；简历流编排：`apps/api/src/resume/resume.service.ts`
>
> 背诵策略：先背「一句话答案」，再背「要点」，关键决策问题补「为什么 + 其它方案」，最后记「代码锚点」。面试按 结论 → 要点 → 举例 作答。
>
> 口径说明：本文档以 **当前最新代码** 为准。与根目录简历亮点文案（`docs/resume.md`）的表述差异会显式标注（尤其「打字机降速」的实际接线范围、「80% 长任务下降」的测量口径），避免面试时被追问代码位置时穿帮。
>
> 架构速览：`Ingress（SSE 信封）→ 转换 → 帧缓冲（FrameBuffer）→ 逐帧提交（rAF 驱动）→ DOM`；外围再挂「压力评分 / 五级降级」「打字机帧选择器」「状态机 + 重试」。

---

## 问题总览（按追问优先级排序）

| 优先级             | 问题范围 | 核心词                                                               |
| ------------------ | -------- | -------------------------------------------------------------------- |
| P1（管线本体）     | Q1–Q10   | 为什么自研 / 帧缓冲 / 背压 / 8ms / EWMA / 压力评分 / 降级 / 积压失控 |
| P2（性能与可靠性） | Q11–Q18  | 稳定在预算 / 80% 指标 / 状态机 / 超时 / 重试 / 去重 / 取消竞态       |
| P3（边界深挖）     | Q19–Q24  | 终止项 Flush / 预算冲突 / 半途断开 / 不丢不重 / 裸 API 实现          |

---

## P1 · 管线本体

### Q1. 为什么要自研 SSE 分帧渲染管线？直接收到数据就渲染有什么问题？

**一句话答案**：直接渲染会同时踩中四个坑——**突发批量的渲染工作量打进同一次任务造成长任务掉帧、无法表达打字机节奏、主线程忙时无法感知与降级、以及"流式预览 vs 终态整段结果"的顺序一致性**；所以把"网络到达"与"DOM 提交"解耦成一条由 `requestAnimationFrame` 驱动的分帧管线，让每帧工作量可控、节奏与浏览器绘制对齐。

**直接渲染的问题（逐条）**：

1. **单任务过载**：SSE 一个 `chunk` 可含几十到几百字，LLM 突发时一次读流回调就能连续收到上百个事件；若"收到即 `textContent +=`"，这上百次 DOM 写 + 字素切分全部挤在**一个任务里**同步执行，出现 >16ms 长任务，主线程一卡、整页掉帧。
2. **打字机没法实现**：逐字输出本质上需要"按时间把一段文本摊开"，直接渲染=整段上屏，或退化成每事件一次跳动，都不是逐字效果。
3. **没有压力感知点**：直接渲染没有任何"当前忙不忙"的中间层，主线程一旦过载只能硬扛，无法降速、无法裁剪低优先级帧。
4. **收尾顺序竞态**：`done` 事件携带完整结果，流式预览是异步累积的；不做收口控制会出现"UI 先空/半截、突然被整段替换"的闪烁。
5. 附带问题：DOM 写频率 = 网络到达频率，高频小包造成无谓的布局抖动；渲染无法回放/取消/审计。

**其它方案**：

- 服务端按固定字符数切块下推、前端逐块显示：把"前端速率"职责耦合进服务端，且服务端并不知道客户端当前是否卡顿，放弃。
- 前端 `setInterval` 定时器逐字渲染：与绘制帧不同步、后台标签页被节流导致节奏失真，放弃。
- 微任务队列做分片：没有帧边界，依旧阻塞渲染，放弃。
- rAF + 帧预算 + 缓冲（本项目）本质上是**自己实现了一个极简的"渲染调度器"**——这也是为什么它是可复用的、聊天/简历两场景零改动共用的原因。

**代码锚点**：[useSseRenderEngine.ts](file:///d:/aiprogram/aitext/apps/web/composables/useSseRenderEngine.ts#L3-L9)（模块头注释即管线定义）。

---

### Q2. 你说的"帧缓冲 + 逐帧提交"具体是怎么实现的？

**一句话答案**：数据被塞进**两个带元数据的异步队列**——入口队列 `ingressQueue` 和帧队列 `frameQueue`；一个 rAF 回调（`runFrame`）在**帧预算内**把入口项转成帧项推入帧队列，再调用 `commitBufferedFrame` **整批 drain 帧队列**，经帧选择器挑选后一次 `commitFrame` 提交渲染；没提交完的（`deferredItems`）放回队首等下一帧。

**完整实现（对照 `runFrame` / `commitBufferedFrame`）**：

1. **入队**：SSE 事件到达后 `enqueueIngress` → `createTrackedIngressItem`（打上 `phase` 渲染阶段 + `enqueuedAt` 时间戳）→ 推入 `ingressQueue`，若引擎运行中则 `scheduleNextFrame`（已调度则不重复调度）。
2. **单帧处理 `runFrame(frameTimestamp)`**（由 rAF 触发）：
   - 设置 `isFlushing` 互斥锁防重入；
   - **Ingress 转换阶段**：`while` 循环从 `ingressQueue` 取项 → `transformIngress` 转成 1..N 个帧项（chunk→文本帧、其余→事件帧）→ 推入 `frameQueue`；循环以 **`elapsed >= effectiveBudgetMs` 为出口**（`useSseRenderEngine.ts` L1116-1166）；
   - **帧提交阶段**：`commitBufferedFrame` 把 `frameQueue` **整批 drain**，交给 `selectFrameItems`（打字机选择器按字符配额切成 `commitItems / deferredItems`）→ 对 `commitItems` 调 `commitFrame`（业务：更新 ref → Vue 渲染）→ 返回 `{commitItems, metrics}`；
   - `deferredItems`（本帧没轮到的字）通过 `prepend` **放回帧队列头部**，下一帧继续；
   - 收尾更新监控快照 + EWMA + `commitLagFrames`，再 `scheduleNextFrame` 调度下一帧。
3. **顺序保证**：`commitItems` 逐字呈现的顺序 = 帧队列中的顺序；`deferredItems` 放回队首保证**同一段文本的字不会被乱序**。
4. **失败恢复**：`commitFrame` 抛异常时把整批帧项 `prepend` 恢复回队列（L1079-1084），数据不丢，错误交 `onError`。

**要点**：drain 是"整批取空"，select 是"挑出本帧的量"，两者分离才让「一次只提交预算内的量」成为可能；元数据数组（`queuedIngressMeta` / `pendingFrameMeta`…）始终与数据队列**一一对齐**，保证 phase/age 统计不漂移。

**代码锚点**：[useSseRenderEngine.ts](file:///d:/aiprogram/aitext/apps/web/composables/useSseRenderEngine.ts#L994-L1085)（commitBufferedFrame）、[L1096-L1189](file:///d:/aiprogram/aitext/apps/web/composables/useSseRenderEngine.ts#L1096-L1189)（runFrame）、[L503-L577](file:///d:/aiprogram/aitext/apps/web/composables/useSseRenderEngine.ts#L503-L577)（打字机 select）。

---

### Q3. 你这里为什么要做背压？浏览器端具体哪里产生了"生产速度和消费速度"不匹配？

**一句话答案**：**生产侧是网络读流速度，消费侧是主线程单帧能处理的量，两者天然不同频**——读流回调可以在几十毫秒内同步灌入上百个事件，而 DOM 渲染每帧（~16.67ms）只能做有限工作；不做背压，多余的积压就会在某一次任务里集中爆掉主线程。背压的意义是：**把"积压"变成可观测、可平滑降级的量，而不是直接把主线程卡死**。

**不匹配的具体位置（两层）**：

1. **读流层不等待渲染层**：`consumeSseEventEnvelopeStream` 的 `reader.read()` 循环里 `onEvent` 是**同步回调**，它只把事件交给 Promise 链入队，**不 await 渲染完成**——所以网络吞吐 ≈ 服务端生成速度，可以瞬间远大于"每帧能上屏的字数"。这是最本质的"生产 > 消费"来源。
2. **渲染层的两个限速器**：
   - **帧预算（8ms→可压缩）** 限制每帧 ingress 转换的工作量；
   - **打字机字符速率（120 字符/秒）** 限制文本真正提交到 DOM 的速率（每帧约 2 个字符）。
3. 稳态数据：LLM 实际平均产出约 3 万字 / 10 分钟 ≈ 50 字符/秒 < 120 字符/秒的打字机速率，所以**正常情况积压会自己排空**；背压系统真正要对付的是**突发**（几百字瞬间到达）和**瞬时掉帧**。

**为什么不让读流直接停下来（原生 TCP 背压）**：`reader.read()` 不调用确实会触发传输层流控让服务端写阻塞——但这会让"打字机慢慢放字"的同时网络也停摆，且无法区分是渲染慢还是故意暂停；本项目选择**读得快、缓冲、按帧预算处理**，把背压点在渲染调度层做，这样网络始终畅通、内容只积压不进内存黑洞（见 Q10 的失控兜底）。

**其它方案**：停读流（TCP 流控，简单但粒度粗）；丢弃数据（违反不丢原则）；Web Worker 里渲染（文本 DOM 仍须回主线程，收益有限）。本项目"读-渲分离 + 预算节流 + 缓冲"是在吞吐、流畅度、不丢三者间的平衡。

---

### Q4. 你为什么把帧预算设置成 8ms？为什么不是 16.67ms？

**一句话答案**：16.67ms 是 **60Hz 下整帧的周期**，不是"你的 JS 可以独占的预算"——一帧内还要留给 Vue 渲染、布局、绘制和输入响应。把管线单帧工作量压到 **8ms（约半帧）**，等于给"帧内剩余工作"留出对半余量，是"既够用又不堵死绘制"的经验值；而且它还可以在高压时继续压缩到 6/3/1ms。

**为什么不是 16.67ms**：

1. rAF 回调里的 JS 只是"一帧旅程"的第一段，之后浏览器还要做 style/layout/paint；如果把 16.67ms 全部吃完，帧的绘制阶段就超时，**帧率仍然会掉**，等于预算形同虚设。
2. 一帧里还可能有用户输入、其它任务；独占整帧会让交互（点击/滚动）延迟一个甚至多个帧。
3. 8ms 是经验值：ingress 转换（JSON 展开 + 建帧对象）单项开销很小，8ms 内足以消化绝大多数突发；真正吃时间的文本上屏被打字机 120cps 另行限速，不走这个预算。
4. 8ms 还留下**压缩空间**：`busy→6ms / high→3ms / critical→1ms`（[useSseRenderEngine.ts L1109-1114](file:///d:/aiprogram/aitext/apps/web/composables/useSseRenderEngine.ts#L1109-L1114)），越忙每帧做得越少，主动让出主线程。

**其它方案**：预算设 16.67ms（用满整帧，吞吐大但一帧内其它工作被挤压，掉帧风险高）；设 5ms（更保守，但突发吞吐下降，需要更多帧数消化积压）；动态预算（根据上一帧实际耗时自适应）——本质就是把"超标检测 + 压缩"做进同一个循环，本项目已经用压力等级做了阶梯压缩，等价于一种粗粒度动态预算。

---

### Q5. 你怎么计算一帧的实际耗时？

**一句话答案**：`runFrame` 入口记下 `frameStartedAt = now()`，帧结束（ingress 转换 + 提交全部完成）后用 `lastFrameDurationMs = now() - frameStartedAt` 结算；这个值既写入 `lastFrameDurationMs` ref，也喂给 EWMA 平滑。rAF 自带的 `frameTimestamp` 只用于"帧间隔/字符配额"，不用于耗时统计。

**精确结算点**（[useSseRenderEngine.ts L1105-L1176](file:///d:/aiprogram/aitext/apps/web/composables/useSseRenderEngine.ts#L1105-L1176)）：

1. `frameStartedAt` 在 `isFlushing` 置位后立刻记录（此时还没开始干活）；
2. ingress 预算循环、`commitBufferedFrame`（含 `commitFrame` 业务回调）都算在耗时里；
3. `commitBufferedFrame` 内的 metrics 另算一份 `frameDurationMs` 给业务回调，但监控口径统一用 runFrame 的结算值；
4. 结算后立即更新 EWMA：`frameCostEwmaMs = α×本次 + (1-α)×上次`（见 Q6）。

**为什么用 `now()`（Date.now/注入时钟）而不是 `frameTimestamp`**：`frameTimestamp` 是"本帧开始绘制的时间"（rAF 的 DOMHighResTimeStamp），拿它相减得到的是"帧与帧的间隔"，不是"这一帧干了多久"；要度量 JS 工作量必须用自己的墙钟差。

---

### Q6. EWMA 是什么？为什么这里不用简单平均，而要用 EWMA？

**一句话答案**：EWMA（指数加权移动平均）是"对最近样本加权更重、对越旧样本指数衰减"的平滑方式：`ewma = α × 最新值 + (1-α) × 上一EWMA`。这里取 `α=0.25`，用它对帧耗时做平滑，得到的是"**近几帧的平均负载**"，用来驱动压力评分，避免**单帧抖动（GC、偶发布局）直接触发误降级**。

**为什么不用简单平均（SMA）**：

1. SMA 需要保留最近 N 帧的数组，内存 O(N)；EWMA 只需要一个标量，O(1)。
2. SMA 对窗口内所有样本**等权**：一个 60 帧前的高耗时至今仍占 1/N 权重，衰减太慢、反应迟钝；EWMA 的旧样本按 `(1-α)^k` **指数衰减**，既平滑又贴近当前。
3. SMA 的窗口长度是硬的（N=10 就只看 10 帧），EWMA 的"有效记忆长度 ≈ 1/α = 4 帧"，天然自适应。

**这里的实际用途**：压力评分第三维用的是 `max(0, frameCostEwmaMs - frameBudgetMs) × 2`（最多 20 分）——如果直接用"上一帧耗时"做这一维，任何一帧偶然超预算都会让评分跳变、触发无谓降级；用 EWMA 后只有"连续几帧都超"才会真正抬高压力的这一维度。α=0.25 意味着新的观察约占 1/4 权重，对持续负载的感知大约滞后 4 帧，这是平滑度和灵敏度之间的取舍。

**其它方案**：中位数（对离群点最鲁棒，但要维护有序窗口、开销大）；丢单帧极值后取平均（实现粗糙）；直接用原始值（灵敏但抖动大）。EWMA 是负载平滑的工业标准做法。

**代码锚点**：[useSseRenderEngine.ts L42](file:///d:/aiprogram/aitext/apps/web/composables/useSseRenderEngine.ts#L42)（`PRESSURE_EWMA_ALPHA=0.25`）、[L1171-L1176](file:///d:/aiprogram/aitext/apps/web/composables/useSseRenderEngine.ts#L1171-L1176)（EWMA 更新）。

---

### Q7. 你的压力评分是根据什么指标计算的？

**一句话答案**：**四维加权（0-100）**——`队列深度`（最多 45 分）+ `最老滞留时长`（最多 25 分）+ `EWMA 帧耗时超标`（最多 20 分）+ `连续积压帧数`（最多 10 分）；再映射成五级压力 `idle / normal / busy / high / critical`。核心思想是**既要看"积压了多少"（量），也要看"已经卡了多久"（时间），还要看"主线程是不是真在超时"（代价）**。

**评分公式**（[useSseRenderEngine.ts L687-L696](file:///d:/aiprogram/aitext/apps/web/composables/useSseRenderEngine.ts#L687-L696)）：

```
pressureScore = min(100,
    min(45, 总待处理项数 × 5)                      // ① 队列深度
  + min(25, 最老滞留时长 / 60)                      // ② 滞留时长(ms/60)
  + min(20, max(0, EWMA帧耗时 − 帧预算) × 2)        // ③ 帧耗时超标
  + min(10, 连续积压帧数 × 2))                      // ④ 持续积压
```

**为什么是这四个维度、为什么每维封顶**：

1. **队列深度封顶 45**：`总待处理项 × 5`，9 个待处理项就顶格——深度是"瞬时量"，它大不代表持续，所以要封顶防单次突发直接把评分打满。
2. **滞留时长封顶 25**：取两个队列里 `enqueuedAt` 最老的一项，`ageMs/60`（即 1.5 秒顶格）。它度量的是"最老的数据等了多久"——队列空不空说明不了用户体验，**等了多久才是**。
3. **帧耗时超标封顶 20**：用 Q6 的 EWMA 帧耗时减预算，乘 2（4ms 超标就顶格）。它是唯一直接度量"主线程代价"的维度，防的是"队列很浅但每帧都在超时"的反向情况。
4. **连续积压封顶 10**：`commitLagFrames` 只在"本帧处理完仍有积压"时 +1，否则归零（[L1178](file:///d:/aiprogram/aitext/apps/web/composables/useSseRenderEngine.ts#L1178)）。它识别"**持续**清不空"而忽略瞬时，是"滞留时长"的时间维补充。
5. 为什么要多维：**单指标会被骗**——队列深可能只是瞬时、帧耗时长可能只是单帧抖动、滞留久但队列浅说明积压集中在一段长文本里。四个维度互补后才接近"真实压力"。

**等级映射**：`totalPending===0 → idle`；`score≥85 → critical`；`≥65 → high`；`≥35 → busy`；否则 `normal`（L699-L708）。

**代码锚点**：[useSseRenderEngine.ts L663-L755](file:///d:/aiprogram/aitext/apps/web/composables/useSseRenderEngine.ts#L663-L755)（监控快照 + 评分 + 等级）、[L140-L148](file:///d:/aiprogram/aitext/apps/web/composables/useSseRenderEngine.ts#L140-L148)（`SseRenderBacklogSnapshot`）。

---

### Q8. 压力升高以后具体怎么降级？降级会不会导致内容丢失？

**一句话答案**：四道降级手段，全部只改变"处理时机和每帧量"，**不删内容**——① 压缩帧预算（8→6→3→1ms），每帧少做点；② `high/critical` 下把相邻同阶段帧项**合并**，减少渲染次数；③ 提交阶段**裁剪 decorative 阶段**的帧项；④ 压力回调通知业务层（可让打字机降速，见 Q9）。唯一可能"少渲染"的是 decorative 帧，而该类帧的定义就是"不承载关键信息"。

**四道降级（按代码逐条）**：

1. **帧预算阶梯压缩**（[L1109-1114](file:///d:/aiprogram/aitext/apps/web/composables/useSseRenderEngine.ts#L1109-L1114)）：`critical→min(预算,1ms)`、`high→min(预算,3ms)`、`busy→min(预算,6ms)`——压力越高每帧 ingress 转换做得越少，主线程让出来保证 FPS。
2. **相邻帧项合并**（[L810-L885](file:///d:/aiprogram/aitext/apps/web/composables/useSseRenderEngine.ts#L810-L885) `appendTrackedFrameItems`）：仅 `high/critical` 启用 `mergeFrameItems`，把同 requestId/taskId/variantIndex/field 的连续 chunk 拼成一段，**把"待渲染的帧数"降下来**（内容一字不减，只是打包）。
3. **裁剪 decorative 帧**（[L1029-L1036](file:///d:/aiprogram/aitext/apps/web/composables/useSseRenderEngine.ts#L1029-L1036)）：提交前按 `drainedFrameMeta` 的 phase 过滤掉 `decorative` 项——聊天/简历里的装饰性帧本就是可丢弃的辅助视觉（当前装配未产生 decorative 帧，属于预留策略面）。
4. **业务回调**：`onPressureChange` 在等级变化时触发，业务层可据此调 `onDegrade` 降打字机速率（Q9）。

**降级为什么不会丢内容（关键保证）**：

- `deferredItems`（本帧没轮到的字）不是丢弃，而是 `prepend` 回帧队列**队首**，下一帧继续（L1070-1073）；
- `commitFrame` 抛异常时整批帧项恢复回队列（L1079-1084），等下一帧重试；
- 所有"延后"的元数据（phase/enqueuedAt）与数据项一起回退，统计不断链。
- **语义**：降级=推迟+合并+裁剪可选视觉，不是"丢弃用户要看到的内容"。

**其它方案**：无条件全量渲染（简单但高峰长任务爆掉）；固定丢弃限流（丢内容，违背原则）；直接调低 `charsPerSecond` 全局限速（把降速写死而非按压力触发，体验波动大）。当前"按等级阶梯触发"是**可观测、可回退**的降级。

---

### Q9. 你说"打字机压力高时降速"，具体降的是什么？SSE 也能降速吗？

**一句话答案**：降的是**渲染层"每秒/每帧提交到 DOM 的字符配额"**，即打字机的有效速率参数——压力高时把字符配额调低，把同一段文本摊到更多帧输出，主线程每帧的提交成本随之下降；多余的字符留在帧缓冲里**后续帧补齐，不丢**。SSE 传输本身**不能也不应该降速**——它是服务端按 LLM 生成节奏单向推送的，客户端无法反向命令它放慢；"降速"只能发生在消费端（渲染调度），这是理解本问题最关键的一点。

**具体降什么（引擎内实现）**：

1. **降的是速率参数，不是降帧率**：打字机帧选择器每帧输出字符数 = `effectiveCharsPerSecond × 帧间隔 / 1000`（小数余量 `characterCarry` 累积）。压力感知点在选择器的 `onDegrade(pressureLevel, currentCps)` 回调——引擎把 `context.pressureLevel` 暴露给帧选择器，业务可把 120 阶梯降到 60/30，返回 `<=0` 则**完全放弃打字机、整段一次性提交**（这也是高压下"尽快排空积压"的终极大招）。
2. **引擎自动的部分**：即使业务不配 `onDegrade`，高压下帧预算压缩（Q8-①）+ 文本帧合并（Q8-②）已经让"每帧新增待提交文本量"下降，等效降速。
3. **诚实口径**：`onDegrade` 是引擎提供的标准扩展点且有单测覆盖（[useSseRenderEngine.test.ts L348-L387](file:///d:/aiprogram/aitext/apps/web/composables/useSseRenderEngine.test.ts#L348-L387)）；当前两个装配（简历/聊天）默认用固定 120cps，靠"预算压缩 + 合并 + 缓冲"扛突发——面试如被追问可如实说明"降速钩子已就位、装配上目前以引擎自动降级为主"，比夸大实现更可信。

**SSE 能不能降速（正本清源）**：

- **不能从客户端命令单条 SSE 放慢**：SSE 没有速率协商语义，服务端推多快由生成侧决定。
- **能做的降速都在客户端**：(a) 渲染层限速（打字机配额/帧预算，上面说的）；(b) 传输层天然背压——**停止调用 `reader.read()`**，TCP 接收窗口填满后服务端写入自然阻塞（本项目没停读，所以真正生效的是渲染层节流）；(c) 若要让"服务端"配合，走协议层：本项目 `sinceSeq` + 会话续传天然支持"这轮先断、稍后按游标补拉"，或服务端减少单条事件推送频率/合并文本。
- 一句话给面试官：**降速发生在消费端渲染调度，SSE 是推模型，速率主动权在服务端；客户端能承诺的只是"我按我能承受的速率消费，多余的进缓冲"**。

---

### Q10. 如果生产速度一直大于消费速度，缓冲区越来越大，你怎么办？

**一句话答案**：先分层说清"大"发生在哪：`ingressQueue`（读流→转换）和 `frameQueue`（转换→DOM）各有限速器。引擎给出的保障是**积压不丢、主线程不卡**：每帧强制预算 → 积压只增"排队深度"不增"单帧成本"；压力评分随深度/滞留升高 → 触发降级甚至把打字机降到 0（整段直出）**加速排空**。若仍持续增长（理论上只有"服务端长期 > 120 字符/秒"才会），就到了**读流层背压 + 服务端配合**的范畴。

**现有机制（先讲）**：

1. **打字机 120cps 是天然消费上限**：稳态下 LLM 约 50 字符/秒 < 120，缓冲会自动排空；只有突发会涨。
2. **涨了就降级**：Q8 的四道手段 + `onDegrade` 可把字符速率降到 0——`effectiveCharsPerSecond <= 0` 时打字机选择器直接 `commitItems: [...items]` **整段直出**（[L509-L513](file:///d:/aiprogram/aitext/apps/web/composables/useSseRenderEngine.ts#L509-L513)），用"牺牲逐字效果"换"快速清空"，这是积压失控时的第一应急手段。
3. **合并减项**：`high/critical` 合并相邻 chunk（Q8-②），把"条数"压下去。
4. **内容不丢兜底**：所有延后项回队首、失败恢复、`seq` 续传（Q17），内存里最多堆积"未上屏的文本"，总量有界于单次消息长度。

**真正"生产长期大于消费"的工程对策（超出当前实现的演进方向）**：

- **读端节流**：暂停 `reader.read()`，让 TCP/HTTP 流控自然把背压传导给服务端（对 SSE 有效，服务端写缓冲满了会阻塞）；
- **协议级暂停**：与后端约定 pause/resume 控制面，或"断连 + `sinceSeq` 稍后补拉"，把积压从"内存"转移到"服务端会话缓存"；
- **合并/降采样**：文本只保最终结果（本项目聊天已如此——打字机是过程视觉，`assistant_done`/`done` 带全量内容，可跳过中间态直接定稿）；
- **速率上限治理**：真正不可控时，服务端按固定字符速率切块下推，做"端到端令牌桶"。

**面试口径**：不要只说"缓冲越来越大我没招"。要给出**分层答案**——先在渲染层讲清为什么正常不会爆（消费上限 > 平均生产）、突发怎么办（降级 + 直出）、真失控怎么办（读端流控 + 服务端续传兜底）。

---

## P2 · 性能与可靠性（第二优先级）

### Q11. 你说"高峰期帧耗时稳定在预算"，这个是怎么做到的？

**一句话答案**：不是"运气"，是**结构上把每帧工作量锁死了**——ingress 转换循环以 `elapsed >= effectiveBudgetMs` 硬性退出（到点就停，剩下的下帧再干）；打字机提交量被字符配额锁死；再叠加"EWMA 超标 → 压力上升 → 预算压缩"的负反馈，任何一帧想超都先被两道闸拦住。

**三道闸逐条**：

1. **入口闸（预算即断点）**：`runFrame` 的 while 每轮先算 `elapsedMs = now() - frameStartedAt`，达到预算立即 `break`（[L1118-L1122](file:///d:/aiprogram/aitext/apps/web/composables/useSseRenderEngine.ts#L1118-L1122)）。这一帧干不完的**留在队列里**，不拖到下一帧。这是"帧耗时 ≤ 预算 + 常数"的根本保证。
2. **出口闸（提交量有上限）**：`commitBufferedFrame` 提交的是帧选择器挑出的量（打字机按字符配额），不是队列全部。
3. **负反馈闸（超了就收紧）**：帧耗时 → EWMA → 压力评分维度③；一旦 EWMA 持续超标，压力等级上升 → `effectiveBudgetMs` 从 8 压到 6/3/1ms（Q8-①），**越接近超标越是让你每帧做更少**，把帧耗时拉回预算内。`commitLagFrames` 同源识别"清不空"的状态。

**诚实补充**：这是**设计目标 + 反馈控制**，不是绝对保证——极端情况下单帧（如一次超大 `commitFrame` 的 Vue 全量重渲染）仍可能瞬时超预算；正因为有 EWMA 和降级，它不会**持续**超。面试表达为"用预算截断 + 超标压缩的负反馈把帧耗时稳定在预算附近"是准确的。

---

### Q12. 你怎么证明"长任务频率下降了 80%"？这个指标怎么测？

**一句话答案**：用 **PerformanceObserver 的 `longtask` 条目**做 A/B 对比——在"直接渲染"（基线）和"分帧管线"两条实现上播放同一份 3 万字流式回放，统计每次生成中 `entry.duration > 50ms`（规范定义）或按本项目口径 `>16ms`（超帧周期）的任务次数与总时长，归一化后求相对降幅。80% 是内部基准的相对值，面试需讲清口径。

**测量方法（可落地的四条）**：

1. **长任务采集**：`new PerformanceObserver(list => ...)`，`observe({ type: 'longtask', buffered: true })`——规范里长任务阈值是 50ms，前端流畅度语境常收紧到 16ms（超过一帧）来统计"会掉帧的任务"。
2. **A/B 对照**：同一份固定 SSE 事件回放（几十上百个 chunk、固定间隔）分别喂给「收到即渲染」与「useSseRenderEngine 管线」，各跑 N 次，记录每次的：长任务次数、单任务最大时长、掉帧数（rAF 时间戳间隔 > 20ms 记为掉帧）。
3. **归一化与口径**：除以本次总时长或总字数，得到"每千字长任务次数"，再比 `(基线 - 管线)/基线` 得降幅。
4. **结合引擎自有的监控**：`resumeRenderMonitoring` 已暴露 `frameCostEwmaMs / frameDurationMs / pressureLevel`，可同时证明"帧耗时收敛在预算内"（Q11）。

**诚实口径**：80% 是**内部基准数据/项目口径**，不是线上生产埋点统计。面试若被追问，给两句话：① 数字来源于 A/B 回放压测 + PerformanceObserver 长任务统计；② 线上若要做严格证明，应埋 `longtask` 观测点 + 用 RUM 数据按版本对比。绝不要把内部基准说成生产环境普查结论。

---

### Q13. 为什么需要用状态机管理 SSE 生命周期？不用状态机会有什么问题？

**一句话答案**：SSE 一次连接的完整生命周期横跨 **8 个状态 × 10 个事件**，且存在三类高发竞态（旧连接迟到回调、取消与重试交错、暂停/恢复与断流并存）——用 `if/else` 手写判断会让"状态 × 事件"的组合矩阵散落在各处，漏一条就是 bug；状态机把**合法迁移收敛成一张表**，非法迁移在开发环境直接抛错、生产环境告警，把错误前置。

**不用状态机的具体问题**：

1. **状态组合爆炸**：`idle/connecting/streaming/done/error/canceled/retrying/paused` × 各种动作，手写判断极易漏掉"某个状态下收到了不该来的事件"这种组合。
2. **竞态无法系统性防住**：重连后旧连接的回调还在路上（迟到的 chunk、迟到的错误）——没有状态机/runId 机制，旧回调会污染新一轮连接（"用户已发第二条消息，第一条的流才断，把 UI 置成 error"）。
3. **取消语义不可靠**：取消要分场景（连接中取消 vs 流式中取消 vs 重试等待中取消），散落逻辑容易"取消了还在重试"。
4. **迁移不可审计**：没有统一迁移点，就没有 `onStateChange` 快照，无法驱动 UI 的 `generating/sendingMessage` 计算属性。

**状态机方案**：合法迁移表 `LEGAL_TRANSITIONS`（[useSseMachine.ts L84-L121](file:///d:/aiprogram/aitext/apps/web/composables/useSseMachine.ts#L84-L121)）+ 非法迁移 dev 抛错/prod 告警（[L335-L343](file:///d:/aiprogram/aitext/apps/web/composables/useSseMachine.ts#L335-L343)）+ `activeRunId` 竞态护栏（每次连接递增，过期 run 的回调一律忽略）+ 每轮独立 AbortController。状态机管**单次连接**，监督器管**多次尝试**（职责分离）。

**其它方案**：引入 xstate 等状态机库（本项目状态规模小，自研 200 行即可、零依赖）；无状态机的回调地狱（上文已列问题）。状态数一旦超过 ~5 且事件数超过 ~5，自研合法迁移表仍然比"手写 if"划算。

**代码锚点**：[useSseMachine.ts L183-L233](file:///d:/aiprogram/aitext/apps/web/composables/useSseMachine.ts#L183-L233)（connect 主流程含竞态保护）。

---

### Q14. 你的 SSE 状态有哪些？状态之间怎么转换？

**一句话答案**：**8 个状态**：`idle（初始）→ connecting（已发 fetch 等响应）→ streaming（正在消费事件流）→ done（正常结束）/ error（失败）/ canceled（主动取消）`，外加两个过渡态 `retrying（退避等待中）/ paused（暂停消费）`；所有转换由**合法迁移表**约束。

**状态 + 合法迁移表**（[useSseMachine.ts L84-L121](file:///d:/aiprogram/aitext/apps/web/composables/useSseMachine.ts#L84-L121)）：

| 当前状态         | 合法事件 → 目标                                                           |
| ---------------- | ------------------------------------------------------------------------- |
| `idle`           | CONNECT → `connecting`                                                    |
| `connecting`     | CONNECTED → `streaming`；TIMEOUT/ERROR → `error`；CANCEL → `canceled`     |
| `streaming`      | COMPLETE → `done`；PAUSE → `paused`；ERROR → `error`；CANCEL → `canceled` |
| `done` / `error` | RESET → `idle`                                                            |
| `error`          | RETRY → `retrying`；CANCEL → `canceled`                                   |
| `canceled`       | RESET → `idle`                                                            |
| `retrying`       | CONNECT → `connecting`；CANCEL → `canceled`                               |
| `paused`         | RESUME → `streaming`；CANCEL → `canceled`                                 |

**关键转换路径**（对照代码）：

1. **正常**：`supervisor.connect → idle.CONNECT → connecting`，fetch 响应头到达且未取消 → `CONNECTED → streaming`，`consumeResponse` 消费完流 → `COMPLETE → done`。
2. **断流**：streaming 中消费抛 `SseStreamDisconnectedError` → `ERROR → error` → 监督器 `retry()` → `retrying` → 退避后重连 → `CONNECT → connecting` → `streaming`（Q16）。
3. **取消**：任意可取消态 `CANCEL → canceled`（AbortError 在 connecting/streaming 也映射到 CANCEL，见 [L216-L222](file:///d:/aiprogram/aitext/apps/web/composables/useSseMachine.ts#L216-L222)）。
4. **上下文**：`context.error` 记录失败原因、`context.retryCount` 随 RETRY 递增（[L288-L319](file:///d:/aiprogram/aitext/apps/web/composables/useSseMachine.ts#L288-L319)），供外部展示与审计。

**为什么这样设计**：`done/error/canceled` 是**吸收态**（只能 RESET 回 idle），保证一轮连接的生命周期有清晰终点，杜绝"结束了还能再收事件"；`retrying/paused` 是**过渡态**，限制中间态可发生的事，让监督器的重试编排（Q16）与暂停/恢复（组件切后台场景）都有明确落点。

---

### Q15. SSE 超时是怎么检测的？怎么区分"真正断开"和"只是暂时没有数据"？

**一句话答案**：**靠流语义而不是时间阈值区分**——"真正断开" = 读流循环**物理结束（EOF）却没收到终态事件**，抛 `SseStreamDisconnectedError`（这是唯一触发重试的错误）；"暂时没数据" = `reader.read()` 一直 pending、没到 EOF，这恰恰是 LLM 思考/工具执行阶段的正常态，**不判超时**。超时兜底放在服务端：会话 `idleAbortMs=10s`，客户端断线后 10 秒不重连就中止底层生成任务。

**为什么不能"没数据超过 N 秒就判断开"**：

1. 一条生成流里存在**合法长静默**：Agent 在调工具、LLM 在推理时可能几秒~几十秒没有任何事件；用静默时长判超时会把正常生成误杀。
2. 所以判断依据不是"多久没数据"，而是**传输层是否真的结束了**：`reader.read()` 返回 `done:true`（流被服务端关闭/网络断开导致 EOF），此时若还没见过 `done/error/canceled` 终态 → 一定不是正常收尾 → `SseStreamDisconnectedError`（[sse.ts L184-L186](file:///d:/aiprogram/aitext/apps/web/utils/sse.ts#L184-L186)）。
3. 连接建立阶段的超时（fetch 迟迟不返回响应头）走状态机 `connecting.TIMEOUT → error`（[useSseMachine.ts L267-L270](file:///d:/aiprogram/aitext/apps/web/composables/useSseMachine.ts#L267-L270)）——不同阶段用不同的判定通道。

**服务端配合（双层超时）**：

- 会话订阅者全部断开后 `scheduleIdleAbort` 计时 `idleAbortMs`（默认 10s），到期 abort 底层 LLM 请求并结束会话（[sse-session.ts L362-L369](file:///d:/aiprogram/aitext/apps/api/src/common/sse-session.ts#L362-L369)）；会话事件缓存保留 `retainMs`（默认 60s）供重连回放（[L371-L376](file:///d:/aiprogram/aitext/apps/api/src/common/sse-session.ts#L371-L376)）。
- 简历生成会话显式 `idleAbortMs: 10_000` + `onIdleAbort`（[resume.service.ts L366-L367](file:///d:/aiprogram/aitext/apps/api/src/resume/resume.service.ts#L366-L367)）。

**其它方案**：客户端设"心跳/keep-alive"（服务端周期性发 comment/事件帧，客户端超时未收即判死）——适合需要快速感知死链的场景，但会给 10 分钟长流增加事件量与复杂度；本项目用"EOF 判断 + 服务端 idle 兜底"，对"可恢复的断流"和"不可恢复的断连"分层处理更省。

---

### Q16. 什么时候触发自动重试？有没有最大重试次数？

**一句话答案**：**只对"流中断"重试**——`consumeResponse` 抛出的 `SseStreamDisconnectedError`（读到 EOF 但没见到终态，Q15），且 `attempt <= maxRetries`；当前简历/聊天统一配置 **`maxRetries: 1`**（最多重连 1 次）。主动取消（AbortError）、HTTP 非 2xx、401 全部**不重试**直接进 error/canceled。

**判定与编排**（[useSseSupervisor.ts L99-L140](file:///d:/aiprogram/aitext/apps/web/composables/useSseSupervisor.ts#L99-L140)）：

1. `supervisor.connect` 循环：catch 到错误后先查 `state === 'canceled'`（取消则静默返回，不重试）；
2. 再判 `nextAttempt > maxRetries || !shouldRetry(error)` → 超限或不可重试就 `throw error`；
3. 可重试则 `wait(getRetryDelayMs(nextAttempt))`（默认指数退避：`min(30s, 1s × 2^(attempt-1))` 的随机值，[L43-L49](file:///d:/aiprogram/aitext/apps/web/composables/useSseSupervisor.ts#L43-L49)），期间状态机进入 `retrying`；
4. 简历/聊天业务侧 `shouldRetry` 都只认 `SseStreamDisconnectedError`（[useResumeGeneration.ts L370-L372](file:///d:/aiprogram/aitext/apps/web/composables/useResumeGeneration.ts#L370-L372)）。

**为什么只有 1 次**：LLM 生成本身有真实成本（token + 后端任务），无限重试会放大成本；且大部分可恢复断流一次重连即成功，连续两次断流说明是更严重的问题（网络/服务端），应直接失败暴露而不是无限消耗。**为什么指数退避还要加随机抖动**：避免多客户端同时断线后在同一时刻重连，打爆服务端（分布式重试常识）。

**其它方案**：对 429/限流类错误也重试（本项目 HTTP 错误不重试，因为 429 语义上是"不该再打"，后端会标记 run 失败）；把 maxRetries 提为可配置（不同价值场景不同次数）；做熔断器（连续失败 N 次进入冷却）。当前 chat/resume 场景 `1` 次是成本与可靠性间的平衡点。

---

### Q17. 如果 SSE 断开后重试，怎么避免已经收到的数据被重复渲染？

**一句话答案**：**seq 全局去重双保险 + 渲染引擎重建**——① 服务端会话把事件按递增 `seq` 缓存，重连请求带 `sinceSeq=lastSeq`，只补发 `seq > lastSeq` 的事件（服务端不重发旧事件）；② 客户端解析时对 `envelope.seq <= lastSeq` 的事件**再丢一次**（[sse.ts L147-L154](file:///d:/aiprogram/aitext/apps/web/utils/sse.ts#L147-L154)），防御任何重复；③ 每次重连前 `dispose` 并重启渲染引擎 + `reset` 打字机选择器，旧连接滞留在缓冲里的帧被清掉，从断点重新消费。

**三道防线逐条**：

1. **服务端游标**：`subscribe(session, sinceSeq)` 只回放 `event.seq > sinceSeq`（[sse-session.ts L155-L161](file:///d:/aiprogram/aitext/apps/api/src/common/sse-session.ts#L155-L161)）；客户端 `consumeResponse` 每轮把 `lastEventSeq` 带上（简历 GET 参数 / 聊天 body 的 `sinceSeq`）。
2. **客户端去重**：解析层 `envelope.seq <= lastSeq` 直接丢弃——即使服务端/网络把事件重发，本地也绝不会二次入队、二次上屏。
3. **引擎复位**：重连后先 `generationTypewriterSelector.reset()`（清掉 `previousFrameTimestamp/characterCarry`）+ `engine.dispose()` + `engine.start()`（[useResumeGeneration.ts L326-L328](file:///d:/aiprogram/aitext/apps/web/composables/useResumeGeneration.ts#L326-L328)），保证打字机从"断点字符"重新逐字，而不是和旧缓冲叠加。

**诚实的边界（面试主动点出加分）**：`lastSeq` 是在**事件被读取时**推进的（`onEvent` 同步里 `lastEventSeq.value = seq`），不是"渲染到 DOM 后才推进"。若断开恰好发生在"事件已收到、但还躺在引擎缓冲里没上屏"的那一帧窗口，这些事件既不会从服务端补发（游标已过），又会被引擎重建清掉——表现为**极小概率少渲染一段预览文本**。对简历流无实质影响（最终内容由 `done` 事件的完整 `variants` 负载回填）；对聊天流可通过"把续传游标改成提交点（flush 后）推进"根治。这是"读得快 + 缓冲渲染"架构下已知的精度取舍，讲出来比藏着更能体现对一致性的理解。

---

### Q18. 如果用户主动点击停止，这时候刚好触发自动重试，怎么处理？

**一句话答案**：**取消优先于重试**——`supervisor.cancel()` 会做两件事：① `clearRetryTimer()` 清掉退避定时器并**立即唤醒**正在 `wait` 的重试等待方；② 状态机 `retrying.CANCEL → canceled` 并 abort 本轮 controller。被唤醒的重试循环读到 `state === 'canceled'` 直接静默返回（[useSseSupervisor.ts L121-L124 / L133-L135](file:///d:/aiprogram/aitext/apps/web/composables/useSseSupervisor.ts#L121-L135)）——不会发起下一次连接。

**三个竞态窗口逐一处理**：

1. **正在退避等待中点击停止**：`clearRetryTimer` 先清定时器再 resolve 等待 Promise → 循环继续 → 发现 `canceled` → 返回。定时器不会在取消后再触发重连（先 clearTimeout 保证了这点）。
2. **正在 connecting（fetch 未返回）时点击停止**：`cancel()` 先 `transition('CANCEL')`（connecting→canceled）再 `controller.abort()`——pending 的 fetch 立即抛 AbortError，`connect` 的 catch 里判到 `isAbortError` 且处于 connecting → 走 `CANCEL`，不上抛、不重试（[useSseMachine.ts L216-L222](file:///d:/aiprogram/aitext/apps/web/composables/useSseMachine.ts#L216-L222)）。
3. **正在 streaming 消费中点击停止**：`controller.abort()` → `reader.read()` 抛 AbortError → 同上映射为 canceled；消费循环中断，`consumeResponse` 异常不会触发重试。
4. **停止后又立刻发起新一轮**：新一轮 `startGenerateStream` 会先判 `RESETTABLE_MACHINE_STATES`（含 canceled）→ `supervisor.reset()`（activeRunId 自增 + 废弃旧 controller）再 connect，旧连接的迟到回调因 `isActiveRun` 判否被忽略（Q14）。

**为什么"取消必须打断退避等待"**：若取消只 abort 当前连接而不管定时器，重试会在用户点停后数秒仍然发生——用户以为停了、请求却"复活"，体验与成本都不可接受。所以 `cancel()` 的关键副作用是**唤醒正在 wait 的重试方并让它看到 canceled 状态**（[useSseSupervisor.ts L186-L198](file:///d:/aiprogram/aitext/apps/web/composables/useSseSupervisor.ts#L186-L198)），而不是等定时器自然到点。

**其它方案**：取消用独立的 generation token 全局作废（与 activeRunId 同理，但粒度更大）；或"取消需二次确认"（产品层）。当前"canceled 吸收态 + 定时器可唤醒"已闭环，UI 上通过 `generating` 计算属性（state∈{connecting,streaming,paused,retrying}）自动恢复可点击状态。

---

## P3 · 边界深挖（第三优先级）

### Q19. 如果当前处于高压力降级状态，这时候收到终止项，你为什么要立即 Flush？

**一句话答案**：因为**终止项（done/error/canceled）宣告"不会再有新内容了"，继续打字机限速没有意义且有害**——若还按 120cps 慢慢吐，用户会看到 UI 卡在半截、迟迟拿不到携带完整结果的终态，甚至造成"done 已到但预览不全"的闪烁；所以终止项触发两层收口：帧选择器遇到终止项**立即提交所有累积帧项**（含终止项本身），引擎再 `flush()` 把残留帧一次性清空。

**两层收口**：

1. **帧选择器层**：`createTypewriterFrameSelector` 遍历时若 `isTerminalItem(item)` 为真，直接返回 `commitItems: [...commitItems, item], deferredItems: []`（[useSseRenderEngine.ts L561-L567](file:///d:/aiprogram/aitext/apps/web/composables/useSseRenderEngine.ts#L561-L567)）——把前面积压的文本连同终止项整批交出去，不再逐字拖。
2. **引擎层**：业务在流结束后 `await enqueueRenderTask`（确保全部事件入队完成）→ `engine.flush()`（`while (hasPendingWork()) runFrame(now(), true)`）把 ingress/帧队列**强制处理到空**（[useSseRenderEngine.ts L1236-L1240](file:///d:/aiprogram/aitext/apps/web/composables/useSseRenderEngine.ts#L1236-L1240)；装配处 [useResumeGeneration.ts L350-L352](file:///d:/aiprogram/aitext/apps/web/composables/useResumeGeneration.ts#L350-L352)）。

**为什么降级状态更要立即 Flush（而不是继续降级）**：降级保护的是**"中间过程"的资源**（别让打字机阻塞交互）；而终止项代表的是**"结果收口"的一致性**——压力再高，拿到 `done` 后预览内容必须 == 完整结果。这两件事目标不同：过程可以慢，结果不能缺。收到终态还限速，是把"过程降级策略"错误地用在"结果一致性"上。

**代码锚点**：简历 `done` 帧即终止帧的判定在 [useResumeGeneration.ts L216-L221](file:///d:/aiprogram/aitext/apps/web/composables/useResumeGeneration.ts#L216-L221)；聊天 `done/error` 判定在 [useResumeConversation.ts L572-L577](file:///d:/aiprogram/aitext/apps/web/composables/useResumeConversation.ts#L572-L577)。

---

### Q20. 立即 Flush 会不会打破你的 8ms 帧预算？

**一句话答案**：**会，但这是有意为之且可接受的**——`flush()` 用 `force=true` 以同步循环把积压全部处理完，本质是"一次把预算吃超、清空收尾"，代价是可能产生一个较长的任务；但它只在**终态且仅此一次**发生，且通常剩余量很小，换来的是"最终状态一次性正确"（无闪烁、无半截），收益远大于这一次短暂阻塞。若连这一次都想避免，可改用"提高每帧配额直到排空"的跨帧方案。

**要点**：

1. 为什么允许破预算：正常渲染期 8ms 预算保护的是**持续交互的流畅度**（几十秒~10 分钟的流）；flush 发生在**流已结束**的时刻，后面不再有新帧、用户正在等结果，此时优先级反转——正确性 > 帧平滑。
2. flush 的规模是**有界的**：残余 = "已入队未上屏的文本"≈ 打字机配额(120cps)×最近帧数，通常几十~几百字符，一次提交的 DOM 成本很低。
3. **更平滑的替代方案（如果连终态也想保帧率）**：终止时不走一次性 flush，而是给帧选择器注入 `onDegrade` 让它返回 `<=0`（整段直出），并保持 rAF 逐帧跑——每帧提交全量积压、排空即停。效果等价、却把大块 JS 摊到多个帧。当前代码选 flush 是"实现简单 + 终态一次可接受"，面试可主动给出这个替代并说明取舍。

**代码锚点**：[useSseRenderEngine.ts L1096-L1102](file:///d:/aiprogram/aitext/apps/web/composables/useSseRenderEngine.ts#L1096-L1102)（force 语义：跳过 isRunning 检查，仅作为"收尾强制执行"标志）。

---

### Q21. 如果用户停止时，帧缓冲里还有没渲染的数据，你怎么处理？

**一句话答案**：**丢弃（清空）但不回滚已展示内容**——`cancelGenerate` 走 `supervisor.cancel()`：状态机进 `canceled` + abort controller（停止读流），组件卸载/取消路径再调 `engine.dispose()`，`dispose` 会清空 ingress 队列与帧队列、cancel 掉已调度的 rAF（[useSseRenderEngine.ts L1243-L1261](file:///d:/aiprogram/aitext/apps/web/composables/useSseRenderEngine.ts#L1243-L1261)）——队列里还没上屏的字不再渲染。

**处理链路**：

1. **取消即停**：`cancel()` → `transition('CANCEL')` → `controller.abort()`，消费循环中断，不再有新事件入队（[useSseMachine.ts L236-L243](file:///d:/aiprogram/aitext/apps/web/composables/useSseMachine.ts#L236-L243)）。
2. **清缓冲**：`engine.dispose()` 清空 `ingressQueue/frameQueue` + 元数据 + `lastFrameDurationMs` 归零，UI 停在"已渲染到的位置"。
3. **展示收口**：简历流给用户"生成已取消"状态；不触发 `seedGeneratedConversation`（未完成结果不落库，因为 `resumeVariants` 只在 `done` 时才填充）。聊天的半截回答保留为用户可见内容。
4. **异步兜底**：取消后不会有迟到回调写 UI——渲染引擎已 dispose、状态机已 canceled、`activeRunId` 已作废（Q14/Q18）。

**为什么"清空"而不是"继续渲完"**：用户点停 = 不再关心剩余内容，继续渲只会浪费主线程并造成"停了还在动"的错觉；而**已上屏的内容不回滚**是为了尊重用户已读到的上下文。这和 Q17 的"断开要续传"是两种语义：断开是意外（尽量补），取消是意愿（立即停）。

**代码锚点**：业务侧 `cancelGenerate`/`dispose` 见 [useResumeGeneration.ts L470-L485](file:///d:/aiprogram/aitext/apps/web/composables/useResumeGeneration.ts#L470-L485)。

---

### Q22. 如果 SSE 在输出到一半时断开，缓冲区、状态机和重试逻辑分别怎么处理？

**一句话答案**：三件事按序联动——**解析层**读到 EOF 且无终态 → 抛 `SseStreamDisconnectedError`；**状态机** streaming→error；**监督器**判定可重试（唯一允许重试的错误）→ 退避后带 `sinceSeq=lastSeq` 重连；**服务端会话**只补发 `seq > sinceSeq` 的事件；**渲染引擎与打字机选择器**在每轮连接建立时先 reset/dispose 再 start，从断点重新消费。

**逐层处置**：

1. **缓冲区**：
   - 已上屏内容：保留，不回滚；
   - 引擎里已入队未上屏的帧：本轮连接失败后不 flush，重连时 `dispose()` 清掉（Q17 已述这带来一个极小"已收未渲"窗口）；
   - 数据完整性：真正的内容不靠中间帧兜底——简历完整结果在 `done.variants`，chat 完整文本在后续 replay 的 chunk + `assistant_done`，它们都在断点之后、会被 sinceSeq 补回。
2. **状态机**：`streaming` 消费抛错（非 AbortError）→ `transition('ERROR')` 进 error（[useSseMachine.ts L224-L226](file:///d:/aiprogram/aitext/apps/web/composables/useSseMachine.ts#L224-L226)）。
3. **重试逻辑**：监督器 catch → 未 canceled、`shouldRetry` 命中（仅 `SseStreamDisconnectedError`）且未超 `maxRetries=1` → `machine.retry()`（retrying）→ `wait` 退避 → 重连（attempt+1）；若第二次仍断或不可重试 → throw，UI 展示失败（run 已被后端标记 failed/timeout）。
4. **服务端会话**：重连请求带同一 `streamKey + sinceSeq`；会话在 `retainMs`(60s) 内存在即**回放 + 续订**，超过则视为失败（会话已被 idle 清理）。

**面试一句**：断流是"意外"，系统的目标不是重放整条流，而是**把消费游标（seq）钉住、从断点继续**——状态机保证只有一次连接活着，监督器保证只对可恢复错误重试，缓冲与续传保证内容最终一致。

---

### Q23. 如果服务端已经生成了数据，但客户端网络断开了，重试之后怎么保证数据不丢、不重？

**一句话答案**：**"不丢"靠服务端会话缓存 + sinceSeq 补发，"不重"靠 seq 单调去重**——服务端把每条事件按递增 `seq` 缓存于会话，客户端断开后带 `sinceSeq=lastSeq` 重连，服务端只从游标之后补发（已生成的但客户端没拿到的自然包含在内，游标之前的不再发）；客户端解析时再对 `seq <= lastSeq` 丢弃一次，形成双保险。

**完整闭环**：

1. **不丢（服务端侧）**：`ReplayableSseSession` 每 emit 一条事件即写入内存缓冲并编号（[sse-session.ts L153-L161](file:///d:/aiprogram/aitext/apps/api/src/common/sse-session.ts#L153-L161)）；重连时 `subscribe(subscriber, sinceSeq)` 同步回放 `seq > sinceSeq` 的全部事件，再继续订阅后续增量——客户端断网期间服务端新产生的数据会被"下一次 read"读到，**前提是会话还活着**（idle abort 10s / retain 60s 内重连，[resume.service.ts L356-L370](file:///d:/aiprogram/aitext/apps/api/src/resume/resume.service.ts#L356-L370)）。
2. **不重（客户端侧）**：`consumeSseEventEnvelopeStream` 以 `lastSeq` 过滤，`envelope.seq <= lastSeq` 直接丢弃（[sse.ts L147-L154](file:///d:/aiprogram/aitext/apps/web/utils/sse.ts#L147-L154)）；即使网络把事件重复投递或服务端补发范围过宽，本地也只消费一次。
3. **不重（打字机侧）**：重连先 `reset` 选择器再消费，已展示的文本不会因补发再播一遍。

**可靠性的边界（诚实陈述）**：

- **丢的可能**：客户端断开超过 10s（idle abort 已中止底层 LLM + 销毁会话）→ 无法补发，只能整轮失败报错——这是刻意选择的成本上限，不是无限重试；
- **序**：`seq` 在**同一会话内**单调，重连续传保证的是该会话内顺序；跨会话（用户新开一轮）用 `activeRunId` 隔离。
- 面试话术：**不丢/不重的前提是"会话仍可回放"**；它把"网络断连"从"任务失败"降级为"重放间隙"，这是相对 HTTP 一次性响应最大的架构收益。

---

### Q24. 如果让你不用第三方库，只使用 requestAnimationFrame、SSE 和浏览器 API，你会怎么实现这个分帧渲染管线？

**一句话答案**：这套管线本身就是纯浏览器 API 实现的（Vue 只是渲染目标、引擎零第三方依赖），所以"裸实现"就是把它拆回最朴素的四件套——**① fetch + ReadableStream 手拆 SSE 帧；② 数组队列做缓冲；③ rAF 循环 + 时间预算做调度；④ 一个计数器做"逐字"限速**。

**裸实现骨架**：

1. **读流**：`fetch(url)` → `response.body.getReader()` + `TextDecoder`，按 `\n\n` 切帧、解析 `event:/data:`（手写 `parseSseFrame`），维护 `lastSeq` 去重——等价于 `utils/sse.ts` 的 `consumeSseEventEnvelopeStream`。
2. **缓冲**：两个普通数组（ingress 待转换、frame 待提交），入队即更新计数。
3. **调度**：单例 rAF 循环，回调里用 `performance.now()` 算 `elapsed`，超过预算（8ms）就 break 留到下一帧；每帧结束若仍有积压则继续 `requestAnimationFrame`，没有就停。后台标签页 rAF 被节流的问题用"收到新数据时重新 schedule"兜住。
4. **打字机（不逐字 DOM）**：维护"完整文本 buffer + 已显示字符数指针"，每帧按 `cps × 帧间隔` 累加指针、`slice(0, count)` 一次性设置 `textContent`——**不要每字插一个 `<span>`**，那会让 DOM 节点数 = 字数；指针式单次写是性能关键。字素粒度用 `Intl.Segmenter`（不可用降级 `Array.from`）算"可显示字符边界"。
5. **背压**：`pending` 计数 + 最老等待时长做压力；超阈值就把 cps/每帧预算调低；`done` 时把指针拨到末尾收口。
6. **取消/收尾**：`AbortController` 贯穿 fetch；`cancelAnimationFrame` 停调度；`flush` = 同步把指针拨到底。

**为什么不需要第三方库（对"自研"的正当性解释）**：核心难点是**调度策略与状态管理**（预算、压力、去重、终态、取消竞态），这些全是应用逻辑，浏览器只提供 rAF/AbortController/Streams 这些**原语**；Vue/React 这类库在此处只是"声明式地把状态变 DOM"，不是"分帧渲染"的实现者。这也正是面试可以强调的：**分帧管线不依赖任何渲染框架，框架只消费 commitFrame 的结果**。

**可选增强（不引库也够）**：`PerformanceObserver('longtask')` 做线上长任务统计（Q12）、`document.visibilitychange` 处理后台暂停恢复、`EventSource` 替代 fetch 时利用其 `last-event-id` 自动重连（但 EventSource 无法带自定义 header/任意方法，本项目鉴权走 header，故用 fetch 流）。

---

## 高频追问节奏速记

| 追问方向              | 先答什么                                           | 再补什么                                    | 代码锚点                         |
| --------------------- | -------------------------------------------------- | ------------------------------------------- | -------------------------------- |
| 为什么自研管线        | 直接渲染有 4 个坑（长任务/打字机/无降级/收尾竞态） | 把网络到达与 DOM 提交解耦成 rAF 驱动        | `useSseRenderEngine.ts` 头注释   |
| 帧缓冲怎么实现        | ingress/帧双队列 + 预算内转换 + 整批 drain 挑选    | deferred 回队首、失败恢复、元数据对齐       | `runFrame`/`commitBufferedFrame` |
| 为什么背压            | 生产=读流速度，消费=单帧主线程量                   | 不匹配在突发；稳态 50cps<120cps 会自排空    | `consumeSseEventEnvelopeStream`  |
| 为什么 8ms 不是 16.67 | 16.67 是整帧周期非独占预算                         | 留半帧给绘制；还有 6/3/1 可压缩             | `DEFAULT_FRAME_BUDGET_MS`        |
| 帧耗时怎么算          | 入口 now() 到提交完成结算                          | rAF 时间戳是帧间隔不是耗时                  | runFrame L1105-1176              |
| 为什么 EWMA           | O(1)、近期加权、旧样本指数衰减                     | 防单帧抖动误降级，滞后约 4 帧               | α=0.25                           |
| 压力评分维度          | 队列45/滞留25/帧耗时超标20/连续积压10              | 每维封顶、互补不骗人                        | snapshot L687-696                |
| 降级会丢内容吗        | 只推迟/合并/裁 decorative                          | deferred 回队首 + 异常恢复整批回队          | L1070-1084                       |
| 打字机降速降什么      | 降每秒提交 DOM 的字符配额                          | SSE 不能降速，只能消费端节流                | `onDegrade`                      |
| 缓冲一直涨怎么办      | 正常不涨（消费上限>平均生产）                      | 降 cps 到 0 直出 / 读端流控 / sinceSeq 续传 | `effectiveCharsPerSecond<=0`     |
| 稳定在预算怎么做到    | 预算截断 + 提交限量 + 超标压缩负反馈               | 是设计目标非绝对保证                        | effectiveBudgetMs                |
| 80% 怎么测            | PerformanceObserver longtask A/B                   | 讲口径，内部基准非线上普查                  | `monitoring` 快照                |
| 为什么状态机          | 8态×10事件矩阵 + 三类竞态                          | 合法迁移表 + activeRunId + 职责分离         | `LEGAL_TRANSITIONS`              |
| 超时 vs 没数据        | EOF+无终态=断开；read 未结束=正常静默              | 服务端 idle 10s 兜底；connecting 走 TIMEOUT | `sse-session.ts`                 |
| 何时重试/几次         | 仅 SseStreamDisconnectedError，maxRetries=1        | 取消/HTTP 错不重试；退避+抖动               | `useSseSupervisor.connect`       |
| 重试怎么不重渲        | 服务端 sinceSeq 只补游标后 + 客户端 seq 再丢       | 引擎 reset 重建；诚实讲"已收未渲"窗口       | `sse.ts` seq 去重                |
| 停止撞上重试          | cancel 先唤醒 wait 再进 canceled                   | 三个窗口分别处理；取消优先于重试            | `clearRetryTimer`                |
| 终态为何立即 flush    | 终态=不再有内容，继续打字机无意义                  | 结果一致性优先于过程降级                    | typewriter L561-567              |
| flush 破预算吗        | 会但仅终态一次、量有界                             | 替代=onDegrade 置 0 + 跨帧排空              | flush L1236-1240                 |

## 必须背的数字

- 帧预算：`8ms`（`DEFAULT_FRAME_BUDGET_MS`）；初始帧时长 `1000/60`；高压压缩 `busy→6ms / high→3ms / critical→1ms`
- 打字机速率：简历/聊天均 `120` 字符/秒（`GENERATION_TYPEWRITER_CHARS_PER_SECOND` / `CHAT_TYPEWRITER_CHARS_PER_SECOND`）
- 压力评分：`min(45, 项数×5) + min(25, 最老滞留/60) + min(20, max(0, EWMA-预算)×2) + min(10, 连续积压×2)`，封顶 100
- 压力等级：`idle(空) / normal(<35) / busy(35-64) / high(65-84) / critical(85+)`
- EWMA：`α=0.25`（有效记忆 ≈ 4 帧）
- 渲染阶段：`critical / state / bulk / decorative / unknown`（critical=done/error/终态；bulk=chunk/assistant_chunk；state=进度/工具事件）
- SSE 状态机：8 状态（idle/connecting/streaming/done/error/canceled/retrying/paused）、10 事件、合法迁移表
- 重试：`maxRetries=1`、仅 `SseStreamDisconnectedError`、默认退避 `min(30s, 1s×2^(attempt-1))` 随机
- 服务端会话：idle abort `10s`（客户端断线未重连即中止 LLM）/ 事件缓存 retain `60s`（可重连回放窗口）
- 长任务口径：`PerformanceObserver('longtask')`，>16ms 视为超帧；"下降 80%"为内部 A/B 基准相对值
- 终态事件集：`done / error / canceled`；简历 `done` 才填 `variants`（未完成结果不落库）

> 背诵顺序建议：Q1/Q2（管线本体）→ Q4/Q6/Q7（预算-EWMA-压力，连成"测量→平滑→评分"一条线）→ Q8/Q9（降级语义 + "SSE 不能降速"这个正本清源点）→ Q15/Q16/Q17（超时-重试-去重，讲成"断开是意外、用游标续传"的故事）→ Q19/Q20（终态收口）→ 数字表。最容易翻车的是两处：把"80%"说成线上统计、把"打字机降速"说成当前装配已接线——前者补口径、后者如实说"钩子就位 + 引擎自动降级为主"，比夸大可信得多。
