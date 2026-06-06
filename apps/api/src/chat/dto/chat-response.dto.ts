import { ApiProperty } from '@nestjs/swagger';
import { ConversationMessageDto } from '../../conversation/dto/conversation-response.dto';

export class ChatRouteDecisionDto {
  @ApiProperty({ example: 'resume_diagnosis' })
  intent!: string;

  @ApiProperty({ example: 'resumeDiagnosisAgent' })
  selectedAgent!: string;

  @ApiProperty({ example: '命中简历优化、诊断或岗位匹配类关键词' })
  reason!: string;
}

export class SendChatMessageResponseDto {
  @ApiProperty({ example: 'clyz7abc00000123456789xyz' })
  conversationId!: string;

  @ApiProperty({ example: 'clyz7run00000123456789xyz' })
  agentRunId!: string;

  @ApiProperty({ example: true })
  createdConversation!: boolean;

  @ApiProperty({ type: ConversationMessageDto })
  message!: ConversationMessageDto;

  @ApiProperty({ type: ConversationMessageDto, required: false })
  assistantMessage?: ConversationMessageDto;

  @ApiProperty({ type: ChatRouteDecisionDto })
  routeDecision!: ChatRouteDecisionDto;

  @ApiProperty({ type: [ConversationMessageDto] })
  recentMessages!: ConversationMessageDto[];
}
