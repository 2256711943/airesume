# API_STREAM_SPEC.md

## 1. 目的

定义文案生成 SSE 流式协议，作为前后端实现与联调依据。

## 2. Endpoint

- `GET /copy/generate/stream`

请求参数（query）：

- `productId: string`（必填）
- `platform: string`（如 taobao / douyin）
- `tone: string`（如 direct / emotional）
- `variants: number`（默认 3，最大 5）

Header：

- `Authorization: Bearer <token>`

## 3. 事件定义（轻量版）

1. `chunk`
- 含义：增量文案片段
- data:
  - `requestId: string`
  - `variantIndex: number`
  - `text: string`
  - `timestamp: string`

2. `done`
- 含义：生成完成
- data:
  - `requestId: string`
  - `taskId: string`
  - `variantCount: number`
  - `timestamp: string`

3. `error`
- 含义：生成失败
- data:
  - `requestId: string`
  - `code: string`
  - `message: string`
  - `timestamp: string`

## 4. 协议规则

- 事件顺序：`chunk* -> done` 或 `chunk* -> error`
- `requestId` 全链路一致
- `done` / `error` 之后必须主动关闭连接
- 首版不支持 `Last-Event-ID` 恢复

## 5. 前端处理要求

- 接到 `chunk` 立即增量渲染
- 接到 `done` 切换完成态并触发结果拉取
- 接到 `error` 展示错误提示并允许重试
- 连接异常时展示“连接中断”状态

