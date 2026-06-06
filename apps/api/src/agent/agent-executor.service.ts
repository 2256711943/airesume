import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ToolRegistryService } from '../tool/tool-registry.service';
import { ToolCallLogService } from './tool-call-log.service';
import type { OrchestratorDecision } from './orchestrator/orchestrator.service';

export interface AgentExecutionInput {
  agentRunId: string;
  conversationId: string;
  messageId: string;
  selectedAgent: string;
  userMessage: string;
  routeDecision: OrchestratorDecision;
}

export interface AgentExecutionResult {
  assistantText: string;
  toolCalls: Array<{
    toolName: string;
    success: boolean;
  }>;
}

export interface InterviewFocus {
  topic: string;
  questionType: 'self_introduction' | 'behavioral' | 'technical' | 'salary_career' | 'general';
  answerStrategy: string[];
  sampleAngles: string[];
}

@Injectable()
export class AgentExecutorService {
  constructor(
    private readonly toolCallLogService: ToolCallLogService,
    private readonly toolRegistryService: ToolRegistryService,
  ) {}

  // 第一版先保留规则化执行入口，后续再把 specialist agent 拆成独立模块。
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
        await this.toolCallLogService.createLog({
          agentRunId: input.agentRunId,
          toolName: 'agent_executor_placeholder',
          inputJson: {
            conversationId: input.conversationId,
            messageId: input.messageId,
            selectedAgent: input.selectedAgent,
            routeDecision: input.routeDecision,
          } as unknown as Prisma.InputJsonValue,
          outputJson: {
            status: 'noop',
          } as unknown as Prisma.InputJsonValue,
          success: true,
          latencyMs: Date.now() - startedAt,
        });

        return {
          assistantText: this.buildPlaceholderAssistantText(input.selectedAgent),
          toolCalls: [
            {
              toolName: 'agent_executor_placeholder',
              success: true,
            },
          ],
        };
      default:
        throw new Error(`Unsupported agent: ${input.selectedAgent}`);
    }
  }

  private async executeResumeDiagnosis(
    input: AgentExecutionInput,
    startedAt: number,
  ): Promise<AgentExecutionResult> {
    if (!this.isLikelyJdText(input.userMessage)) {
      await this.toolCallLogService.createLog({
        agentRunId: input.agentRunId,
        toolName: 'resume_diagnosis_skip_tool',
        inputJson: {
          conversationId: input.conversationId,
          messageId: input.messageId,
          reason: 'message_not_look_like_jd',
        } as unknown as Prisma.InputJsonValue,
        outputJson: {
          status: 'skipped',
        } as unknown as Prisma.InputJsonValue,
        success: true,
        latencyMs: Date.now() - startedAt,
      });

      return {
        assistantText:
          '简历诊断：当前这条消息看起来不是完整的 JD 文本。我先按追问模式处理。你可以直接贴岗位描述，我会继续帮你拆解要求和匹配点。',
        toolCalls: [
          {
            toolName: 'resume_diagnosis_skip_tool',
            success: true,
          },
        ],
      };
    }

    const toolResult = await this.toolRegistryService.execute(
      'jd_parse_and_score',
      { jdText: input.userMessage },
      {
        agentRunId: input.agentRunId,
        timeoutMs: 8000,
      },
    );

    if (!toolResult.success || !toolResult.data) {
      return {
        assistantText:
          '简历诊断：我已经尝试解析这条 JD，但当前解析没有成功。你可以再发一次更完整的岗位描述，我再继续拆解。',
        toolCalls: [
          {
            toolName: 'jd_parse_and_score',
            success: false,
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
      `简历诊断：这份 JD 的整体匹配信号约为 ${judge.overallScore} 分。`,
      judge.issues.length > 0
        ? `当前主要风险点：${judge.issues.join('、')}`
        : '当前没有明显的结构性风险。',
      judge.suggestions.length > 0
        ? `建议优先处理：${judge.suggestions.join('；')}`
        : '暂无额外修改建议。',
    ].join('\n');

    return {
      assistantText,
      toolCalls: [
        {
          toolName: 'jd_parse_and_score',
          success: true,
        },
      ],
    };
  }

  private async executeInterviewCoach(
    input: AgentExecutionInput,
    startedAt: number,
  ): Promise<AgentExecutionResult> {
    // 面试指导先做规则化分类，避免这里额外依赖模型。
    const interviewFocus = this.detectInterviewFocus(input.userMessage);
    const assistantText = this.buildInterviewCoachAssistantText(input.userMessage, interviewFocus);

    await this.toolCallLogService.createLog({
      agentRunId: input.agentRunId,
      toolName: 'interview_coach_response',
      inputJson: {
        conversationId: input.conversationId,
        messageId: input.messageId,
        selectedAgent: input.selectedAgent,
        routeDecision: input.routeDecision,
        interviewFocus,
      } as unknown as Prisma.InputJsonValue,
      outputJson: {
        interviewFocus,
        assistantText,
      } as unknown as Prisma.InputJsonValue,
      success: true,
      latencyMs: Date.now() - startedAt,
    });

    return {
      assistantText,
      toolCalls: [
        {
          toolName: 'interview_coach_response',
          success: true,
        },
      ],
    };
  }

  private buildPlaceholderAssistantText(selectedAgent: string): string {
    switch (selectedAgent) {
      case 'careerPlannerAgent':
        return '职业规划：我已经完成路由接入，下一步会结合你的背景、目标岗位和市场信号输出规划建议。';
      case 'resumeDiagnosisAgent':
      default:
        return '简历诊断：我已经完成路由接入，下一步会基于解析和评分结果给出结构化建议。';
    }
  }

  private detectInterviewFocus(message: string): InterviewFocus {
    const normalized = message.trim();

    if (/(自我介绍|介绍一下你自己|tell me about yourself|please introduce yourself)/i.test(normalized)) {
      return {
        topic: '自我介绍',
        questionType: 'self_introduction',
        answerStrategy: ['先给结论', '控制在 60 到 90 秒', '突出岗位匹配点'],
        sampleAngles: ['当前岗位相关经历', '核心技能', '可量化结果'],
      };
    }

    if (/(项目|经历|冲突|失败|压力|合作|团队|为什么|追问|behavior|star)/i.test(normalized)) {
      return {
        topic: '行为面试题',
        questionType: 'behavioral',
        answerStrategy: ['用 STAR 结构组织', '每一段都带结果', '最后补一段复盘'],
        sampleAngles: ['场景', '任务', '行动', '结果'],
      };
    }

    if (/(技术|算法|系统设计|数据库|并发|架构|性能|调优|实现|debug|代码)/i.test(normalized)) {
      return {
        topic: '技术题',
        questionType: 'technical',
        answerStrategy: ['先说结论', '再说原理与取舍', '最后补边界条件'],
        sampleAngles: ['核心概念', '方案权衡', '异常情况'],
      };
    }

    if (/(薪资|offer|跳槽|离职|职业规划|晋升|why leave|why change)/i.test(normalized)) {
      return {
        topic: '职业与决策题',
        questionType: 'salary_career',
        answerStrategy: ['保持正向表达', '不要攻击前公司', '把诉求落到目标岗位'],
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

  private buildInterviewCoachAssistantText(userMessage: string, interviewFocus: InterviewFocus): string {
    const strategyLines = interviewFocus.answerStrategy.map((item) => `- ${item}`).join('\n');
    const angleLines = interviewFocus.sampleAngles.map((item) => `- ${item}`).join('\n');

    return [
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
    ].join('\n');
  }

  private isLikelyJdText(text: string): boolean {
    return /(岗位|职责|要求|任职|JD|job description|招聘|学历|经验|技能)/i.test(text);
  }
}
