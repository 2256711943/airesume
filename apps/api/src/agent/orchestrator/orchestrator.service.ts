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

export interface OrchestratorDecision {
  intent: ChatIntent;
  selectedAgent: SpecialistAgentName;
  reason: string;
}

@Injectable()
export class OrchestratorService {
  // 基于显式关键词规则做第一版意图识别，避免过早依赖 LLM 路由。
  decideNextAgent(message: string): OrchestratorDecision {
    const normalized = message.trim().toLowerCase();

    if (this.matchesInterviewIntent(normalized)) {
      return {
        intent: 'interview_guidance',
        selectedAgent: 'interviewCoachAgent',
        reason: '命中面试表达与追问类关键词',
      };
    }

    if (this.matchesCareerIntent(normalized)) {
      return {
        intent: 'career_planning',
        selectedAgent: 'careerPlannerAgent',
        reason: '命中职业规划、转岗或岗位选择类关键词',
      };
    }

    if (this.matchesResumeDiagnosisIntent(normalized)) {
      return {
        intent: 'resume_diagnosis',
        selectedAgent: 'resumeDiagnosisAgent',
        reason: '命中简历优化、诊断或岗位匹配类关键词',
      };
    }

    return {
      intent: 'general_resume_followup',
      selectedAgent: 'resumeDiagnosisAgent',
      reason: '未命中特定规则，默认进入简历追问处理链路',
    };
  }

  private matchesInterviewIntent(message: string): boolean {
    return /(面试|追问|自我介绍|怎么说|如何回答|mock|star)/i.test(message);
  }

  private matchesCareerIntent(message: string): boolean {
    return /(职业|规划|转岗|方向|岗位选择|发展路径|学习路径)/i.test(message);
  }

  private matchesResumeDiagnosisIntent(message: string): boolean {
    return /(简历|优化|润色|诊断|改写|匹配|岗位相关|项目描述)/i.test(message);
  }
}
