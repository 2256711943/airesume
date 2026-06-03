import { ApiProperty } from '@nestjs/swagger';

export class SelectResumeVariantResponseDto {
  @ApiProperty({ example: 'evt_01' })
  eventId!: string;

  @ApiProperty({ example: true })
  addToLibrary!: boolean;

  @ApiProperty({ example: 'lib_01', required: false })
  libraryItemId?: string;
}
