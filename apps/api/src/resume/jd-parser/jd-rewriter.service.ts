import { Injectable } from '@nestjs/common';
import type { JdJudgeResult } from './jd-judge.service';
import type { ParsedJdResult } from './types';

@Injectable()
export class JdRewriterService {
  rewrite(
    parsed: ParsedJdResult,
    judge: JdJudgeResult,
    rawJdText: string,
  ): ParsedJdResult {
    let next = this.cloneParsed(parsed);

    if (judge.dimensions.specificity < 75) {
      next = this.rewriteSpecificity(next);
    }

    if (judge.dimensions.measurability < 70) {
      next = this.rewriteMeasurability(next, rawJdText);
    }

    if (judge.dimensions.seniorityFit < 70) {
      next = this.rewriteSeniority(next);
    }

    if (!next.quality.warnings.includes('rewrite_applied')) {
      next.quality.warnings.push('rewrite_applied');
    }

    return next;
  }

  private rewriteSpecificity(parsed: ParsedJdResult): ParsedJdResult {
    const rewrittenResponsibilities = parsed.responsibilities.map((item) => {
      const text = item.text.trim();
      const hasScene = /(场景|业务|流程|系统|平台|项目|产品)/.test(text);
      const hasObject = item.object.trim().length >= 5;

      if (hasScene && hasObject) {
        return item;
      }

      const newText = `${text.replace(/[。.!?]+$/, '')}，覆盖具体业务场景与交付范围。`;
      return {
        ...item,
        text: newText,
        object: hasObject ? item.object : '相关业务流程与交付结果',
        confidence: Math.min(0.95, item.confidence + 0.05),
      };
    });

    return {
      ...parsed,
      responsibilities: rewrittenResponsibilities,
    };
  }

  private rewriteMeasurability(
    parsed: ParsedJdResult,
    rawJdText: string,
  ): ParsedJdResult {
    const metricHints = this.extractMetricHints(rawJdText);
    const mergedGoals = [...parsed.businessGoals];

    if (mergedGoals.length === 0) {
      mergedGoals.push({
        goalType: '提效',
        text: '围绕关键流程效率提升推动目标达成',
        metricHint: metricHints[0] ?? '时效/人效',
        evidenceSpan: rawJdText.slice(0, 120),
        confidence: 0.72,
      });
    } else {
      for (let i = 0; i < mergedGoals.length; i += 1) {
        if (!mergedGoals[i].metricHint) {
          mergedGoals[i] = {
            ...mergedGoals[i],
            metricHint: metricHints[i] ?? '转化率/时效/成本',
          };
        }
      }
    }

    return {
      ...parsed,
      businessGoals: mergedGoals,
    };
  }

  private rewriteSeniority(parsed: ParsedJdResult): ParsedJdResult {
    const years = Math.max(
      parsed.basic.yearsExpMin ?? 0,
      parsed.basic.yearsExpMax ?? 0,
    );
    const next = this.cloneParsed(parsed);

    if (years <= 2) {
      next.seniorityLevel = 'junior';
      next.responsibilities = next.responsibilities.map((item) => ({
        ...item,
        text: item.text.replace(/制定战略|集团级|全面负责/g, '参与执行'),
      }));
      return next;
    }

    if (years >= 5 && next.seniorityLevel === 'junior') {
      next.seniorityLevel = 'mid';
    }

    return next;
  }

  private extractMetricHints(rawJdText: string): string[] {
    const text = rawJdText.toLowerCase();
    const hints: string[] = [];

    if (/(转化率|留存率|gmv|dau|mau)/i.test(text)) {
      hints.push('转化率/留存率');
    }
    if (/(时效|效率|自动化|人效)/i.test(text)) {
      hints.push('时效/人效');
    }
    if (/(成本|roi|预算)/i.test(text)) {
      hints.push('成本率/ROI');
    }

    return hints.length > 0 ? hints : ['转化率/时效/成本'];
  }

  private cloneParsed(parsed: ParsedJdResult): ParsedJdResult {
    return JSON.parse(JSON.stringify(parsed)) as ParsedJdResult;
  }
}
