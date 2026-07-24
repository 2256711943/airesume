import { ApiProperty } from '@nestjs/swagger';

export class ResumeExperienceResponseDto {
  @ApiProperty({ example: 'Acme Corp' })
  company!: string;

  @ApiProperty({ example: 'Backend Engineer' })
  role!: string;

  @ApiProperty({
    type: [String],
    example: ['Built API gateway', 'Reduced p95 latency by 28%'],
  })
  highlights!: string[];
}

export class ResumeProjectResponseDto {
  @ApiProperty({ example: 'AI Resume Assistant' })
  name!: string;

  @ApiProperty({
    type: [String],
    example: ['Designed SSE stream output', 'Improved completion success rate'],
  })
  highlights!: string[];
}

export class ResumeVariantScoreDimensionsDto {
  @ApiProperty({ example: 82 })
  readability!: number;

  @ApiProperty({ example: 76 })
  measurability!: number;

  @ApiProperty({ example: 88 })
  roleRelevance!: number;
}

export class ResumeVariantScoreDto {
  @ApiProperty({ example: 80 })
  ruleScore!: number;

  @ApiProperty({ example: 78 })
  llmScore!: number;

  @ApiProperty({ example: 78.8 })
  overallScore!: number;

  @ApiProperty({ type: ResumeVariantScoreDimensionsDto })
  dimensions!: ResumeVariantScoreDimensionsDto;

  @ApiProperty({ type: [String], example: ['low_measurability'] })
  issues!: string[];

  @ApiProperty({
    type: [String],
    example: ['Add 1-2 quantified outcomes in project highlights.'],
  })
  suggestions!: string[];
}

export class ResumeHighlightDiffDto {
  @ApiProperty({ example: 'Built API gateway' })
  before!: string;

  @ApiProperty({
    example: 'Built API gateway that reduced service p95 latency by 28%',
  })
  after!: string;

  @ApiProperty({ example: true })
  changed!: boolean;
}

export class ResumeVariantDiffDto {
  @ApiProperty({ type: [ResumeHighlightDiffDto] })
  experienceHighlights!: ResumeHighlightDiffDto[];

  @ApiProperty({ type: [ResumeHighlightDiffDto] })
  projectHighlights!: ResumeHighlightDiffDto[];
}

export class ResumeVariantDto {
  @ApiProperty({ example: 'v1' })
  id!: string;

  @ApiProperty({ example: 'technical', required: false })
  mode?: 'technical' | 'business' | 'hybrid';

  @ApiProperty({ example: 1, required: false })
  rank?: number;

  @ApiProperty({ example: 'resume-rewrite-technical-v1', required: false })
  promptVersion?: string;

  @ApiProperty({ example: 81.3, required: false })
  finalScore?: number;

  @ApiProperty({ example: 2.5, required: false })
  feedbackBoost?: number;

  @ApiProperty({ example: 'Backend engineer with 5 years...' })
  summary!: string;

  @ApiProperty({ type: [ResumeExperienceResponseDto] })
  experience!: ResumeExperienceResponseDto[];

  @ApiProperty({ type: [ResumeProjectResponseDto] })
  projects!: ResumeProjectResponseDto[];

  @ApiProperty({ type: [String], example: ['Node.js', 'NestJS', 'Redis'] })
  skills!: string[];

  @ApiProperty({ type: ResumeVariantScoreDto, required: false })
  scores?: ResumeVariantScoreDto;

  @ApiProperty({ type: ResumeVariantDiffDto, required: false })
  diff?: ResumeVariantDiffDto;
}

export class GenerateResumeResponseDto {
  @ApiProperty({ example: 'req_001' })
  requestId!: string;

  @ApiProperty({
    example: {
      technical: 'resume-rewrite-technical-v1',
      business: 'resume-rewrite-business-v1',
      hybrid: 'resume-rewrite-hybrid-v1',
    },
    required: false,
  })
  activePromptVersions?: Record<string, string>;

  @ApiProperty({ type: [ResumeVariantDto] })
  variants!: ResumeVariantDto[];
}
