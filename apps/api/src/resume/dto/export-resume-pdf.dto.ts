import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class ExportResumePdfMarginDto {
  @ApiProperty({ example: '20px', required: false, default: '20px' })
  @IsString()
  @IsOptional()
  top = '20px';

  @ApiProperty({ example: '20px', required: false, default: '20px' })
  @IsString()
  @IsOptional()
  right = '20px';

  @ApiProperty({ example: '20px', required: false, default: '20px' })
  @IsString()
  @IsOptional()
  bottom = '20px';

  @ApiProperty({ example: '20px', required: false, default: '20px' })
  @IsString()
  @IsOptional()
  left = '20px';
}

export class ExportResumePdfOptionsDto {
  @ApiProperty({ example: 'A4', required: false, default: 'A4' })
  @IsIn(['A4'])
  @IsOptional()
  format = 'A4';

  @ApiProperty({ type: ExportResumePdfMarginDto, required: false })
  @Type(() => ExportResumePdfMarginDto)
  @ValidateNested()
  @IsObject()
  @IsOptional()
  margin = new ExportResumePdfMarginDto();

  @ApiProperty({ example: true, required: false, default: true })
  @IsBoolean()
  @IsOptional()
  printBackground = true;

  @ApiProperty({ example: true, required: false, default: true })
  @IsBoolean()
  @IsOptional()
  preferCSSPageSize = true;

  @ApiProperty({ example: false, required: false, default: false })
  @IsBoolean()
  @IsOptional()
  displayHeaderFooter = false;

  @ApiProperty({ example: '', required: false, default: '' })
  @IsString()
  @MaxLength(4096)
  @IsOptional()
  headerTemplate = '';

  @ApiProperty({ example: '', required: false, default: '' })
  @IsString()
  @MaxLength(4096)
  @IsOptional()
  footerTemplate = '';
}

export class ExportResumePdfDto {
  @ApiProperty({
    example:
      '<!doctype html><html><head><style>...</style></head><body>...</body></html>',
  })
  @IsString()
  html!: string;

  @ApiProperty({
    example: 'resume-technical-v1',
    required: false,
    description: 'If omitted, the server will generate a safe default name.',
  })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  fileName?: string;

  @ApiProperty({ type: ExportResumePdfOptionsDto, required: false })
  @Type(() => ExportResumePdfOptionsDto)
  @ValidateNested()
  @IsObject()
  @IsOptional()
  options = new ExportResumePdfOptionsDto();
}
