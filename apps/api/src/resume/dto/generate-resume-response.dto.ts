import { ApiProperty } from '@nestjs/swagger';

export class ResumeExperienceResponseDto {
  @ApiProperty({ example: 'Acme Corp' })
  company!: string;

  @ApiProperty({ example: 'Backend Engineer' })
  role!: string;

  @ApiProperty({ type: [String], example: ['Built API gateway', 'Reduced p95 latency by 28%'] })
  highlights!: string[];
}

export class ResumeProjectResponseDto {
  @ApiProperty({ example: 'AI Resume Assistant' })
  name!: string;

  @ApiProperty({ type: [String], example: ['Designed SSE stream output', 'Improved completion success rate'] })
  highlights!: string[];
}

export class ResumeVariantDto {
  @ApiProperty({ example: 'v1' })
  id!: string;

  @ApiProperty({ example: 'Backend engineer with 5 years...' })
  summary!: string;

  @ApiProperty({ type: [ResumeExperienceResponseDto] })
  experience!: ResumeExperienceResponseDto[];

  @ApiProperty({ type: [ResumeProjectResponseDto] })
  projects!: ResumeProjectResponseDto[];

  @ApiProperty({ type: [String], example: ['Node.js', 'NestJS', 'Redis'] })
  skills!: string[];
}

export class GenerateResumeResponseDto {
  @ApiProperty({ example: 'req_001' })
  requestId!: string;

  @ApiProperty({ type: [ResumeVariantDto] })
  variants!: ResumeVariantDto[];
}

