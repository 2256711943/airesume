# 维护模块指引文档

## 目录

1. [项目概览](#1-项目概览)
2. [快速上手](#2-快速上手)
3. [后端模块速览](#3-后端模块速览)
4. [前端模块速览](#4-前端模块速览)
5. [SSE 流协议速览](#5-sse-流协议速览)
6. [操作指南](#6-操作指南)
   - [6.1 如何新增一个 API 接口](#61-如何新增一个-api-接口)
   - [6.2 如何新增一个 Tool](#62-如何新增一个-tool)
   - [6.3 如何新增一个 Agent](#63-如何新增一个-agent)
   - [6.4 如何新增一个前端页面](#64-如何新增一个前端页面)
   - [6.5 如何新增一个 SSE 事件类型](#65-如何新增一个-sse-事件类型)
   - [6.6 如何调试 SSE 流](#66-如何调试-sse-流)
7. [常见踩坑](#7-常见踩坑)

---

## 1. 项目概览

AI 简历助手 — 一个简历生成工具，用户输入个人经历和目标岗位，系统调用 LLM 生成结构化简历。

| 层级 | 技术栈 | 入口 |
|------|--------|------|
| 后端 | NestJS + Prisma + SQLite | `apps/api/src/main.ts` |
| 前端 | Nuxt 3 + Vue 3 + Vite | `apps/web/app.vue` |
| 数据库 | SQLite（开发），通过 Prisma 管理 | `apps/api/prisma/schema.prisma` |
| AI | OpenAI API | 配置见 `.env` |

---

## 2. 快速上手

```bash
# 后端
cd apps/api
npm install
cp .env.example .env      # 填写 OPENAI_API_KEY 等
npx prisma generate        # 生成 Prisma Client
npm run start:dev          # 开发模式，默认 http://localhost:3000

# 前端
cd apps/web
npm install
npm run dev                # 默认 http://localhost:3001
```

关键路径：

| 用途 | 路径 |
|------|------|
| 后端入口模块注册 | `apps/api/src/app.module.ts` |
| 数据库 schema | `apps/api/prisma/schema.prisma` |
| AI 配置（模型/超时/prompt） | `docs/AI_SPEC.md` |
| SSE 协议规范 | `docs/API_STREAM_SPEC.md` |
| 前端 composables | `apps/web/composables/` |

---

## 3. 后端模块速览

模块按 NestJS Module 组织，在 `app.module.ts` 中注册。

### 3.1 Auth 模块

- **职责**：JWT 登录与会话管理。
- **关键文件**：`auth.service.ts`（密码校验 + JWT 签发）、`jwt-auth.guard.ts`（路由守卫）、`current-user.decorator.ts`（获取当前用户）。
- **路由**：`POST /auth/login` → 返回 `{ token }`。
- **注意**：当前无注册流程，用户为硬编码。

### 3.2 Prisma 模块

- **职责**：数据库连接管理。
- **关键文件**：`prisma.service.ts`（单例 PrismaClient）、`prisma/schema.prisma`（表定义）。
- **当前表**：`users`。规划中：`resume_tasks`、`resume_versions`。

### 3.3 Resume 模块

核心业务模块，包含多个子服务：

| 文件 | 职责 |
|------|------|
| `resume.controller.ts` | 路由定义：`POST /resume/generate`、`SSE /resume/generate/stream`、`POST /resume/jd/parse`、`POST /resume/jd/judge`、`POST /resume/variant/select` |
| `resume.service.ts` | 生成编排：调用 AI → 评分 → 排序赋分 → 返回 variant 列表 |
| `resume.ai.service.ts` | LLM 调用封装：构建 system/user prompt、发起 chat completion、解析 JSON 输出 |
| `resume-scorer.service.ts` | 对生成结果逐项打分（相关性、完整性等） |
| `resume-context.service.ts` | 简历上下文管理，供 Conversation 模块引用 |
| `resume-learning.service.ts` | 用户偏好学习（基于 variant 选择记录反馈） |
| `jd-parser/jd-parser.service.ts` | JD 文本解析，提取结构化字段 |
| `jd-parser/jd-judge.service.ts` | JD 解析质量评判 |
| `jd-parser/jd-rewriter.service.ts` | JD 重写 |

### 3.4 Conversation 模块

- **职责**：对话会话 CRUD、消息列表、简历上下文联动。
- **路由**：`POST /conversation/create`、`POST /conversation/append`、`POST /conversation/set-resume-context` 等。
- **关键设计**：`resume-context.service.ts` 将当前简历数据注入聊天上下文，让 Agent 知道"用户现在在做什么"。

### 3.5 Chat 模块

- **职责**：聊天消息发送与 SSE 流响应。
- **路由**：`POST /chat/message/stream`（SSE 流式聊天）。
- **关键文件**：`chat.service.ts` — 接收用户消息 → 编排器决策 → Agent 执行 → SSE 推流。

### 3.6 Agent 模块

| 文件 | 职责 |
|------|------|
| `orchestrator/orchestrator.service.ts` | 意图识别 + Agent 路由（基于关键词匹配，无需 LLM） |
| `agent-executor.service.ts` | Agent 执行循环（调用 LLM → 执行 Tool → 继续/结束） |
| `agent-run.service.ts` | Run 生命周期管理（创建 run、生成 seq） |
| `tool-call-log.service.ts` | Tool 调用日志记录 |

**支持意图**：`resume_diagnosis` / `interview_guidance` / `career_planning` / `general_resume_followup`。

### 3.7 Tool 模块

- **职责**：工具注册与统一执行入口。
- **关键文件**：`tool-registry.service.ts`（统一 `execute` 方法，带超时/日志/错误收敛）、`tool.types.ts`（ToolName 等类型定义）。
- **当前工具**：`jd_parse_and_score`（JD 解析 + 评分）。

### 3.8 Streams 模块

- **职责**：SSE 流控制（暂停/恢复/取消）。
- **关键文件**：`streams-control.service.ts` — 通过 `streamKey` 控制流的运行时行为。
- **路由**：`POST /streams/control`。

### 3.9 Common 模块

| 文件 | 职责 |
|------|------|
| `sse.ts` | SSE 信封统一格式 `SseEventEnvelope` + `SseEnvelopeFactory` |
| `sse-session.ts` | `ReplayableSseSession` — 可回放 SSE 会话，支持断线恢复 |
| `llm-sanitizer.util.ts` | LLM 输出清洗（JSON 修复等） |
| `api-response.ts` | 统一响应格式 `ApiResponse<T>` |
| `request-id.middleware.ts` | 请求 ID 链路追踪 |

---

## 4. 前端模块速览

### 4.1 页面路由

| 路由 | 文件 | 说明 |
|------|------|------|
| `/` | `pages/index.vue` | 首页 |
| `/login` | `pages/login.vue` | 登录页 |
| `/resume` | `pages/resume.vue` | 主页面：简历表单 + 生成结果 + 聊天面板 |

### 4.2 Composables

| 文件 | 职责 |
|------|------|
| `useAuth.ts` | 登录态管理、token 存储、401 自动登出 |
| `useResumeGeneration.ts` | 简历生成逻辑（同步 + SSE 流）、variant 管理、取消/重试 |
| `useResumeConversation.ts` | 聊天对话 + 简历上下文联动、消息发送、span 追踪 |
| `useSseMachine.ts` | SSE 连接状态机：`idle → connecting → streaming → done/error/canceled` |
| `useSseRenderEngine.ts` | SSE 事件 → 前端分帧渲染管线（`Ingress → FrameBuffer → Commit`） |
| `useSseSupervisor.ts` | SSE 连接监督器，带指数退避重连 |
| `useSpanStore.ts` | Span 树状数据管理（`SpanTreeNode`），驱动时间线组件 |
| `useApiFetch.ts` | 封装 `$fetch`，自动附加 Authorization header |

### 4.3 组件

| 文件 | 职责 |
|------|------|
| `components/chat/AgentTraceCard.vue` | Agent 执行追踪卡片 |
| `components/chat/SpanTimelineCard.vue` | Span 时间线展示 |

---

## 5. SSE 流协议速览

所有 SSE 消息统一使用信封格式：

```typescript
interface SseEventEnvelope {
  id: string;       // "{runId}:{seq}"
  seq: number;      // 单调递增序号
  runId: string;    // 一次 Agent 执行 ID
  spanId?: string;  // 当前片段 ID
  type: string;     // 事件类型
  ts: string;       // ISO 8601
  payload: object;  // 具体数据
}
```

两套 SSE 流：

| 流 | 路由 | 事件类型 |
|----|------|----------|
| 聊天流 | `POST /chat/message/stream` | `start` → `route_decision` → `tool_start` → `tool_done` → `assistant_chunk` → `assistant_done` → `done` / `error` |
| 简历生成流 | `GET /resume/generate/stream` | `start` → `chunk` → `progress` → `done` / `error` / `canceled` |

断线恢复通过 `streamKey` + `sinceSeq` 实现，服务端由 `ReplayableSseSession` 缓存事件。

---

## 6. 操作指南

### 6.1 如何新增一个 API 接口

以新增一个 `POST /resume/analyze` 为例。

**步骤 1：定义 DTO**

```typescript
// apps/api/src/resume/dto/analyze-resume.dto.ts
export class AnalyzeResumeDto {
  @IsString()
  resumeText: string;
}
```

**步骤 2：在 Service 中实现逻辑**

```typescript
// apps/api/src/resume/resume.service.ts
async analyze(dto: AnalyzeResumeDto): Promise<AnalyzeResult> {
  // 业务逻辑
}
```

**步骤 3：在 Controller 中注册路由**

```typescript
// apps/api/src/resume/resume.controller.ts
@Post('analyze')
@ApiOperation({ summary: 'Analyze resume text' })
async analyze(
  @Body() dto: AnalyzeResumeDto,
  @Req() req: RequestWithId,
): Promise<ApiResponse<AnalyzeResult>> {
  return ok(req.requestId ?? 'unknown', await this.resumeService.analyze(dto));
}
```

**步骤 4：如果接口需要认证**

确保 Controller 上有 `@UseGuards(JwtAuthGuard)` 装饰器（已在 ResumeController 类级别添加，新增路由自动继承）。

**步骤 5：添加 Swagger 响应装饰**

```typescript
@ApiSuccessResponse(AnalyzeResponseDto)
```

**步骤 6：前端调用**

使用 `useApiFetch`：

```typescript
const { data } = await useApiFetch('/resume/analyze', {
  method: 'POST',
  body: { resumeText: '...' },
});
```

---

### 6.2 如何新增一个 Tool

以新增一个 `skill_analyzer` 工具为例。

**步骤 1：在 `tool.types.ts` 中注册类型**

```typescript
export type ToolName = 'jd_parse_and_score' | 'skill_analyzer';  // ← 新增

export interface SkillAnalyzerInput {
  skillText: string;
}

export interface SkillAnalyzerOutput {
  skills: string[];
  gaps: string[];
}
```

**步骤 2：在 `tool-registry.service.ts` 中实现执行逻辑**

```typescript
// executeInternal 方法中新增 case
case 'skill_analyzer':
  return this.withTimeout(
    this.performSkillAnalyzer(input as SkillAnalyzerInput),
    timeoutMs,
  );

// 新增私有方法
private async performSkillAnalyzer(
  input: SkillAnalyzerInput,
): Promise<SkillAnalyzerOutput> {
  // 调用 LLM 或已有 service
}
```

**步骤 3：更新类型映射**

`execute` 方法的条件类型需要同步更新：

```typescript
async execute<TName extends ToolName>(
  toolName: TName,
  input: TName extends 'jd_parse_and_score'
    ? JdParseAndScoreToolInput
    : TName extends 'skill_analyzer'
      ? SkillAnalyzerInput    // ← 新增分支
      : never,
  ...
```

**步骤 4：注册依赖**

如果新 Tool 依赖其他 Service，在 `ToolRegistryService` 的 constructor 中注入。

**步骤 5：Agent 中使用**

在 `agent-executor.service.ts` 的 tool 执行逻辑中，通过 `toolRegistryService.execute('skill_analyzer', input)` 调用。

---

### 6.3 如何新增一个 Agent

以新增一个 `salaryNegotiatorAgent` 为例。

**步骤 1：定义意图**

在 `orchestrator.service.ts` 中新增 `ChatIntent` 类型：

```typescript
export type ChatIntent =
  | 'resume_diagnosis'
  | 'interview_guidance'
  | 'career_planning'
  | 'general_resume_followup'
  | 'salary_negotiation';  // ← 新增
```

**步骤 2：添加路由规则**

在 `OrchestratorService.decideNextAgent()` 中新增关键词匹配分支：

```typescript
const salaryMatch = this.collectMatches(normalized, ['薪资', '谈薪', 'offer', '谈判']);
if (salaryMatch.length > 0) {
  return this.buildDecision({
    intent: 'salary_negotiation',
    selectedAgent: 'salaryNegotiatorAgent',
    reason: '命中薪资谈判关键词',
    confidence: 0.92,
    matchedRules: [{ ruleId: 'salary_keywords', label: '薪资谈判关键词', matchedKeywords: salaryMatch }],
  });
}
```

**步骤 3（可选）：实现专用 Agent Service**

如果 Agent 需要独立执行逻辑，新建一个 Service 并在 AgentExecutor 中路由；如果只是 prompt 差异，直接在 `agent-executor.service.ts` 的 system prompt 构造中区分即可。

**步骤 4：Agent 不需要单独注册到模块**

Agent 逻辑收敛在 `agent-executor.service.ts` 中，不涉及 Module 注册。

---

### 6.4 如何新增一个前端页面

以新增一个 `history.vue` 历史记录页面为例。

**步骤 1：创建页面文件**

```vue
<!-- apps/web/pages/history.vue -->
<script setup lang="ts">
definePageMeta({ middleware: 'auth' });  // 若有全局守卫则自动生效
</script>

<template>
  <div>
    <h1>历史记录</h1>
  </div>
</template>
```

Nuxt 3 自动根据 `pages/` 目录生成路由，`/history` 自动映射到 `pages/history.vue`。

**步骤 2：添加导航入口**

在 `app.vue` 或当前布局中添加链接。

**步骤 3：如果需要新 composable**

在 `composables/` 下新建 `useResumeHistory.ts`，使用 `useApiFetch` 调用后端接口。

---

### 6.5 如何新增一个 SSE 事件类型

以在简历生成流中新增 `quality_hint` 事件为例。

**步骤 1：在 Service 端新增事件类型到联合类型**

```typescript
// resume.service.ts
export type ResumeSseEventType =
  | 'start' | 'chunk' | 'progress' | 'done' | 'error' | 'canceled'
  | 'quality_hint';  // ← 新增
```

**步骤 2：发送事件**

```typescript
// 使用 ReplayableSseSession 的 emit 方法
session.emit('quality_hint', { message: '简历技能部分与岗位匹配度较高' });
```

**步骤 3：前端消费**

在 `useResumeGeneration.ts` 的事件分发中添加新类型处理：

```typescript
if (envelope.type === 'quality_hint') {
  qualityHints.value.push(envelope.payload.message);
}
```

**步骤 4（可选）：在 Span Store 中注册**

如果需要该事件出现在时间线上，在 `useSpanStore.ts` 的 `ingestEnvelope` 中根据 `type` 映射到对应 span。

---

### 6.6 如何调试 SSE 流

**方法 1：浏览器 DevTools**

打开 Chrome DevTools → Network 面板 → 找到 SSE 请求 → 点击 **EventStream** 标签，可以实时看到每条事件的 `type`、`id`、`data`。

**方法 2：curl 测试**

```bash
curl -N -H "Authorization: Bearer <token>" \
  "http://localhost:3000/resume/generate/stream?profile=...&targetJob=..."
```

**方法 3：后端日志**

SSE 事件通过 `ReplayableSseSession.emit()` 发送。如果怀疑事件未发出，可以在 `sse-session.ts` 的 `emit` 方法上加日志。

**方法 4：前端状态机观察**

`useSseMachine` 暴露了 `state` 和 `onStateChange`。可以在组件中监听状态变化：

```typescript
const supervisor = new SseSupervisor({
  onStateChange: (from, to) => console.log('SSE:', from.value, '→', to.value),
});
```

**方法 5：断线恢复验证**

- 用 `streamKey` + `sinceSeq` 构造断线恢复请求。
- 检查服务端 `ReplayableSseSession` 中缓存的事件是否包含 `sinceSeq` 之后的所有事件。
- 前端检查 `useSseRenderEngine` 的 `seq` 去重逻辑。

---

## 7. 常见踩坑

### 7.1 LLM JSON 解析失败

- **现象**：`POST /resume/generate` 返回 500，日志提示 JSON 解析异常。
- **原因**：LLM 输出结构不严格符合 schema。
- **排查**：检查 `resume.ai.service.ts` 中的 `generate` 方法，它有一次"格式修复重试"逻辑。如果依然失败，检查 prompt 中的 JSON schema 定义和 `llm-sanitizer.util.ts` 的清洗逻辑。
- **建议**：增大 `max_retries` 或降低 `temperature`。

### 7.2 SSE 流卡在 connecting

- **现象**：前端状态机一直处于 `connecting`，不进入 `streaming`。
- **排查**：
  1. 检查网络请求是否到达后端（看 Network 面板）。
  2. 检查后端是否发送了 `start` 事件。
  3. 检查 `useSseMachine` 中 `consumeResponse` 是否正确读取 `ReadableStream`。
- **常见原因**：后端抛异常未 catch，导致 `Observable` 直接 error 而非发送 `error` 事件。

### 7.3 SSE 前端不渲染

- **现象**：Network 面板看到事件在传输，但 UI 不更新。
- **排查**：
  1. 检查 `useSseRenderEngine` 的帧循环是否在运行（`requestAnimationFrame` 是否被暂停）。
  2. 检查 `seq` 去重逻辑是否误判导致事件被丢弃。
  3. 检查渲染管线的 `phase` 优先级——`bulk` / `decorative` 阶段可能被延后。

### 7.4 聊天上下文丢失

- **现象**：Agent 回复似乎不记得之前的对话。
- **排查**：
  1. 检查 `conversation.service.ts` 中 `historyLimit` 参数是否过小。
  2. 检查 `resume-context.service.ts` 的上下文拼接是否正确。
  3. 检查前端 `useResumeConversation.ts` 中的 `getVariantSnapshot` 是否在生成新简历后及时更新。

### 7.5 Orchestrator 路由不准

- **现象**：用户问"这个岗位薪资怎么样"被路由到了"面试指导"而非"职业规划"。
- **排查**：检查 `orchestrator.service.ts` 中的关键词列表和匹配优先级。关键词匹配是顺序优先的，第一个命中的规则会被选中。

### 7.6 断线恢复后数据重复

- **现象**：重连后看到重复的聊天消息或简历片段。
- **排查**：
  1. 检查客户端的 `sinceSeq` 是否传对了（应为最后消费的 `seq`）。
  2. 检查服务端 `ReplayableSseSession` 的缓存是否在断线后被清空（`retainMs` 默认 60s，超时后缓存释放）。
  3. 检查前端 `useSseRenderEngine` 的 `seq` 去重是否覆盖了全部事件类型。

### 7.7 前端 npm run dev 报错

- **现象**：启动报模块找不到或版本冲突。
- **排查**：
  1. 确认 Node.js 版本 >= 18。
  2. 删除 `node_modules` 和 `package-lock.json`，重新 `npm install`。
  3. 检查 Nuxt 3 的版本兼容性，目前项目使用稳定版本。

### 7.8 401 频繁弹窗

- **现象**：操作过程中突然跳转登录页。
- **排查**：
  1. 检查 `useAuth.ts` 中 token 过期判断逻辑。
  2. 检查 `auth.global.ts` 中导航守卫的跳转条件。
  3. 检查后端 `JwtAuthGuard` 是否对所有路由都生效了（某些路由可能意外缺少 `@UseGuards`）。

---

> 本文档随项目演进持续更新。如有新增模块或流程变更，请及时同步更新对应章节。
