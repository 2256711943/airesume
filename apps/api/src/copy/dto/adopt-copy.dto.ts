import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class AdoptCopyDto {
  @ApiProperty({ example: true })
  @Type(() => Boolean)
  @IsBoolean()
  adopted!: boolean;

  @ApiProperty({ type: [String], example: ['hook_strong', 'platform_fit_good'] })
  @IsArray()
  @IsString({ each: true })
  reasonTags!: string[];

  @ApiProperty({ example: '标题抓人，适合抖音', required: false })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  comment?: string;
}
