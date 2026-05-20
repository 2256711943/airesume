import { ApiProperty } from '@nestjs/swagger';

export class RewriteCopyResponseDto {
  @ApiProperty({ example: 'var_002' })
  variantId!: string;
}
