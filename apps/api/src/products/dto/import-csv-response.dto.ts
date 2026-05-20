import { ApiProperty } from '@nestjs/swagger';

export class ImportCsvResponseDto {
  @ApiProperty({ example: 3 })
  importedCount!: number;
}
