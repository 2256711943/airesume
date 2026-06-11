import { ApiProperty } from '@nestjs/swagger';

export class ConversationResumeContextDto {
  @ApiProperty({ example: 'clyz7abc00000123456789xyz' })
  conversationId!: string;

  @ApiProperty({ type: [String], example: ['clyz7resume00000123456789xyz'] })
  resumeLibraryItemIds!: string[];

  @ApiProperty({ example: 'selected_resume_item_ids' })
  slotKey!: string;
}

