export type SeniorityLevel = 'junior' | 'mid' | 'senior' | 'lead' | 'manager' | 'director' | 'unknown';

export interface ParsedJdBasic {
  jobTitleRaw: string;
  jobTitleNorm: string;
  industry?: string;
  city?: string;
  educationMin?: '不限' | '大专' | '本科' | '硕士' | '博士';
  yearsExpMin?: number;
  yearsExpMax?: number;
  salaryMinK?: number;
  salaryMaxK?: number;
  salaryMonths?: number;
  reportTo?: string;
  teamSize?: number;
}

export interface ParsedResponsibilityItem {
  text: string;
  action: string;
  object: string;
  scope?: string;
  evidenceSpan: string;
  confidence: number;
}

export interface ParsedRequirementItem {
  text: string;
  type: '经验' | '技能' | '学历' | '证书' | '语言' | '其他';
  evidenceSpan: string;
  confidence: number;
}

export interface ParsedBusinessGoal {
  goalType: '增长' | '降本' | '提效' | '质量' | '合规' | '风控' | '交付' | '创新' | '客户成功' | '其他';
  text: string;
  metricHint?: string;
  evidenceSpan: string;
  confidence: number;
}

export interface ParsedJdQuality {
  parseVersion: string;
  missingFields: string[];
  warnings: string[];
}

export interface ParsedJdResult {
  basic: ParsedJdBasic;
  responsibilities: ParsedResponsibilityItem[];
  requirements: {
    must: ParsedRequirementItem[];
    preferred: ParsedRequirementItem[];
  };
  skills: {
    hardSkills: string[];
    softSkills: string[];
    tools: string[];
    certificates: string[];
  };
  businessGoals: ParsedBusinessGoal[];
  keywords: string[];
  seniorityLevel: SeniorityLevel;
  quality: ParsedJdQuality;
}
