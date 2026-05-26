# CODE_STYLE.md

## 1. 通用规范

- 全仓库使用 TypeScript。
- 保持严格类型检查，不关闭关键校验。
- 提交前至少通过 `build`；如可用同时通过 `lint/test`。
- 公共函数必须有明确输入输出类型。

## 2. 命名规范

- 文件：`kebab-case`
- 变量/函数：`camelCase`
- 类型/接口/类：`PascalCase`
- 常量：`UPPER_SNAKE_CASE`

## 3. 前端规范（Nuxt）

- 页面只负责交互与状态编排，复杂逻辑下沉到 `composables`。
- API 调用统一通过 `composables/useApiFetch.ts`。
- SSE 消费逻辑在页面内保持同一套事件处理结构：`start/progress/chunk/done/error/canceled`。

## 4. 后端规范（NestJS）

- 分层：`Controller -> Service`，Controller 不写业务逻辑。
- DTO 必须使用 `class-validator` 进行输入校验。
- 响应统一使用 `ApiResponse` 结构。
- 错误信息应可读且可定位（含错误码与上下文）。

## 5. API 规范

- `docs/OPENAPI.yaml` 为唯一接口契约来源。
- 变更接口先改文档，再改实现。
- SSE 协议以 `docs/API_STREAM_SPEC.md` 为准。

## 6. 测试规范

- 单测命名建议：`should_xxx_when_xxx`。
- 集成测试至少覆盖：认证、简历生成、权限隔离。
- SSE 至少覆盖：正常事件序列、失败事件、取消事件。

## 7. Git 规范

- 分支建议：`feature/*`、`fix/*`、`chore/*`。
- 提交信息采用 Conventional Commits。
- PR 说明至少包含：变更内容、影响范围、验证结果、风险点。

