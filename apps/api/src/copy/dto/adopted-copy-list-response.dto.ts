import { ApiProperty } from '@nestjs/swagger';

export class AdoptedProductDto {
  @ApiProperty({ example: 'prod_001' })
  id!: string;

  @ApiProperty({ example: '抗皱精华液' })
  name!: string;

  @ApiProperty({ example: 'beauty' })
  category!: string;
}

export class AdoptedCopyDto {
  @ApiProperty({ example: 'copy_001' })
  id!: string;

  @ApiProperty({ example: '三天提亮，素颜也能发光' })
  title!: string;

  @ApiProperty({ example: '高浓度玻尿酸精华，轻薄不黏腻，早晚都能用。' })
  body!: string;

  @ApiProperty({ type: [String], example: ['补水快', '好吸收'] })
  bullets!: string[];

  @ApiProperty({ example: '立即下单，今晚开始焕亮计划' })
  cta!: string;
}

export class AdoptedCopyItemDto {
  @ApiProperty({ example: 'fb_001' })
  feedbackId!: string;

  @ApiProperty({ type: AdoptedProductDto })
  product!: AdoptedProductDto;

  @ApiProperty({ type: AdoptedCopyDto })
  copy!: AdoptedCopyDto;

  @ApiProperty({ type: [String], example: ['hook_strong', 'platform_fit_good'] })
  reasonTags!: string[];

  @ApiProperty({ example: '标题抓人，适合抖音', required: false })
  comment?: string;

  @ApiProperty({ example: '2026-05-23T10:00:00.000Z' })
  adoptedAt!: string;
}

export class AdoptedCopyListResponseDto {
  @ApiProperty({ type: [AdoptedCopyItemDto] })
  items!: AdoptedCopyItemDto[];
}
