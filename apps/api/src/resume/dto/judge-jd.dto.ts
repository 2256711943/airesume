import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class JudgeJdDto {
  @ApiProperty({
    example:
      '职位名称：高级数据分析师\n岗位职责：负责增长分析体系搭建...\n任职要求：本科及以上，3-5年经验，熟悉SQL/Python。',
    description: '原始 JD 文本',
  })
  @IsString()
  @MinLength(20)
  @MaxLength(20000)
  jdText!: string;
}
