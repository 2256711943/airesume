import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class ImportCsvDto {
  @ApiProperty({
    description: 'CSV plain text content',
    example: 'name,category,selling_points,target_audience,platform,tone',
  })
  @IsString()
  @IsNotEmpty()
  csvContent!: string;
}
