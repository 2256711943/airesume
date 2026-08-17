import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RewriteJdDto {
  @ApiProperty({
    example:
      '职位名称：高级数据分析师\n岗位职责：负责增长分析体系搭建...\n任职要求：本科及以上，3-5年经验，熟悉SQL/Python。',
    description: '原始 JD 文本',
  })
  @IsString()
  @MinLength(20)
  @MaxLength(20000)
  jdText!: string;

  @ApiProperty({
    required: false,
    default: false,
    description: '是否返回重写评分与重写轨迹（用于调试）',
  })
  @Type(() => Boolean)
  @IsBoolean()
  @IsOptional()
  debug = false;
}
