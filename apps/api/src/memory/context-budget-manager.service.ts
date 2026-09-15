import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  ContextPack,
  ContextPackBlockType,
  ContextPackDropReason,
  ContextPackDroppedMemory,
  ContextPackSummaryBlock,
  ContextPackUsage,
} from './context-pack.types';
import { ContextPackStore, MemoryStore } from './memory.store';
import type { MemoryEntry, MemoryLayer } from './memory.types';

/**
 * 默认的上下文预算分层顺序（按优先级从高到低）。
 * 构建上下文包时，将按此顺序依次从各层挑选记忆。
 */
export const DEFAULT_CONTEXT_BUDGET_LAYER_ORDER = [
  'resume',
  'preference',
  'tool_result',
  'session',
] as const satisfies MemoryLayer[];

/** 单个记忆层的预算限制：最大条目数与最大 token 数。 */
export interface ContextBudgetLayerLimit {
  /** 该层最多选入上下文的记忆条目数 */
  maxItems: number;
  /** 该层最多消耗的 token 数 */
  maxTokens: number;
}

/** 构建上下文包的输入参数。 */
export interface BuildContextPackInput {
  /** 会话 ID，用于从 MemoryStore 中读取该会话的记忆 */
  conversationId: string;
  /** 关联的运行 ID（可选） */
  runId?: string | null;
  /** 当前意图/任务描述（可选） */
  intent?: string | null;
  /** 上下文包允许的最大 token 数 */
  maxTokens: number;
  /** 预留 token 数，用于给最终 Prompt 的系统指令等留出空间 */
  reservedTokens?: number;
  /** 需要纳入的层（缺省时使用全部默认层） */
  layers?: MemoryLayer[];
  /** 层的优先级顺序（缺省时使用默认顺序） */
  layerOrder?: MemoryLayer[];
  /** 按层覆盖默认的预算限制 */
  layerLimits?: Partial<Record<MemoryLayer, Partial<ContextBudgetLayerLimit>>>;
  /**
   * 预先收集的记忆候选（ContextPack 单装配点模式）。
   * 提供时跳过内部 MemoryStore 查询，直接在候选上做预算裁剪，
   * 保证「选出的即注入的」：summaryBlocks 就是最终进入 LLM 的内容。
   */
  candidates?: MemoryEntry[];
}

/** 各记忆层的默认预算限制。 */
const DEFAULT_LAYER_LIMITS: Record<MemoryLayer, ContextBudgetLayerLimit> = {
  system: {
    maxItems: 1,
    maxTokens: 400,
  },
  resume: {
    maxItems: 3,
    maxTokens: 1_600,
  },
  preference: {
    maxItems: 4,
    maxTokens: 400,
  },
  tool_result: {
    maxItems: 3,
    maxTokens: 1_200,
  },
  session: {
    maxItems: 2,
    maxTokens: 800,
  },
  // candidate 层是观察期暂存区，默认不注入上下文，故预算为 0。
  candidate: {
    maxItems: 0,
    maxTokens: 0,
  },
};

/**
 * 上下文预算管理器：在给定 token/条目预算内，从各层挑选最有价值的记忆，
 * 生成可供 LLM 使用的上下文包（ContextPack）。
 */
@Injectable()
export class ContextBudgetManagerService {
  constructor(
    private readonly memoryStore: MemoryStore,
    private readonly contextPackStore: ContextPackStore,
  ) {}

  /**
   * 构建一个上下文包。
   * 流程：解析层顺序 → 计算可用 token → 读取记忆 → 按层挑选（受层/包预算约束）
   * → 生成摘要块与使用统计。
   */
  async buildContextPack(input: BuildContextPackInput): Promise<ContextPack> {
    const packId = this.createPackId();
    const resolvedLayerOrder = this.resolveLayerOrder(input);
    // 扣除预留 token 后的实际可用 token 数（最低为 0）
    const availableTokens = Math.max(
      0,
      input.maxTokens - (input.reservedTokens ?? 0),
    );
    // 单装配点模式：优先使用调用方收集的候选（统一过滤过期），否则回退到内部查询
    const now = new Date();
    const memories = input.candidates
      ? input.candidates.filter(
          (memory) => !memory.expiresAt || memory.expiresAt > now,
        )
      : await this.memoryStore.list({
          conversationId: input.conversationId,
          layers: resolvedLayerOrder,
          includeExpired: false,
        });
    // 按层分组，组内按优先级排序
    const memoriesByLayer = this.groupMemoriesByLayer(memories);
    // 记录每层最终选中的记忆
    const selectedByLayer = new Map<MemoryLayer, MemoryEntry[]>();
    // 记录因超出预算而被丢弃的记忆及原因
    const droppedMemories: ContextPackDroppedMemory[] = [];
    let usedTokens = 0;

    // 按优先级从高到低逐层挑选
    for (const layer of resolvedLayerOrder) {
      const layerMemories = memoriesByLayer.get(layer) ?? [];
      const layerLimits = this.resolveLayerLimits(layer, input.layerLimits);
      let layerSelectedCount = 0;
      let layerUsedTokens = 0;
      const selectedForLayer: MemoryEntry[] = [];

      for (const memory of layerMemories) {
        const tokenEstimate = this.resolveTokenEstimate(memory);
        // 超出条目数、层 token、包 token 三者任一预算即丢弃
        const wouldExceedLayerItems =
          layerSelectedCount >= layerLimits.maxItems;
        const wouldExceedLayerTokens =
          layerUsedTokens + tokenEstimate > layerLimits.maxTokens;
        const wouldExceedPackTokens =
          usedTokens + tokenEstimate > availableTokens;

        if (wouldExceedLayerItems) {
          droppedMemories.push(
            this.toDroppedMemory(memory, tokenEstimate, 'layer_item_limit'),
          );
          continue;
        }

        if (wouldExceedLayerTokens) {
          droppedMemories.push(
            this.toDroppedMemory(memory, tokenEstimate, 'layer_token_limit'),
          );
          continue;
        }

        if (wouldExceedPackTokens) {
          droppedMemories.push(
            this.toDroppedMemory(memory, tokenEstimate, 'pack_token_limit'),
          );
          continue;
        }

        selectedForLayer.push(memory);
        layerSelectedCount += 1;
        layerUsedTokens += tokenEstimate;
        usedTokens += tokenEstimate;
      }

      if (selectedForLayer.length > 0) {
        selectedByLayer.set(layer, selectedForLayer);
      }
    }

    // 按层顺序展平选中的记忆，得到最终选取列表
    const selectedMemories = resolvedLayerOrder.flatMap(
      (layer) => selectedByLayer.get(layer) ?? [],
    );
    // 生成 Prompt 摘要块
    const summaryBlocks = this.buildSummaryBlocks(
      packId,
      resolvedLayerOrder,
      selectedByLayer,
      droppedMemories,
    );
    // 统计使用情况：可用/预留/已用/被丢弃的 token
    const usage: ContextPackUsage = {
      maxTokens: input.maxTokens,
      reservedTokens: Math.max(0, input.reservedTokens ?? 0),
      usedTokens,
      droppedTokens: droppedMemories.reduce(
        (sum, memory) => sum + memory.tokenEstimate,
        0,
      ),
    };

    const pack: ContextPack = {
      packId,
      conversationId: input.conversationId,
      runId: input.runId ?? null,
      intent: input.intent ?? null,
      maxTokens: input.maxTokens,
      layerOrder: resolvedLayerOrder,
      selectedMemoryIds: selectedMemories.map((memory) => memory.memoryId),
      droppedMemoryIds: droppedMemories.map((memory) => memory.memoryId),
      droppedMemories,
      summaryBlocks,
      finalPromptPreview: this.buildFinalPromptPreview(summaryBlocks),
      usage,
      metadata: {
        availableTokens,
        selectedCount: selectedMemories.length,
        droppedCount: droppedMemories.length,
        // 单装配点模式标记：summaryBlocks 即最终注入 LLM 的内容
        injectedIntoPrompt: input.candidates !== undefined,
      },
      generatedAt: new Date(),
    };

    return this.contextPackStore.save(pack);
  }

  /**
   * 解析最终的层顺序：
   * - 优先使用调用方指定的 layerOrder；
   * - 只保留 layers 中声明的层，未出现在顺序里的层按声明顺序补在末尾。
   */
  private resolveLayerOrder(input: BuildContextPackInput): MemoryLayer[] {
    const requestedLayers =
      input.layers && input.layers.length > 0
        ? input.layers
        : [...DEFAULT_CONTEXT_BUDGET_LAYER_ORDER];
    const preferredOrder =
      input.layerOrder && input.layerOrder.length > 0
        ? input.layerOrder
        : [...DEFAULT_CONTEXT_BUDGET_LAYER_ORDER];
    const requestedLayerSet = new Set(requestedLayers);
    // 先按 preferredOrder 过滤出声明过的层
    const orderedLayers = preferredOrder.filter((layer) =>
      requestedLayerSet.has(layer),
    );

    // 补上未出现在 preferredOrder 中的层
    for (const layer of requestedLayers) {
      if (!orderedLayers.includes(layer)) {
        orderedLayers.push(layer);
      }
    }

    return orderedLayers;
  }

  /**
   * 解析某层的预算限制：优先使用调用方覆盖值，否则取默认值；
   * 非法（非有限或非正）值回退到默认值。
   */
  private resolveLayerLimits(
    layer: MemoryLayer,
    overrides?: Partial<Record<MemoryLayer, Partial<ContextBudgetLayerLimit>>>,
  ): ContextBudgetLayerLimit {
    const defaults = DEFAULT_LAYER_LIMITS[layer];
    const next = overrides?.[layer];

    return {
      maxItems: this.normalizePositiveInt(next?.maxItems, defaults.maxItems),
      maxTokens: this.normalizePositiveInt(next?.maxTokens, defaults.maxTokens),
    };
  }

  /** 将数值规范化为正整数；无效时回退到 fallback。 */
  private normalizePositiveInt(
    value: number | undefined,
    fallback: number,
  ): number {
    if (!Number.isFinite(value) || (value ?? 0) <= 0) {
      return fallback;
    }

    return Math.floor(value as number);
  }

  /**
   * 将记忆按层分组，组内按 compareMemories 的优先级排序。
   */
  private groupMemoriesByLayer(
    memories: MemoryEntry[],
  ): Map<MemoryLayer, MemoryEntry[]> {
    const grouped = new Map<MemoryLayer, MemoryEntry[]>();

    for (const memory of [...memories].sort((left, right) =>
      this.compareMemories(left, right),
    )) {
      const list = grouped.get(memory.layer) ?? [];
      list.push(memory);
      grouped.set(memory.layer, list);
    }

    return grouped;
  }

  /**
   * 记忆排序比较器，优先级从高到低：
   * 置顶(pinned) > 优先级(priority) > 相关性(relevanceScore)
   * > 新鲜度(freshnessScore) > 更新时间 > 创建时间 > memoryId。
   */
  private compareMemories(left: MemoryEntry, right: MemoryEntry): number {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }
    if (left.priority !== right.priority) {
      return right.priority - left.priority;
    }
    if (left.relevanceScore !== right.relevanceScore) {
      return right.relevanceScore - left.relevanceScore;
    }
    if (left.freshnessScore !== right.freshnessScore) {
      return right.freshnessScore - left.freshnessScore;
    }

    const updatedAtDiff = right.updatedAt.getTime() - left.updatedAt.getTime();
    if (updatedAtDiff !== 0) {
      return updatedAtDiff;
    }

    const createdAtDiff = right.createdAt.getTime() - left.createdAt.getTime();
    if (createdAtDiff !== 0) {
      return createdAtDiff;
    }

    return left.memoryId.localeCompare(right.memoryId);
  }

  /**
   * 估算单条记忆的 token 数：优先使用已记录的 tokenEstimate，
   * 否则按摘要/内容的字符数粗略估算（每 4 字符约 1 token）。
   */
  private resolveTokenEstimate(memory: MemoryEntry): number {
    if (Number.isFinite(memory.tokenEstimate) && memory.tokenEstimate > 0) {
      return Math.floor(memory.tokenEstimate);
    }

    const source = memory.summary?.trim() || memory.content.trim();
    if (!source) {
      return 1;
    }

    return Math.max(1, Math.ceil(source.length / 4));
  }

  /**
   * 构建摘要块：按层顺序为每层生成一个 Prompt 片段，
   * 包含标题、内容、涉及的记忆 ID 与 token 估算。
   */
  private buildSummaryBlocks(
    packId: string,
    layerOrder: MemoryLayer[],
    selectedByLayer: Map<MemoryLayer, MemoryEntry[]>,
    droppedMemories: ContextPackDroppedMemory[],
  ): ContextPackSummaryBlock[] {
    const blocks: ContextPackSummaryBlock[] = [];
    let blockIndex = 0;

    for (const layer of layerOrder) {
      const memories = selectedByLayer.get(layer) ?? [];
      if (memories.length === 0) {
        continue;
      }

      blockIndex += 1;
      blocks.push({
        blockId: `${packId}:block:${blockIndex}`,
        type: this.resolveBlockType(layer),
        layer,
        position: blockIndex,
        title: this.buildBlockTitle(layer),
        content: this.buildBlockContent(memories),
        memoryIds: memories.map((memory) => memory.memoryId),
        tokenEstimate: memories.reduce(
          (sum, memory) => sum + this.resolveTokenEstimate(memory),
          0,
        ),
        truncated: droppedMemories.some((memory) => memory.layer === layer),
        metadata: {
          memoryCount: memories.length,
        },
      });
    }

    return blocks;
  }

  /** 根据层类型决定摘要块的 Prompt 片段类型。 */
  private resolveBlockType(layer: MemoryLayer): ContextPackBlockType {
    if (layer === 'session') {
      return 'summary';
    }
    if (layer === 'tool_result') {
      return 'tool_result';
    }
    if (layer === 'preference' || layer === 'system') {
      return 'system_instruction';
    }

    return 'memory';
  }

  /** 根据层类型生成摘要块标题。 */
  private buildBlockTitle(layer: MemoryLayer): string {
    if (layer === 'resume') {
      return 'Resume Context';
    }
    if (layer === 'preference') {
      return 'Display Preferences';
    }
    if (layer === 'tool_result') {
      return 'Recent Tool Results';
    }
    if (layer === 'session') {
      return 'Conversation Summary';
    }
    return 'System Context';
  }

  /** 将多条记忆渲染为摘要块正文（每行一条）。 */
  private buildBlockContent(memories: MemoryEntry[]): string {
    return memories
      .map((memory) => this.renderMemorySnippet(memory))
      .filter(Boolean)
      .join('\n');
  }

  /** 渲染单条记忆为一行摘要（优先使用 summary，否则取 content）。 */
  private renderMemorySnippet(memory: MemoryEntry): string {
    const label = memory.summary?.trim() || memory.content.trim();
    if (!label) {
      return '';
    }

    return `- ${label}`;
  }

  /** 将摘要块拼接为最终 Prompt 的预览文本。 */
  private buildFinalPromptPreview(
    summaryBlocks: ContextPackSummaryBlock[],
  ): string {
    return summaryBlocks
      .map((block) => `## ${block.title}\n${block.content}`.trim())
      .join('\n\n');
  }

  /** 生成上下文包唯一 ID。 */
  private createPackId(): string {
    return `pack_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  }

  private toDroppedMemory(
    memory: MemoryEntry,
    tokenEstimate: number,
    reason: ContextPackDropReason,
  ): ContextPackDroppedMemory {
    return {
      memoryId: memory.memoryId,
      layer: memory.layer,
      reason,
      tokenEstimate,
      priority: memory.priority,
      pinned: memory.pinned,
      summary: memory.summary?.trim() || memory.content.trim() || null,
    };
  }
}
