import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ResumeExperienceDto {
  @ApiProperty({ example: 'Acme Corp' })
  @IsString()
  @MaxLength(100)
  company!: string;

  @ApiProperty({ example: 'Backend Engineer' })
  @IsString()
  @MaxLength(100)
  role!: string;

  @ApiProperty({ type: [String], example: ['Built API gateway', 'Reduced p95 latency by 28%'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @IsString({ each: true })
  highlights!: string[];
}

export class ResumeProjectDto {
  @ApiProperty({ example: 'AI Resume Assistant' })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiProperty({ type: [String], example: ['Designed SSE stream output', 'Improved completion success rate'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @IsString({ each: true })
  highlights!: string[];
}

export class ResumeProfileDto {
  @ApiProperty({ example: 'Alex Chen' })
  @IsString()
  @MaxLength(80)
  fullName!: string;

  @ApiProperty({ example: '5 years building backend systems' })
  @IsString()
  @MaxLength(500)
  background!: string;

  @ApiProperty({ type: [String], example: ['Node.js', 'NestJS', 'PostgreSQL', 'Redis'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(40)
  @IsString({ each: true })
  skills!: string[];

  @ApiProperty({ type: [ResumeExperienceDto], required: false, default: [] })
  @Type(() => ResumeExperienceDto)
  @IsArray()
  @ValidateNested({ each: true })
  @IsOptional()
  experiences: ResumeExperienceDto[] = [];

  @ApiProperty({ type: [ResumeProjectDto], required: false, default: [] })
  @Type(() => ResumeProjectDto)
  @IsArray()
  @ValidateNested({ each: true })
  @IsOptional()
  projects: ResumeProjectDto[] = [];
}

export class ResumeTargetJobDto {
  @ApiProperty({ example: 'Senior Backend Engineer' })
  @IsString()
  @MaxLength(100)
  title!: string;

  @ApiProperty({ example: 'Own backend architecture, reliability, and performance.', required: false })
  @IsString()
  @MaxLength(2000)
  @IsOptional()
  description = '';

  @ApiProperty({ type: [String], example: ['Microservices', 'Performance', 'Observability'], required: false, default: [] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  mustHaveSkills: string[] = [];
}

export class GenerateResumeDto {
  @ApiProperty({ type: ResumeProfileDto })
  @Type(() => ResumeProfileDto)
  @ValidateNested()
  @IsObject()
  profile!: ResumeProfileDto;

  @ApiProperty({ type: ResumeTargetJobDto })
  @Type(() => ResumeTargetJobDto)
  @ValidateNested()
  @IsObject()
  targetJob!: ResumeTargetJobDto;

  @ApiProperty({ example: 'professional', required: false, default: 'professional' })
  @IsString()
  @IsOptional()
  tone = 'professional';

  @ApiProperty({ example: 'zh-CN', required: false, default: 'zh-CN' })
  @IsString()
  @IsOptional()
  language = 'zh-CN';

  @ApiProperty({ example: 1, minimum: 1, maximum: 3, required: false, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3)
  @IsOptional()
  variants = 1;
}

