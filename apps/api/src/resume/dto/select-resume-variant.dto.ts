import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

class SelectedResumeExperienceDto {
  @ApiProperty({ example: 'Acme Corp' })
  @IsString()
  @MaxLength(100)
  company!: string;

  @ApiProperty({ example: 'Backend Engineer' })
  @IsString()
  @MaxLength(100)
  role!: string;

  @ApiProperty({
    type: [String],
    example: ['Built API gateway', 'Reduced p95 latency by 28%'],
  })
  @IsArray()
  @IsString({ each: true })
  highlights!: string[];
}

class SelectedResumeProjectDto {
  @ApiProperty({ example: 'AI Resume Assistant' })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    type: [String],
    example: ['Designed SSE stream output', 'Improved completion success rate'],
  })
  @IsArray()
  @IsString({ each: true })
  highlights!: string[];
}

class SelectedResumeVariantSnapshotDto {
  @ApiProperty({ example: 'Backend engineer with 5 years...' })
  @IsString()
  summary!: string;

  @ApiProperty({ type: [SelectedResumeExperienceDto] })
  @Type(() => SelectedResumeExperienceDto)
  @ValidateNested({ each: true })
  @IsArray()
  experience!: SelectedResumeExperienceDto[];

  @ApiProperty({ type: [SelectedResumeProjectDto] })
  @Type(() => SelectedResumeProjectDto)
  @ValidateNested({ each: true })
  @IsArray()
  projects!: SelectedResumeProjectDto[];

  @ApiProperty({ type: [String], example: ['Node.js', 'NestJS', 'Redis'] })
  @IsArray()
  @IsString({ each: true })
  skills!: string[];
}

class SelectedVariantScoreSnapshotDto {
  @ApiProperty({ example: 82, required: false })
  @IsOptional()
  @Type(() => Number)
  overallScore?: number;

  @ApiProperty({ example: 78, required: false })
  @IsOptional()
  @Type(() => Number)
  ruleScore?: number;

  @ApiProperty({ example: 84, required: false })
  @IsOptional()
  @Type(() => Number)
  llmScore?: number;
}

export class SelectResumeVariantDto {
  @ApiProperty({ example: 'req_1748512351001' })
  @IsString()
  requestId!: string;

  @ApiProperty({
    example: 'technical',
    enum: ['technical', 'business', 'hybrid'],
  })
  @IsIn(['technical', 'business', 'hybrid'])
  mode!: 'technical' | 'business' | 'hybrid';

  @ApiProperty({ example: true })
  @Type(() => Boolean)
  @IsBoolean()
  addToLibrary!: boolean;

  @ApiProperty({ type: SelectedResumeVariantSnapshotDto })
  @Type(() => SelectedResumeVariantSnapshotDto)
  @ValidateNested()
  @IsObject()
  variant!: SelectedResumeVariantSnapshotDto;

  @ApiProperty({ type: SelectedVariantScoreSnapshotDto, required: false })
  @Type(() => SelectedVariantScoreSnapshotDto)
  @ValidateNested()
  @IsOptional()
  scoreSnapshot?: SelectedVariantScoreSnapshotDto;

  @ApiProperty({ example: 'resume-rewrite-v1', required: false })
  @IsString()
  @IsOptional()
  promptVersion?: string;
}
