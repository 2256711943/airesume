import { Injectable } from '@nestjs/common';
import {
  OpenAiAgentClient,
  type AgentToolTraceEntry,
} from '../common/llm/openai-agent.client';
import { ToolRegistry } from '../common/llm/tool-registry';
import { ChatWebToolExecutor } from '../chat/tools/chat-web-tool-executor';
import {
  WEB_SEARCH_TOOL_NAME,
  WEB_BROWSER_TOOL_NAME,
} from '../chat/tools/web-tools.schema';
import type { OrchestratorDecision } from './orchestrator/orchestrator.service';
import type {
  DisplayPreferenceContextItem,
  ResumeConversationContext,
} from '../resume/resume-context.service';

export interface AgentExecutionInput {
  agentRunId: string;
  conversationId: string;
  messageId: string;
  selectedAgent: string;
  userMessage: string;
  routeDecision: OrchestratorDecision;
  resumeContext?: ResumeConversationContext;
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

/** Chat Agent 只向模型暴露的联网工具集（jd 等业务工具不暴露）。 */
const CHAT_WEB_TOOL_NAMES = [WEB_SEARCH_TOOL_NAME, WEB_BROWSER_TOOL_NAME];
/** tool loop 最大轮数，复用 OpenAiAgentClient 默认收敛上限。 */
const DEFAULT_CHAT_AGENT_MAX_STEPS = 5;

const RESUME_DIAGNOSIS_SYSTEM_PROMPT = `你是一个简历诊断助手，帮助用户分析岗位描述（JD）与简历的匹配度，并给出优化建议。
职责：
- 解析用户提供的岗位描述，提炼硬性要求、技能要求与潜在风险点；
- 结合用户简历上下文给出针对性修改建议；
- 当需要最新行业信息或岗位相关外部事实时，可以使用 web_search / web_browser 工具获取佐证。
注意：当前联网工具为 Mock 实现，搜索结果不可作为真实依据，引用时需说明来源不确定。`;

const INTERVIEW_COACH_SYSTEM_PROMPT = `你是一个面试指导助手，帮助用户准备面试问答、梳理表达框架并模拟追问。
职责：
- 判断提问类型（自我介绍、行为题、技术题、职业决策题等），给出结构化回答策略；
- 结合用户简历上下文，把回答落到具体经历与成果；
- 当需要最新面试动态或行业技术信息时，可以使用 web_search / web_browser 工具获取参考。
注意：当前联网工具为 Mock 实现，搜索结果不可作为真实依据。`;

const CAREER_PLANNER_SYSTEM_PROMPT = `你是一个职业规划助手，帮助用户梳理转型方向、能力缺口与分阶段行动计划。
职责：
- 判断用户的职业阶段（入行、成长、转型、晋升等），给出可执行的规划；
- 结合用户简历上下文，识别当前能力与目标岗位的差距；
- 当需要了解目标岗位的市场要求、行业趋势时，可以使用 web_search / web_browser 工具获取参考。
注意：当前联网工具为 Mock 实现，搜索结果不可作为真实依据。`;

/**
 * Agent 执行器：将三个 Specialist Agent 统一接入 LLM tool loop。
 *
 * 每个 Agent 通过 `OpenAiAgentClient.runWithTools` 执行：
 * - instructions = Agent 专属 system 提示词 + resume 上下文（简历摘要/显示偏好/历史摘要）；
 * - 仅向模型暴露 `web_search` / `web_browser` 两个联网工具；
 * - 工具执行进度通过 `onToolStart` / `onToolDone` 转发为现有 SSE 事件；
 * - 返回结构保持 `{ assistantText, toolCalls }` 不变，上层 ChatService 无需改动。
 */
@Injectable()
export class AgentExecutorService {
  constructor(
    private readonly agentClient: OpenAiAgentClient,
    private readonly registry: ToolRegistry,
    private readonly webToolExecutor: ChatWebToolExecutor,
  ) {}

  async execute(input: AgentExecutionInput): Promise<AgentExecutionResult> {
    if (!input.selectedAgent) {
      throw new Error('Agent selection is required');
    }

    switch (input.selectedAgent) {
      case 'resumeDiagnosisAgent':
        return this.runAgentLoop(input, RESUME_DIAGNOSIS_SYSTEM_PROMPT);
      case 'interviewCoachAgent':
        return this.runAgentLoop(input, INTERVIEW_COACH_SYSTEM_PROMPT);
      case 'careerPlannerAgent':
        return this.runAgentLoop(input, CAREER_PLANNER_SYSTEM_PROMPT);
      default:
        throw new Error(`Unsupported agent: ${input.selectedAgent}`);
    }
  }

  private async runAgentLoop(
    input: AgentExecutionInput,
    systemPrompt: string,
  ): Promise<AgentExecutionResult> {
    const result = await this.agentClient.runWithTools({
      instructions: this.buildInstructions(systemPrompt, input.resumeContext),
      input: input.userMessage,
      tools: this.registry.toOpenAiTools({
        strict: this.agentClient.strictSchema,
        names: CHAT_WEB_TOOL_NAMES,
      }),
      execute: (call) => this.webToolExecutor.execute(call),
      maxSteps: DEFAULT_CHAT_AGENT_MAX_STEPS,
      onToolStart: (call) => input.toolProgress?.onToolStart?.(call.name),
      onToolDone: (trace) => this.emitToolDone(input, trace),
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

  /** 工具执行结果按 `{ ok, data | error }` 包装判定成功与否。 */
  private isToolSuccess(trace: AgentToolTraceEntry): boolean {
    const result = trace.result as { ok?: boolean } | undefined;
    return result?.ok ?? false;
  }

  /** 组装完整 instructions：Agent system 提示词 + resume 上下文前缀。 */
  private buildInstructions(
    systemPrompt: string,
    context?: ResumeConversationContext,
  ): string {
    const prefix = this.buildResumeContextPrefix(context);
    return prefix ? `${systemPrompt}\n\n${prefix}` : systemPrompt;
  }

  private buildResumeContextPrefix(
    context?: ResumeConversationContext,
  ): string {
    if (!context || context.activeResumeSummaries.length === 0) {
      return (
        this.buildDisplayPreferencePrefix(context) +
        this.buildConversationHistoryPrefix(context)
      );
    }

    const first = context.activeResumeSummaries[0];
    return [
      `已启用简历上下文：${first.title}（${first.sourceMode}）`,
      `核心技能：${first.keySkills.slice(0, 5).join('、')}`,
      this.buildDisplayPreferencePrefix(context).trimEnd(),
      this.buildConversationHistoryPrefix(context).trimEnd(),
    ]
      .filter(Boolean)
      .join('\n')
      .trimEnd()
      .concat('\n');
  }

  private buildConversationHistoryPrefix(
    context?: ResumeConversationContext,
  ): string {
    const historySummary = context?.conversationHistorySummary?.summary?.trim();
    if (!historySummary) {
      return '';
    }

    return `对话历史摘要：${historySummary}\n`;
  }

  private buildDisplayPreferencePrefix(
    context?: ResumeConversationContext,
  ): string {
    const displayPreferences = context?.displayPreferences ?? [];
    if (displayPreferences.length === 0) {
      return '';
    }

    const labels = displayPreferences
      .map((preference) => this.describeDisplayPreference(preference))
      .filter(Boolean)
      .slice(0, 6);
    if (labels.length === 0) {
      return '';
    }

    return `显示偏好：${labels.join('；')}\n`;
  }

  private describeDisplayPreference(
    preference: DisplayPreferenceContextItem,
  ): string {
    switch (preference.key) {
      case 'response_language':
        return this.describeLanguagePreference(preference.normalizedValue);
      case 'response_tone':
        return this.describeTonePreference(preference.normalizedValue);
      case 'response_length':
        return this.describeLengthPreference(preference.normalizedValue);
      case 'output_format':
        return this.describeFormatPreference(preference.normalizedValue);
      case 'markdown_preference':
        return preference.normalizedValue === 'markdown'
          ? '使用 Markdown'
          : '直接纯文本';
      case 'response_structure':
      case 'section_policy':
        return this.describeStructurePreference(preference.normalizedValue);
      case 'example_policy':
        return this.describeExamplePreference(preference.normalizedValue);
      case 'code_example_policy':
        return preference.normalizedValue === 'with_code'
          ? '带代码示例'
          : '不给代码示例';
      case 'content_order':
        return this.describeOrderPreference(preference.normalizedValue);
      default:
        return preference.summary ?? '';
    }
  }

  private describeLanguagePreference(value: string): string {
    if (value === 'zh-CN') {
      return '用中文回答';
    }
    if (value === 'en-US') {
      return '用英文回答';
    }
    if (value === 'bilingual') {
      return '中英双语';
    }

    return value;
  }

  private describeTonePreference(value: string): string {
    if (value === 'professional') {
      return '语气专业';
    }
    if (value === 'friendly') {
      return '语气友好';
    }
    if (value === 'direct') {
      return '表达直接';
    }
    if (value === 'formal') {
      return '风格正式';
    }
    if (value === 'concise') {
      return '表达简洁';
    }

    return value;
  }

  private describeLengthPreference(value: string): string {
    if (value === 'short') {
      return '简短回答';
    }
    if (value === 'medium') {
      return '长度适中';
    }
    if (value === 'long') {
      return '详细展开';
    }

    return value;
  }

  private describeFormatPreference(value: string): string {
    if (value === 'plain_text') {
      return '直接纯文本';
    }
    if (value === 'markdown') {
      return '使用 Markdown';
    }
    if (value === 'table') {
      return '用表格展示';
    }
    if (value === 'bullet_list') {
      return '用列表展示';
    }
    if (value === 'numbered_list') {
      return '用编号列表';
    }

    return value;
  }

  private describeStructurePreference(value: string): string {
    if (value === 'answer_first') {
      return '先给结论';
    }
    if (value === 'summary_then_detail') {
      return '先总结后细节';
    }
    if (value === 'steps_first') {
      return '按步骤提示';
    }
    if (value === 'sections_required') {
      return '分小节';
    }

    return value;
  }

  private describeExamplePreference(value: string): string {
    if (value === 'with_examples') {
      return '带例子';
    }
    if (value === 'without_examples') {
      return '不举例';
    }
    if (value === 'minimal_examples') {
      return '给最小示例';
    }

    return value;
  }

  private describeOrderPreference(value: string): string {
    if (value === 'issues_then_fix') {
      return '先问题后方案';
    }
    if (value === 'plan_then_details') {
      return '先方案后细节';
    }
    if (value === 'result_then_reason') {
      return '先结果后原因';
    }
    if (value === 'code_then_explanation') {
      return '先代码后解释';
    }

    return value;
  }
}
