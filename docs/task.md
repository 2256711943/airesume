# MemorySummarizer 接口任务

## 目标

为 `MemoryStoreFacade` 的 `summarize` TODO 定义稳定的接口边界，先把合并能力抽成可复用模块，后续可同时服务 `session` 和 `preference` 层。

## 背景

- 当前 `MemoryStoreFacade.write()` 已支持 `replace` / `append` / `summarize`
- `replace` 和 `append` 已可直接落地
- `summarize` 仍是 TODO，需要先定接口再实现逻辑

## 设计原则

- Facade 只负责路由，不负责摘要算法
- 摘要器必须可插拔
- 没有 LLM 时必须有确定性 fallback
- 合并后保留 `sourceRefs` 和版本信息

## 接口形状

```ts
export interface MemorySummarizeInput {
  previous: MemoryEntry;
  incoming: MemoryWriteInput;
  now: Date;
}

export interface MemorySummarizeResult {
  content: string;
  summary: string | null;
  tokenEstimate: number;
  sourceRefs: MemorySourceRef[];
  metadata: Record<string, unknown> | null;
  compactionMode: 'pass-through' | 'fallback' | 'llm';
}

export interface MemorySummarizer {
  summarize(input: MemorySummarizeInput): Promise<MemorySummarizeResult>;
}
```

## Facade 职责

- 查找 merge candidate
- 判断 merge strategy
- 调用 `MemorySummarizer`
- 统一写回 runtime / persistent store

## Summarizer 职责

- 合并 `previous` 与 `incoming`
- 生成新 `summary`
- 控制 `content` 膨胀
- 合并 `sourceRefs`
- 标记本次 compaction 模式

## 实施步骤

1. 新增 `MemorySummarizer` 接口
2. 新增默认实现
3. 让 `MemoryStoreFacade` 依赖该接口
4. 为 `summarize` 分支补单测
5. 预留 `preference` 层复用点

## 验收标准

- `summarize` 分支不再是 TODO
- Facade 不直接包含摘要算法
- 输出包含 `summary`、`sourceRefs`、`compactionMode`
- `session` 与 `preference` 可复用同一接口
