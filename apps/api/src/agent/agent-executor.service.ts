import { Injectable, Logger } from '@nestjs/common';
import {
  OpenAiAgentClient,
  type AgentToolTraceEntry,
} from '../common/llm/openai-agent.client';
import { ToolRegistry } from '../common/llm/tool-registry';
import { ChatWebToolExecutor } from '../chat/tools/chat-web-tool-executor';
import type { ContextPack } from '../memory/context-pack.types';
import type { MemoryLayer } from '../memory/memory.types';
import { AgentConfig, AgentConfigRegistry } from './agent.config';
import type { OrchestratorDecision } from './orchestrator/orchestrator.service';
import { ToolCallLogService } from './tool-call-log.service';

export interface AgentExecutionInput {
  agentRunId: string;
  conversationId: string;
  messageId: string;
  selectedAgent: string;
  userMessage: string;
  routeDecision: OrchestratorDecision;
  /**
   * ContextPack 单装配点：注入 LLM 的上下文即 pack.summaryBlocks，
   * 保证「预算选出的」与「模型收到的」严格一致。
   */
  contextPack?: ContextPack;
  toolProgress?: {
    onToolStart?: (toolName: string) => void;
    onToolDone?: (result: {
      toolName: string;
      success: boolean;
      latencyMs: number;
      errorCode?: string;
      errorMessage?: string;
    }) => void;
  };
}

export interface AgentExecutionResult {
  assistantText: string;
  toolCalls: Array<{
    toolName: string;
    success: boolean;
    latencyMs?: number;
  }>;
}

/** tool loop 最大轮数，复用 OpenAiAgentClient 默认收敛上限。 */
const DEFAULT_CHAT_AGENT_MAX_STEPS = 5;

/**
 * Agent 执行器：将三个 Specialist Agent 统一接入 LLM tool loop。
 *
 * 每个 Agent 通过 `OpenAiAgentClient.runWithTools` 执行：
 * - Agent 的选择与系统提示词/工具集来自 `AgentConfigRegistry` 的注册配置
 *   （`agent.config.ts`），不再用 switch 硬编码；
 * - 仅向模型暴露配置中的工具（默认 `web_search` / `web_browser` 两个联网工具）；
 * - 工具执行进度通过 `onToolStart` / `onToolDone` 转发为现有 SSE 事件；
 * - 返回结构保持 `{ assistantText, toolCalls }` 不变，上层 ChatService 无需改动。
 */
@Injectable()
export class AgentExecutorService {
  private readonly logger = new Logger(AgentExecutorService.name);

  constructor(
    private readonly agentClient: OpenAiAgentClient,
    private readonly registry: ToolRegistry,
    private readonly webToolExecutor: ChatWebToolExecutor,
    private readonly toolCallLogService: ToolCallLogService,
    private readonly agentConfigRegistry: AgentConfigRegistry,
  ) {}

  async execute(input: AgentExecutionInput): Promise<AgentExecutionResult> {
    if (!input.selectedAgent) {
      throw new Error('Agent selection is required');
    }

    const config = this.agentConfigRegistry.get(input.selectedAgent);
    if (!config) {
      throw new Error(`Unsupported agent: ${input.selectedAgent}`);
    }

    return this.runAgentLoop(input, config);
  }

  private async runAgentLoop(
    input: AgentExecutionInput,
    config: AgentConfig,
  ): Promise<AgentExecutionResult> {
    const result = await this.agentClient.runWithTools({
      instructions: this.buildInstructions(
        config.systemPrompt,
        input.contextPack,
      ),
      input: input.userMessage,
      tools: this.registry.toOpenAiTools({
        strict: this.agentClient.strictSchema,
        names: config.toolNames,
      }),
      execute: (call) => this.webToolExecutor.execute(call),
      maxSteps: DEFAULT_CHAT_AGENT_MAX_STEPS,
      onToolStart: (call) => input.toolProgress?.onToolStart?.(call.name),
      onToolDone: (trace) => {
        this.emitToolDone(input, trace);
        void this.persistToolLog(input, trace);
      },
    });

    return {
      assistantText: result.outputText,
      toolCalls: result.toolTrace.map((trace) => ({
        toolName: trace.name,
        success: this.isToolSuccess(trace),
        latencyMs: trace.latencyMs,
      })),
    };
  }

  private emitToolDone(
    input: AgentExecutionInput,
    trace: AgentToolTraceEntry,
  ): void {
    const success = this.isToolSuccess(trace);
    const result = trace.result as { ok?: boolean; error?: string } | undefined;
    input.toolProgress?.onToolDone?.({
      toolName: trace.name,
      success,
      latencyMs: trace.latencyMs,
      ...(success ? {} : { errorMessage: result?.error }),
    });
  }

  /**
   * 将单步工具调用写入 ToolCallLog，供审计与调试。
   * 独立于 SSE 事件流，异步落库失败仅告警，不中断 agent loop。
   */
  private async persistToolLog(
    input: AgentExecutionInput,
    trace: AgentToolTraceEntry,
  ): Promise<void> {
    const success = this.isToolSuccess(trace);
    try {
      await this.toolCallLogService.createLog({
        agentRunId: input.agentRunId,
        toolName: trace.name,
        inputJson: (trace.arguments ?? null) as never,
        outputJson: (trace.result ?? null) as never,
        success,
        latencyMs: trace.latencyMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      this.logger.warn(
        `tool log persist failed: tool=${trace.name} error=${message}`,
      );
    }
  }

  /** 工具执行结果按 `{ ok, data | error }` 包装判定成功与否。 */
  private isToolSuccess(trace: AgentToolTraceEntry): boolean {
    const result = trace.result as { ok?: boolean } | undefined;
    return result?.ok ?? false;
  }

  /** 组装完整 instructions：Agent system 提示词 + ContextPack 上下文块。 */
  private buildInstructions(systemPrompt: string, pack?: ContextPack): string {
    const prefix = this.buildContextPackPrefix(pack);
    return prefix ? `${systemPrompt}\n\n${prefix}` : systemPrompt;
  }

  /**
   * 将 ContextPack.summaryBlocks 渲染为 instructions 前缀。
   * blocks 由预算裁剪选出，这里只做渲染、不再有独立的记忆选取逻辑，
   * 保证「ContextPack 选出的」与「模型收到的」严格一致。
   */
  private buildContextPackPrefix(pack?: ContextPack): string {
    const blocks = pack?.summaryBlocks ?? [];
    if (blocks.length === 0) {
      return '';
    }

    return blocks
      .map((block) =>
        `## ${this.resolveBlockTitle(block.layer)}\n${block.content}`.trim(),
      )
      .join('\n\n');
  }

  /** 按记忆层映射注入段标题。 */
  private resolveBlockTitle(layer: MemoryLayer): string {
    if (layer === 'resume') {
      return '简历上下文';
    }
    if (layer === 'preference') {
      return '用户偏好与约束';
    }
    if (layer === 'tool_result') {
      return '最近工具结果';
    }
    if (layer === 'session') {
      return '对话历史摘要';
    }
    return '系统上下文';
  }
}
