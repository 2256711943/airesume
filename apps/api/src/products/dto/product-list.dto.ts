import { ApiProperty } from '@nestjs/swagger';
import { ProductDto } from './product.dto';

export class ProductListDto {
  @ApiProperty({ type: [ProductDto] })
  items!: ProductDto[];
}
