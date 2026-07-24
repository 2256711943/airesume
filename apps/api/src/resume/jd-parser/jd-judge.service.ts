import { Injectable } from '@nestjs/common';
import type { ParsedJdResult } from './types';

export interface JdJudgeResult {
  overallScore: number;
  dimensions: {
    roleFit: number;
    industryFit: number;
    seniorityFit: number;
    specificity: number;
    measurability: number;
    safety: number;
  };
  issues: string[];
  suggestions: string[];
}

@Injectable()
export class JdJudgeService {
  judge(parsed: ParsedJdResult, rawJdText: string): JdJudgeResult {
    const roleFit = this.scoreRoleFit(parsed);
    const industryFit = this.scoreIndustryFit(parsed, rawJdText);
    const seniorityFit = this.scoreSeniorityFit(parsed);
    const specificity = this.scoreSpecificity(parsed);
    const measurability = this.scoreMeasurability(parsed, rawJdText);
    const safety = this.scoreSafety(parsed, rawJdText);

    const dimensions = {
      roleFit,
      industryFit,
      seniorityFit,
      specificity,
      measurability,
      safety,
    };

    const overallScore = Number(
      (
        roleFit * 0.24 +
        industryFit * 0.18 +
        seniorityFit * 0.18 +
        specificity * 0.16 +
        measurability * 0.14 +
        safety * 0.1
      ).toFixed(1),
    );

    const issues: string[] = [];
    const suggestions: string[] = [];

    if (specificity < 75) {
      issues.push('weak_specificity');
      suggestions.push('补充职责中的动作、对象与业务场景表达');
    }
    if (measurability < 70) {
      issues.push('low_measurability');
      suggestions.push('增加可量化指标线索，例如转化率、时效、成本或质量目标');
    }
    if (seniorityFit < 70) {
      issues.push('seniority_mismatch_risk');
      suggestions.push('调整职责层级，避免与年限不匹配的管理或战略描述');
    }
    if (safety < 80) {
      issues.push('safety_risk');
      suggestions.push('减少夸大性或绝对化表达，保持可验证描述');
    }
    if (parsed.quality.warnings.length > 0) {
      issues.push('missing_key_fields');
      suggestions.push('补全岗位关键字段，例如经验年限、职责条目和必备要求');
    }

    return {
      overallScore,
      dimensions,
      issues,
      suggestions,
    };
  }

  private scoreRoleFit(parsed: ParsedJdResult): number {
    const base = 55;
    const responsibilitiesBonus = Math.min(
      parsed.responsibilities.length * 4,
      20,
    );
    const requirementsBonus = Math.min(parsed.requirements.must.length * 3, 15);
    const skillsBonus = Math.min(parsed.skills.hardSkills.length * 1.5, 10);
    return Math.min(
      100,
      Math.round(
        base + responsibilitiesBonus + requirementsBonus + skillsBonus,
      ),
    );
  }

  private scoreIndustryFit(parsed: ParsedJdResult, rawJdText: string): number {
    const text = rawJdText.toLowerCase();
    const matchedKeywords = parsed.keywords.filter((keyword) =>
      text.includes(keyword.toLowerCase()),
    ).length;
    const keywordScore = Math.min(matchedKeywords * 2, 24);
    const goalScore = Math.min(parsed.businessGoals.length * 8, 24);
    return Math.min(100, Math.round(52 + keywordScore + goalScore));
  }

  private scoreSeniorityFit(parsed: ParsedJdResult): number {
    const years = Math.max(
      parsed.basic.yearsExpMin ?? 0,
      parsed.basic.yearsExpMax ?? 0,
    );
    const hasManagementWords = parsed.responsibilities.some((item) =>
      /(战略|团队管理|带团队|负责人|owner|跨部门)/i.test(item.text),
    );

    if (years <= 1 && hasManagementWords) {
      return 62;
    }
    if (years >= 6 && !hasManagementWords) {
      return 76;
    }
    if (parsed.seniorityLevel === 'unknown') {
      return 70;
    }
    return 86;
  }

  private scoreSpecificity(parsed: ParsedJdResult): number {
    if (parsed.responsibilities.length === 0) {
      return 55;
    }

    const completeCount = parsed.responsibilities.filter(
      (item) => item.action.trim().length > 0 && item.object.trim().length > 4,
    ).length;
    const ratio = completeCount / parsed.responsibilities.length;
    return Math.round(60 + ratio * 35);
  }

  private scoreMeasurability(
    parsed: ParsedJdResult,
    rawJdText: string,
  ): number {
    const text = rawJdText.toLowerCase();
    const numberSignals = (
      text.match(/\d+[%kK万亿]|roi|gmv|dau|mau|转化率|留存率|成本|时效/g) ?? []
    ).length;
    const goalBonus = Math.min(parsed.businessGoals.length * 6, 18);
    return Math.min(
      100,
      Math.round(58 + Math.min(numberSignals * 5, 24) + goalBonus),
    );
  }

  private scoreSafety(parsed: ParsedJdResult, rawJdText: string): number {
    const riskWords = /(第一|顶级|绝对|保过|保录|100%|无条件)/i;
    const hasRiskWord = riskWords.test(rawJdText);
    const missingPenalty = parsed.quality.missingFields.length * 3;
    const warningPenalty = parsed.quality.warnings.length * 2;
    const base = hasRiskWord ? 78 : 92;
    return Math.max(
      50,
      Math.min(100, Math.round(base - missingPenalty - warningPenalty)),
    );
  }
}
