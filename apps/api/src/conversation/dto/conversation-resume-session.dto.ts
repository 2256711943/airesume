import { ApiProperty } from '@nestjs/swagger';
import { ConversationContextPackDetailDto } from './conversation-context-pack.dto';
import { ConversationResumeContextDetailDto } from './conversation-resume-context-detail.dto';
import { ConversationMessageDto } from './conversation-response.dto';

/**
 * 恢复会话时返回的聚合载荷。
 */
export class ConversationResumeSessionDto {
  @ApiProperty({ example: 'clyz7abc00000123456789xyz' })
  conversationId!: string;

  @ApiProperty({ type: () => ConversationResumeContextDetailDto })
  resumeContext!: ConversationResumeContextDetailDto;

  @ApiProperty({
    type: () => ConversationContextPackDetailDto,
    required: false,
    nullable: true,
  })
  latestContextPack!: ConversationContextPackDetailDto | null;

  @ApiProperty({ type: [ConversationMessageDto] })
  messages!: ConversationMessageDto[];
}
