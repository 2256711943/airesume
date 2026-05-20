import { ApiProperty } from '@nestjs/swagger';

export class CopyVariantDto {
  @ApiProperty({ example: 'var_001' })
  id!: string;

  @ApiProperty({ example: '三天提亮，素颜也能发光' })
  title!: string;

  @ApiProperty({ example: '高浓度玻尿酸，轻薄不黏腻，早晚都能用。' })
  body!: string;

  @ApiProperty({ type: [String], example: ['补水快', '好吸收'] })
  bullets!: string[];

  @ApiProperty({ example: '立即下单，今晚就开始焕亮计划' })
  cta!: string;
}

export class GenerateCopyResponseDto {
  @ApiProperty({ example: 'req_001' })
  requestId!: string;

  @ApiProperty({ example: 'task_001' })
  taskId!: string;

  @ApiProperty({ type: [CopyVariantDto] })
  variants!: CopyVariantDto[];
}
