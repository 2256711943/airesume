import { ApiProperty } from '@nestjs/swagger';
import { CopyVariantDto } from './generate-copy-response.dto';

export class RewriteCopyResponseDto {
  @ApiProperty({ example: 'var_002' })
  variantId!: string;

  @ApiProperty({ type: CopyVariantDto })
  variant!: CopyVariantDto;
}
