import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateProductDto {
  @ApiProperty({ example: '抗皱精华液' })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: 'beauty' })
  @IsString()
  @MaxLength(50)
  category!: string;

  @ApiProperty({
    type: [String],
    example: ['玻尿酸补水', '7天改善细纹'],
    minItems: 1,
    maxItems: 20,
  })
  @Type(() => String)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  sellingPoints!: string[];

  @ApiProperty({ example: '25-35女性白领' })
  @IsString()
  @MaxLength(100)
  targetAudience!: string;

  @ApiProperty({ example: 'douyin' })
  @IsString()
  @MaxLength(30)
  platform!: string;

  @ApiProperty({ example: 'direct' })
  @IsString()
  @MaxLength(30)
  tone!: string;

  @ApiProperty({
    type: [String],
    example: ['最便宜', '100%治愈'],
    required: false,
    default: [],
  })
  @Type(() => String)
  @IsArray()
  @IsString({ each: true })
  bannedTerms: string[] = [];
}
