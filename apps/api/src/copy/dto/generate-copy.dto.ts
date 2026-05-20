import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class GenerateCopyDto {
  @ApiProperty({ example: 'prod_001' })
  @IsString()
  productId!: string;

  @ApiProperty({ example: 'douyin' })
  @IsString()
  platform!: string;

  @ApiProperty({ example: 'direct' })
  @IsString()
  tone!: string;

  @ApiProperty({ example: 3, minimum: 1, maximum: 5, required: false, default: 3 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  @IsOptional()
  variants = 3;
}
