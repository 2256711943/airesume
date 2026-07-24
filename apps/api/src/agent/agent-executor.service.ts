import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ToolRegistryService } from '../tool/tool-registry.service';
import { ToolCallLogService } from './tool-call-log.service';
import type { OrchestratorDecision } from './orchestrator/orchestrator.service';
import type { ResumeConversationContext } from '../resume/resume-context.service';

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

export interface InterviewFocus {
  topic: string;
  questionType:
    | 'self_introduction'
    | 'behavioral'
    | 'technical'
    | 'salary_career'
    | 'general';
  answerStrategy: string[];
  sampleAngles: string[];
}

export interface CareerFocus {
  topic: string;
  careerStage: 'entry' | 'growth' | 'transition' | 'leadership' | 'general';
  strategy: string[];
  actionSteps: string[];
}

@Injectable()
export class AgentExecutorService {
  constructor(
    private readonly toolCallLogService: ToolCallLogService,
    private readonly toolRegistryService: ToolRegistryService,
  ) {}

  async execute(input: AgentExecutionInput): Promise<AgentExecutionResult> {
    if (!input.selectedAgent) {
      throw new Error('Agent selection is required');
    }

    const startedAt = Date.now();
    switch (input.selectedAgent) {
      case 'resumeDiagnosisAgent':
        return this.executeResumeDiagnosis(input, startedAt);
      case 'interviewCoachAgent':
        return this.executeInterviewCoach(input, startedAt);
      case 'careerPlannerAgent':
        return this.executeCareerPlanner(input, startedAt);
      default:
        throw new Error(`Unsupported agent: ${input.selectedAgent}`);
    }
  }

  private async executeResumeDiagnosis(
    input: AgentExecutionInput,
    startedAt: number,
  ): Promise<AgentExecutionResult> {
    const emitToolStart = (toolName: string) => {
      input.toolProgress?.onToolStart?.(toolName);
    };
    const emitToolDone = (result: {
      toolName: string;
      success: boolean;
      latencyMs: number;
      errorCode?: string;
      errorMessage?: string;
    }) => {
      input.toolProgress?.onToolDone?.(result);
    };

    if (!this.isLikelyJdText(input.userMessage)) {
      const toolName = 'resume_diagnosis_skip_tool';
      const toolStartedAt = Date.now();
      emitToolStart(toolName);
      await this.toolCallLogService.createLog({
        agentRunId: input.agentRunId,
        toolName,
        inputJson: {
          conversationId: input.conversationId,
          messageId: input.messageId,
          reason: 'message_not_look_like_jd',
          resumeContext: input.resumeContext,
        } as unknown as Prisma.InputJsonValue,
        outputJson: {
          status: 'skipped',
        },
        success: true,
        latencyMs: Date.now() - startedAt,
      });

      emitToolDone({
        toolName,
        success: true,
        latencyMs: Date.now() - toolStartedAt,
      });

      return {
        assistantText:
          this.buildResumeContextPrefix(input.resumeContext) +
          '简历诊断：当前这条消息看起来不是完整的 JD 文本。我先按追问模式处理。你可以直接贴岗位描述，我会继续帮你拆解要求和匹配点。',
        toolCalls: [
          {
            toolName: 'resume_diagnosis_skip_tool',
            success: true,
            latencyMs: Date.now() - startedAt,
          },
        ],
      };
    }

    const toolName = 'jd_parse_and_score';
    emitToolStart(toolName);
    const toolResult = await this.toolRegistryService.execute(
      'jd_parse_and_score',
      { jdText: input.userMessage },
      {
        agentRunId: input.agentRunId,
        timeoutMs: 8000,
      },
    );
    emitToolDone({
      toolName,
      success: toolResult.success,
      latencyMs: toolResult.latencyMs,
      errorCode: toolResult.error?.code,
      errorMessage: toolResult.error?.message,
    });

    if (!toolResult.success || !toolResult.data) {
      return {
        assistantText:
          this.buildResumeContextPrefix(input.resumeContext) +
          '简历诊断：我已经尝试解析这条 JD，但当前解析没有成功。你可以再发一次更完整的岗位描述，我再继续拆解。',
        toolCalls: [
          {
            toolName: 'jd_parse_and_score',
            success: false,
            latencyMs: toolResult.latencyMs,
          },
        ],
      };
    }

    const judge = toolResult.data.judge as {
      overallScore: number;
      issues: string[];
      suggestions: string[];
    };

    const assistantText = [
      this.buildResumeContextPrefix(input.resumeContext),
      `简历诊断：这份 JD 的整体匹配信号约为 ${judge.overallScore} 分。`,
      judge.issues.length > 0
        ? `当前主要风险点：${judge.issues.join('、')}`
        : '当前没有明显的结构性风险。',
      judge.suggestions.length > 0
        ? `建议优先处理：${judge.suggestions.join('；')}`
        : '暂无额外修改建议。',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      assistantText,
      toolCalls: [
        {
          toolName: 'jd_parse_and_score',
          success: true,
          latencyMs: toolResult.latencyMs,
        },
      ],
    };
  }

  private async executeInterviewCoach(
    input: AgentExecutionInput,
    startedAt: number,
  ): Promise<AgentExecutionResult> {
    const toolName = 'interview_coach_response';
    const toolStartedAt = Date.now();
    input.toolProgress?.onToolStart?.(toolName);
    const interviewFocus = this.detectInterviewFocus(input.userMessage);
    const assistantText = this.buildInterviewCoachAssistantText(
      input.userMessage,
      interviewFocus,
      input.resumeContext,
    );
    const latencyMs = Date.now() - startedAt;
    input.toolProgress?.onToolDone?.({
      toolName,
      success: true,
      latencyMs: Date.now() - toolStartedAt,
    });

    await this.toolCallLogService.createLog({
      agentRunId: input.agentRunId,
      toolName,
      inputJson: {
        conversationId: input.conversationId,
        messageId: input.messageId,
        selectedAgent: input.selectedAgent,
        routeDecision: input.routeDecision,
        interviewFocus,
        resumeContext: input.resumeContext,
      } as unknown as Prisma.InputJsonValue,
      outputJson: {
        interviewFocus,
        assistantText,
      } as unknown as Prisma.InputJsonValue,
      success: true,
      latencyMs,
    });

    return {
      assistantText,
      toolCalls: [
        {
          toolName: 'interview_coach_response',
          success: true,
          latencyMs,
        },
      ],
    };
  }

  private async executeCareerPlanner(
    input: AgentExecutionInput,
    startedAt: number,
  ): Promise<AgentExecutionResult> {
    const toolName = 'career_planner_response';
    const toolStartedAt = Date.now();
    input.toolProgress?.onToolStart?.(toolName);
    const careerFocus = this.detectCareerFocus(input.userMessage);
    const assistantText = this.buildCareerPlannerAssistantText(
      input.userMessage,
      careerFocus,
      input.resumeContext,
    );
    const latencyMs = Date.now() - startedAt;
    input.toolProgress?.onToolDone?.({
      toolName,
      success: true,
      latencyMs: Date.now() - toolStartedAt,
    });

    await this.toolCallLogService.createLog({
      agentRunId: input.agentRunId,
      toolName,
      inputJson: {
        conversationId: input.conversationId,
        messageId: input.messageId,
        selectedAgent: input.selectedAgent,
        routeDecision: input.routeDecision,
        careerFocus,
        resumeContext: input.resumeContext,
      } as unknown as Prisma.InputJsonValue,
      outputJson: {
        careerFocus,
        assistantText,
      } as unknown as Prisma.InputJsonValue,
      success: true,
      latencyMs,
    });

    return {
      assistantText,
      toolCalls: [
        {
          toolName: 'career_planner_response',
          success: true,
          latencyMs,
        },
      ],
    };
  }

  private buildResumeContextPrefix(
    context?: ResumeConversationContext,
  ): string {
    if (!context || context.activeResumeSummaries.length === 0) {
      return this.buildConversationHistoryPrefix(context);
    }

    const first = context.activeResumeSummaries[0];
    return [
      `已启用简历上下文：${first.title}（${first.sourceMode}）`,
      `核心技能：${first.keySkills.slice(0, 5).join('、')}`,
      this.buildConversationHistoryPrefix(context).trimEnd(),
    ]
      .filter(Boolean)
      .join('\n')
      .trimEnd()
      .concat('\n');
  }

  private detectInterviewFocus(message: string): InterviewFocus {
    const normalized = message.trim();

    if (
      /(自我介绍|介绍一下你自己|tell me about yourself|please introduce yourself)/i.test(
        normalized,
      )
    ) {
      return {
        topic: '自我介绍',
        questionType: 'self_introduction',
        answerStrategy: ['先给结论', '控制在 60 到 90 秒', '突出岗位匹配点'],
        sampleAngles: ['当前岗位相关经历', '核心技能', '可量化结果'],
      };
    }

    if (
      /(项目|经历|冲突|失败|压力|合作|团队|为什么|追问|behavior|star)/i.test(
        normalized,
      )
    ) {
      return {
        topic: '行为面试题',
        questionType: 'behavioral',
        answerStrategy: [
          '用 STAR 结构组织',
          '每一段都带结果',
          '最后补一段复盘',
        ],
        sampleAngles: ['场景', '任务', '行动', '结果'],
      };
    }

    if (
      /(技术|算法|系统设计|数据库|并发|架构|性能|调优|实现|debug|代码)/i.test(
        normalized,
      )
    ) {
      return {
        topic: '技术题',
        questionType: 'technical',
        answerStrategy: ['先说结论', '再说原理与取舍', '最后补边界条件'],
        sampleAngles: ['核心概念', '方案权衡', '异常情况'],
      };
    }

    if (
      /(薪资|offer|跳槽|离职|职业规划|晋升|why leave|why change)/i.test(
        normalized,
      )
    ) {
      return {
        topic: '职业与决策题',
        questionType: 'salary_career',
        answerStrategy: [
          '保持正向表达',
          '不要攻击前公司',
          '把诉求落到目标岗位',
        ],
        sampleAngles: ['成长空间', '岗位匹配', '长期规划'],
      };
    }

    return {
      topic: '通用面试追问',
      questionType: 'general',
      answerStrategy: ['先澄清问题目标', '再给可执行答案', '用简短例子支撑'],
      sampleAngles: ['问题背景', '你的判断', '行动方案'],
    };
  }

  private buildInterviewCoachAssistantText(
    userMessage: string,
    interviewFocus: InterviewFocus,
    resumeContext?: ResumeConversationContext,
  ): string {
    const strategyLines = interviewFocus.answerStrategy
      .map((item) => `- ${item}`)
      .join('\n');
    const angleLines = interviewFocus.sampleAngles
      .map((item) => `- ${item}`)
      .join('\n');
    const resumeHint = this.buildResumeHint(resumeContext);

    return [
      resumeHint,
      `面试指导：我判断你这次提问更偏向「${interviewFocus.topic}」。`,
      '',
      '回答策略：',
      strategyLines,
      '',
      '建议优先覆盖的内容：',
      angleLines,
      '',
      '可直接套用的表达框架：',
      '1. 先用一句话给结论。',
      '2. 再补 2 到 3 个关键事实或例子。',
      '3. 最后收束到岗位匹配或结果影响。',
      '',
      '如果你愿意，我下一轮可以继续把这道题改成更像真实面试现场的回答。',
      `原始问题：${userMessage.trim()}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildCareerPlannerAssistantText(
    userMessage: string,
    careerFocus: CareerFocus,
    resumeContext?: ResumeConversationContext,
  ): string {
    const strategyLines = careerFocus.strategy
      .map((item) => `- ${item}`)
      .join('\n');
    const actionLines = careerFocus.actionSteps
      .map((item) => `- ${item}`)
      .join('\n');
    const resumeHint = this.buildResumeHint(resumeContext);

    return [
      resumeHint,
      `职业规划：我判断你当前更偏向「${careerFocus.topic}」。`,
      '',
      `阶段判断：${careerFocus.careerStage}`,
      '',
      '规划策略：',
      strategyLines,
      '',
      '下一步行动：',
      actionLines,
      '',
      '你可以继续追问我这三个方向之一：',
      '1. 目标岗位怎么选',
      '2. 现在的能力缺口是什么',
      '3. 30 天内先做什么',
      '',
      `原始问题：${userMessage.trim()}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildResumeHint(context?: ResumeConversationContext): string {
    if (!context || context.activeResumeSummaries.length === 0) {
      return this.buildConversationHistoryPrefix(context);
    }

    const first = context.activeResumeSummaries[0];
    const skillLine =
      first.keySkills.length > 0
        ? `\n核心技能：${first.keySkills.slice(0, 5).join('、')}`
        : '';
    const projectLine = first.keyProjects[0]
      ? `\n关键项目：${first.keyProjects[0].name}${
          first.keyProjects[0].highlights.length > 0
            ? `｜${first.keyProjects[0].highlights.slice(0, 2).join('；')}`
            : ''
        }`
      : '';

    return `已启用简历上下文：${first.title}（${first.sourceMode}）${skillLine}${projectLine}\n${this.buildConversationHistoryPrefix(context)}`;
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

  private detectCareerFocus(message: string): CareerFocus {
    const normalized = message.trim();

    if (
      /(转行|转岗|跳槽|换工作|转到|转向|职业规划|职业路径|职业发展|方向|路径|发展路径|怎么选)/i.test(
        normalized,
      )
    ) {
      return {
        topic: '转型与方向选择',
        careerStage: 'transition',
        strategy: [
          '先明确目标岗位',
          '再补齐能力差距',
          '最后制定 30/60/90 天行动计划',
        ],
        actionSteps: [
          '梳理当前技能栈',
          '匹配 2 到 3 个目标岗位',
          '列出缺口和补课顺序',
        ],
      };
    }

    if (
      /(晋升|带团队|管理|leader|负责人|资深|架构|技术管理)/i.test(normalized)
    ) {
      return {
        topic: '晋升与领导力',
        careerStage: 'leadership',
        strategy: [
          '突出影响力而不是只写执行',
          '补充跨团队协作案例',
          '给出结果和复盘',
        ],
        actionSteps: ['补充 owner 类经历', '整理影响指标', '准备管理类故事库'],
      };
    }

    if (/(应届|毕业|第一份工作|校招|实习)/i.test(normalized)) {
      return {
        topic: '起步与入行',
        careerStage: 'entry',
        strategy: [
          '先锁定赛道',
          '优先补实习和项目',
          '把基础能力做成可展示资产',
        ],
        actionSteps: [
          '筛选 3 个目标方向',
          '整理项目作品集',
          '优化简历和自我介绍',
        ],
      };
    }

    if (/(3年|5年|经验|成长|进阶|深耕|提升)/i.test(normalized)) {
      return {
        topic: '成长与进阶',
        careerStage: 'growth',
        strategy: [
          '先看当前能力天花板',
          '再选纵深或横向扩展',
          '避免只堆经历不堆成果',
        ],
        actionSteps: ['盘点能力矩阵', '找出最强优势方向', '规划下一次跳跃目标'],
      };
    }

    return {
      topic: '通用职业规划',
      careerStage: 'general',
      strategy: ['先定义目标', '再定义缺口', '最后定义节奏'],
      actionSteps: ['梳理当前状态', '列出目标岗位', '输出一版行动路径'],
    };
  }

  private isLikelyJdText(text: string): boolean {
    return /(岗位|职责|要求|任职|JD|job description|招聘|学历|经验|技能)/i.test(
      text,
    );
  }
}
