import { ApiProperty } from '@nestjs/swagger';

export class ParsedJdBasicDto {
  @ApiProperty({ example: '高级数据分析师' })
  jobTitleRaw!: string;

  @ApiProperty({ example: '高级数据分析师' })
  jobTitleNorm!: string;

  @ApiProperty({ example: '上海', required: false })
  city?: string;

  @ApiProperty({ example: '本科', required: false })
  educationMin?: string;

  @ApiProperty({ example: 3, required: false })
  yearsExpMin?: number;

  @ApiProperty({ example: 5, required: false })
  yearsExpMax?: number;
}

export class ParsedJdResponsibilityDto {
  @ApiProperty({ example: '负责搭建用户增长分析体系，跟踪转化率与留存率。' })
  text!: string;

  @ApiProperty({ example: '负责' })
  action!: string;

  @ApiProperty({ example: '搭建用户增长分析体系，跟踪转化率与留存率。' })
  object!: string;

  @ApiProperty({ example: '负责搭建用户增长分析体系，跟踪转化率与留存率。' })
  evidenceSpan!: string;

  @ApiProperty({ example: 0.92 })
  confidence!: number;
}

export class ParsedJdRequirementDto {
  @ApiProperty({ example: '本科及以上学历，3-5年数据分析经验。' })
  text!: string;

  @ApiProperty({ example: '经验' })
  type!: string;

  @ApiProperty({ example: '本科及以上学历，3-5年数据分析经验。' })
  evidenceSpan!: string;

  @ApiProperty({ example: 0.9 })
  confidence!: number;
}

export class ParsedJdBusinessGoalDto {
  @ApiProperty({ example: '增长' })
  goalType!: string;

  @ApiProperty({ example: '围绕“增长”推进目标达成' })
  text!: string;

  @ApiProperty({ example: '转化率/留存率', required: false })
  metricHint?: string;

  @ApiProperty({ example: '负责搭建用户增长分析体系，跟踪转化率与留存率。' })
  evidenceSpan!: string;

  @ApiProperty({ example: 0.8 })
  confidence!: number;
}

export class ParseJdJudgeSnapshotDto {
  @ApiProperty({ example: 71.4 })
  overallScore!: number;

  @ApiProperty({
    type: Object,
    example: {
      roleFit: 80,
      industryFit: 74,
      seniorityFit: 68,
      specificity: 72,
      measurability: 66,
      safety: 90,
    },
  })
  dimensions!: {
    roleFit: number;
    industryFit: number;
    seniorityFit: number;
    specificity: number;
    measurability: number;
    safety: number;
  };

  @ApiProperty({ type: [String], example: ['low_measurability'] })
  issues!: string[];

  @ApiProperty({ type: [String], example: ['增加可量化指标表达'] })
  suggestions!: string[];
}

export class ParseJdDebugTraceDto {
  @ApiProperty({ example: true })
  rewriteEnabled!: boolean;

  @ApiProperty({ example: true })
  rewriteApplied!: boolean;

  @ApiProperty({ type: [String], example: ['low_measurability'] })
  rewriteTriggers!: string[];

  @ApiProperty({ type: ParseJdJudgeSnapshotDto })
  beforeJudge!: ParseJdJudgeSnapshotDto;

  @ApiProperty({ required: false, type: ParseJdJudgeSnapshotDto })
  afterJudge?: ParseJdJudgeSnapshotDto;
}

export class ParseJdResponseDto {
  @ApiProperty({ type: ParsedJdBasicDto })
  basic!: ParsedJdBasicDto;

  @ApiProperty({ type: [ParsedJdResponsibilityDto] })
  responsibilities!: ParsedJdResponsibilityDto[];

  @ApiProperty({
    type: 'object',
    properties: {
      must: {
        type: 'array',
        items: { $ref: '#/components/schemas/ParsedJdRequirementDto' },
      },
      preferred: {
        type: 'array',
        items: { $ref: '#/components/schemas/ParsedJdRequirementDto' },
      },
    },
  })
  requirements!: {
    must: ParsedJdRequirementDto[];
    preferred: ParsedJdRequirementDto[];
  };

  @ApiProperty({
    type: 'object',
    properties: {
      hardSkills: { type: 'array', items: { type: 'string' } },
      softSkills: { type: 'array', items: { type: 'string' } },
      tools: { type: 'array', items: { type: 'string' } },
      certificates: { type: 'array', items: { type: 'string' } },
    },
  })
  skills!: {
    hardSkills: string[];
    softSkills: string[];
    tools: string[];
    certificates: string[];
  };

  @ApiProperty({ type: [ParsedJdBusinessGoalDto] })
  businessGoals!: ParsedJdBusinessGoalDto[];

  @ApiProperty({ type: [String] })
  keywords!: string[];

  @ApiProperty({ example: 'mid' })
  seniorityLevel!: string;

  @ApiProperty({
    type: 'object',
    properties: {
      parseVersion: { type: 'string', example: 'jd-parser-v1' },
      missingFields: { type: 'array', items: { type: 'string' } },
      warnings: { type: 'array', items: { type: 'string' } },
    },
  })
  quality!: {
    parseVersion: string;
    missingFields: string[];
    warnings: string[];
  };

  @ApiProperty({ required: false, type: ParseJdDebugTraceDto })
  debugTrace?: {
    rewriteEnabled: boolean;
    rewriteApplied: boolean;
    rewriteTriggers: string[];
    beforeJudge: {
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
    };
    afterJudge?: {
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
    };
  };
}
