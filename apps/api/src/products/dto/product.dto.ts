import { ApiProperty } from '@nestjs/swagger';

export class ProductDto {
  @ApiProperty({ example: 'prod_001' })
  id!: string;

  @ApiProperty({ example: '抗皱精华液' })
  name!: string;

  @ApiProperty({ example: 'beauty' })
  category!: string;

  @ApiProperty({ type: [String], example: ['玻尿酸补水', '7天改善细纹'] })
  sellingPoints!: string[];

  @ApiProperty({ example: '25-35女性白领' })
  targetAudience!: string;

  @ApiProperty({ example: 'douyin' })
  platform!: string;

  @ApiProperty({ example: 'direct' })
  tone!: string;

  @ApiProperty({ type: [String], example: ['最便宜', '100%治愈'] })
  bannedTerms!: string[];
}
