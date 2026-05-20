# CODE_STYLE.md

## 1. 通用规范

- 全仓库使用 TypeScript。
- 开启 strict mode，不允许关闭关键类型检查。
- 提交前必须通过 lint + test。
- 任何公共函数必须有明确输入输出类型。

## 2. 命名规范

- 文件：`kebab-case`
- 变量/函数：`camelCase`
- 类型/类/接口：`PascalCase`
- 常量：`UPPER_SNAKE_CASE`
- 布尔变量：`is/has/should/can` 前缀

## 3. 前端规范（Nuxt）

- 组件按“展示组件 / 容器组件”职责划分。
- 页面级状态优先用 Pinia + local state。
- 不在组件中直接写复杂业务逻辑，逻辑下沉到 composables/services。
- SSE 连接统一封装在 `composables/use-sse-client`，禁止散落实现。

## 4. 后端规范（NestJS）

- 分层：Controller -> Service -> Repository。
- Controller 不写业务逻辑，仅做参数接收和响应返回。
- DTO 必须使用 class-validator 做输入校验。
- 错误统一抛业务异常，映射统一错误码。

## 5. API 规范

- 以 `OPENAPI.yaml` 为唯一契约。
- 变更接口前先改契约，再改实现。
- 响应结构统一：
  - `success: boolean`
  - `data: T | null`
  - `error: { code: string; message: string } | null`
  - `requestId: string`

## 6. 日志规范

- 必带字段：`timestamp`, `level`, `requestId`, `userId`, `path`, `latencyMs`, `errorCode`
- 不打印密钥、token、隐私原文。
- SSE 记录连接建立、断开、错误事件。

## 7. 测试规范

- 单测命名：`should_xxx_when_xxx`
- 集成测试覆盖：认证、商品录入、生成、评分、改写、采纳
- SSE 至少覆盖：事件顺序、异常中断、done 收敛

## 8. Git 规范

- 分支：`feature/*` `fix/*` `chore/*`
- 提交信息：Conventional Commits（如 `feat: add sse copy generation endpoint`）
- 每个 PR 需附：变更摘要、接口变更、测试结果、风险点
