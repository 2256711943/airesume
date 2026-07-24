import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString, MaxLength } from 'class-validator';

export class SetConversationResumeContextDto {
  @ApiProperty({ type: [String], example: ['clyz7resume00000123456789xyz'] })
  @IsArray()
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  resumeLibraryItemIds!: string[];
}
