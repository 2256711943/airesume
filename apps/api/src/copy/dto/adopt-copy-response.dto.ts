import { ApiProperty } from '@nestjs/swagger';

export class AdoptCopyResponseDto {
  @ApiProperty({ example: 'fb_001' })
  feedbackId!: string;
}
