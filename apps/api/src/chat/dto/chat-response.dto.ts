import { ApiProperty } from '@nestjs/swagger';
import { ConversationMessageDto } from '../../conversation/dto/conversation-response.dto';

export class ChatDisplayPreferenceDto {
  @ApiProperty({ example: 'language' })
  category!: string;

  @ApiProperty({ example: 'response_language' })
  key!: string;

  @ApiProperty({ example: 'zh-CN' })
  normalizedValue!: string;

  @ApiProperty({ example: 'user_text' })
  sourceKind!: string;

  @ApiProperty({
    example: 'Display preference: response_language=zh-CN',
    required: false,
    nullable: true,
  })
  summary!: string | null;

  @ApiProperty({ example: '2026-08-01T10:00:00.000Z' })
  updatedAt!: string;
}

export class ChatRouteDecisionRuleDto {
  @ApiProperty({ example: 'interview_keywords' })
  ruleId!: string;

  @ApiProperty({ example: '面试指导关键词' })
  label!: string;

  @ApiProperty({ type: [String], example: ['自我介绍', 'mock'] })
  matchedKeywords!: string[];
}

export class ChatRouteDecisionDto {
  @ApiProperty({ example: 'resume_diagnosis' })
  intent!: string;

  @ApiProperty({ example: 'resumeDiagnosisAgent' })
  selectedAgent!: string;

  @ApiProperty({ example: '命中简历优化、诊断或岗位匹配类关键词' })
  reason!: string;

  @ApiProperty({ example: 0.93, minimum: 0, maximum: 1 })
  confidence!: number;

  @ApiProperty({ example: false })
  fallbackUsed!: boolean;

  @ApiProperty({ type: [ChatRouteDecisionRuleDto] })
  matchedRules!: ChatRouteDecisionRuleDto[];
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

  @ApiProperty({ type: [ChatDisplayPreferenceDto] })
  displayPreferences!: ChatDisplayPreferenceDto[];

  @ApiProperty({ type: [ConversationMessageDto] })
  recentMessages!: ConversationMessageDto[];
}
