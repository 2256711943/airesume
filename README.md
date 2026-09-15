# AI 简历助手（AI Resume Assistant）

一个面向求职场景的全栈 AI 助手项目，以"简历对话式生成"为主线，融合 Agent 工具调用、JD 定制重写、上下文记忆管理与可观测回放能力。

## 1. 项目定位

- 对话式收集求职信息，流式生成结构化简历（SSE）
- 基于 JD 的岗位定制重写与多版本润色，支持评分选择与入库
- 服务端渲染导出高一致性 PDF
- 面向面试展示技术深度的完整全栈工程

## 2. 技术栈

| 层   | 技术                                                             |
| ---- | ---------------------------------------------------------------- |
| 前端 | Nuxt 4 + Vue 3 + TypeScript + Element Plus + markdown-it         |
| 后端 | NestJS 11 + TypeScript + Swagger(OpenAPI)                        |
| 数据 | SQLite（libsql）+ Prisma 7                                       |
| AI   | OpenAI API（兼容 DashScope 兼容模式）                            |
| PDF  | Playwright（服务端渲染）                                         |
| 协议 | HTTP + SSE（流式通道）                                           |
| 测试 | Jest（API）+ Vitest（Web）+ Playwright（E2E）+ GitHub Actions CI |

## 3. 当前能力

### 3.1 基础链路

1. JWT 登录与鉴权（`/auth/login`、`/auth/me`）
2. `POST /resume/generate` 非流式简历生成
3. `GET /resume/generate/stream` SSE 流式简历生成
4. 前端 `/resume` 页面实时渲染生成结果（StreamingMarkdown）

### 3.2 Agent 与 JD 定制

1. OpenAI Function Calling 工具循环：注册 `web_search` / `web_browser` 工具
2. JD 结构化解析（`jd-parser`）：职责、技能、关键词、业务目标
3. JD 低分维度定向重写（`jd-rewriter`）与质量判定（`jd-judge`）
4. 多版本润色（technical / business / hybrid）+ 规则评分 + 用户选择记录（`variant/select`）

### 3.3 上下文与记忆工程

1. 分层会话记忆（session / resume / preference / tool_result / system）
2. 记忆捕获决策链路：候选提取 → 决策 → 摘要 → 合并 → 持久化
3. 跨会话长期记忆（UserMemory）与显示偏好记忆（DisplayPreference）
4. ContextPack 上下文打包：层序分配、token 预算管理、丢弃明细可审计
5. History Summary 降级为可重建的压缩缓存，减少上下文膨胀

### 3.4 可观测性与回放

1. 统一 SSE 事件协议（Envelope + seq / runId / spanId）
2. Span 事件日志持久化（`ObservabilityEventLog`）
3. 诊断规则引擎（context / stream / route / tool 四类规则）
4. 前端运行回放（Replay）：时间线、事件详情、诊断条

### 3.5 PDF 导出

1. Playwright 服务端渲染简历 HTML 为 PDF
2. 浏览器实例并发管理（信号量 + 超时控制）
3. 中文文件名 RFC 5987 Content-Disposition 处理

## 4. 目录结构

```
aitext/
├── apps/
│   ├── api/                 # NestJS 后端
│   │   └── src/
│   │       ├── auth/        # JWT 登录鉴权
│   │       ├── resume/      # 简历生成 / JD 解析重写 / 版本选择 / PDF 导出
│   │       ├── agent/       # Agent 编排与工具调用日志
│   │       ├── chat/        # 对话与 web_search / web_browser 工具
│   │       ├── conversation/# 会话、记忆槽、ContextPack
│   │       ├── memory/      # 记忆捕获决策、长期记忆、上下文预算
│   │       ├── observability/# 事件日志、诊断规则、回放
│   │       ├── streams/     # SSE 会话控制
│   │       └── common/      # LLM 客户端、SSE、请求 ID 中间件
│   └── web/                 # Nuxt 4 前端
│       ├── pages/           # login / index / resume
│       ├── components/chat/ # StreamingMarkdown、可观测面板
│       ├── composables/     # SSE 渲染引擎、生成编排、回放控制
│       └── utils/           # SSE 协议、markdown 流解析、简历渲染设计
├── docs/                    # 设计文档、协议规范、实施计划
├── .github/workflows/ci.yml # CI
└── scripts/                 # git hooks 安装脚本
```

## 5. 快速开始

### 5.1 环境要求

- Node.js 20+
- npm

### 5.2 安装与配置

```bash
# 安装根依赖
npm install

# 安装子包依赖
npm --prefix apps/api install
npm --prefix apps/web install
```

```bash
# 配置环境变量
cp apps/api/.env.example apps/api/.env
# 编辑 apps/api/.env：填入 DASHSCOPE_API_KEY / JWT_SECRET 等
```

### 5.3 启动

```bash
# 后端（默认 3001 端口）
npm --prefix apps/api run start:dev

# 前端（默认 3000 端口）
npm --prefix apps/web run dev
```

### 5.4 测试与校验

```bash
npm run lint        # ESLint
npm run typecheck   # TypeScript 类型检查
npm run test:api    # API 单元测试（Jest）
npm run test:web    # Web 单元测试（Vitest）
npm run test:e2e:web # E2E（Playwright）
npm run build       # 构建
npm run validate    # lint + typecheck + test + build
```

## 6. 文档入口

- 文档索引：[DOC_INDEX.md](./docs/DOC_INDEX.md)
- 接口契约：[OPENAPI.yaml](./docs/OPENAPI.yaml)
- SSE 协议：[API_STREAM_SPEC.md](./docs/API_STREAM_SPEC.md)
- 数据模型：[DB_SCHEMA.md](./docs/DB_SCHEMA.md) / [schema.prisma](./docs/schema.prisma)
- PDF 导出契约：[PDF_EXPORT_API_CONTRACT.md](./docs/PDF_EXPORT_API_CONTRACT.md)
- 流式渲染架构：[SSE_STREAM_RENDER_ARCHITECTURE.md](./docs/Technical%20Architecture/SSE_STREAM_RENDER_ARCHITECTURE.md)
- 简历流架构：[AI_RESUME_STREAM_ARCHITECTURE.md](./docs/Technical%20Architecture/AI_RESUME_STREAM_ARCHITECTURE.md)
- 可观测回放计划：[AGENT_OBSERVABILITY_REPLAY_IMPLEMENTATION_PLAN.md](./docs/OBSERVABILITY_REPLAY/AGENT_OBSERVABILITY_REPLAY_IMPLEMENTATION_PLAN.md)
- 维护指南：[MAINTENANCE_GUIDE.md](./docs/MAINTENANCE_GUIDE.md)

## 7. 下一步规划

1. 岗位定制 AI 工作描述生成器：RAG 召回 + 结构化校验 + 输出纠偏
2. AI 润色 2.0：多目标并发生成 + LLM Judge 自动评分排序
3. 模板系统升级：简历 DSL + 一键导出 PDF（模板版本化）
4. 智能分类检索：行业/岗位/经验混合召回（关键词 + 向量 + 重排）
