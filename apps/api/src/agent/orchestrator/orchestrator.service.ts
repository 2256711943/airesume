import { Injectable } from '@nestjs/common';

export type ChatIntent =
  | 'resume_diagnosis'
  | 'interview_guidance'
  | 'career_planning'
  | 'general_resume_followup';

export type SpecialistAgentName =
  | 'resumeDiagnosisAgent'
  | 'interviewCoachAgent'
  | 'careerPlannerAgent';

export interface OrchestratorRuleMatch {
  ruleId: string;
  label: string;
  matchedKeywords: string[];
}

export interface OrchestratorDecision {
  intent: ChatIntent;
  selectedAgent: SpecialistAgentName;
  reason: string;
  confidence: number;
  fallbackUsed: boolean;
  matchedRules: OrchestratorRuleMatch[];
}

@Injectable()
export class OrchestratorService {
  decideNextAgent(message: string): OrchestratorDecision {
    const normalized = message.trim().toLowerCase();

    const interviewMatch = this.collectMatches(normalized, [
      '面试',
      '追问',
      '自我介绍',
      '怎么说',
      '如何回答',
      'mock',
      'star',
    ]);
    if (interviewMatch.length > 0) {
      return this.buildDecision({
        intent: 'interview_guidance',
        selectedAgent: 'interviewCoachAgent',
        reason: '命中面试表达与追问类关键词',
        confidence: 0.93,
        fallbackUsed: false,
        matchedRules: [
          {
            ruleId: 'interview_keywords',
            label: '面试指导关键词',
            matchedKeywords: interviewMatch,
          },
        ],
      });
    }

    const careerMatch = this.collectMatches(normalized, [
      '职业',
      '规划',
      '转岗',
      '方向',
      '岗位选择',
      '发展路径',
      '学习路径',
    ]);
    if (careerMatch.length > 0) {
      return this.buildDecision({
        intent: 'career_planning',
        selectedAgent: 'careerPlannerAgent',
        reason: '命中职业规划、转岗或岗位选择类关键词',
        confidence: 0.9,
        fallbackUsed: false,
        matchedRules: [
          {
            ruleId: 'career_keywords',
            label: '职业规划关键词',
            matchedKeywords: careerMatch,
          },
        ],
      });
    }

    const resumeMatch = this.collectMatches(normalized, [
      '简历',
      '优化',
      '润色',
      '诊断',
      '改写',
      '匹配',
      '岗位相关',
      '项目描述',
    ]);
    if (resumeMatch.length > 0) {
      return this.buildDecision({
        intent: 'resume_diagnosis',
        selectedAgent: 'resumeDiagnosisAgent',
        reason: '命中简历优化、诊断或岗位匹配类关键词',
        confidence: 0.88,
        fallbackUsed: false,
        matchedRules: [
          {
            ruleId: 'resume_keywords',
            label: '简历诊断关键词',
            matchedKeywords: resumeMatch,
          },
        ],
      });
    }

    return this.buildDecision({
      intent: 'general_resume_followup',
      selectedAgent: 'resumeDiagnosisAgent',
      reason: '未命中特定规则，默认进入简历追问处理链路',
      confidence: 0.42,
      fallbackUsed: true,
      matchedRules: [
        {
          ruleId: 'fallback_default',
          label: '默认回退规则',
          matchedKeywords: [],
        },
      ],
    });
  }

  private buildDecision(decision: OrchestratorDecision): OrchestratorDecision {
    return decision;
  }

  private collectMatches(message: string, keywords: string[]): string[] {
    return keywords.filter((keyword) => message.includes(keyword.toLowerCase()));
  }
}
