import { ApiProperty } from '@nestjs/swagger';

export class JudgeJdDimensionsDto {
  @ApiProperty({ example: 82 })
  roleFit!: number;

  @ApiProperty({ example: 78 })
  industryFit!: number;

  @ApiProperty({ example: 85 })
  seniorityFit!: number;

  @ApiProperty({ example: 76 })
  specificity!: number;

  @ApiProperty({ example: 68 })
  measurability!: number;

  @ApiProperty({ example: 90 })
  safety!: number;
}

export class JudgeJdResponseDto {
  @ApiProperty({ example: 79.8 })
  overallScore!: number;

  @ApiProperty({ type: JudgeJdDimensionsDto })
  dimensions!: JudgeJdDimensionsDto;

  @ApiProperty({ type: [String], example: ['low_measurability', 'weak_specificity'] })
  issues!: string[];

  @ApiProperty({ type: [String], example: ['补充职责中的对象与场景', '增加可量化指标表达'] })
  suggestions!: string[];
}
