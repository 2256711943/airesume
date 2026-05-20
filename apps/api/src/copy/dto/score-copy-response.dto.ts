import { ApiProperty } from '@nestjs/swagger';

export class ScoreCopyResponseDto {
  @ApiProperty({ example: 78 })
  ruleScore!: number;

  @ApiProperty({ example: 74 })
  llmScore!: number;

  @ApiProperty({ example: 75.6 })
  overallScore!: number;

  @ApiProperty({
    example: {
      hook: 70,
      clarity: 80,
      specificity: 65,
      actionability: 72,
      platform_fit: 83,
    },
  })
  dimensions!: Record<string, number>;
}
