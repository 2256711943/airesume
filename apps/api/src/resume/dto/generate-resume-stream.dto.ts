import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class GenerateResumeStreamDto {
  @ApiProperty({ description: 'JSON string of profile object' })
  @IsString()
  profile!: string;

  @ApiProperty({ description: 'JSON string of targetJob object' })
  @IsString()
  targetJob!: string;

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

  @ApiProperty({ example: 'resume_stream_req-1', required: false })
  @IsString()
  @IsOptional()
  streamKey?: string;

  @ApiProperty({ example: 12, minimum: 0, required: false, default: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  sinceSeq = 0;
}
