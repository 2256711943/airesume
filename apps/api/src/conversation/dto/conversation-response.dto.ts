import { ApiProperty } from '@nestjs/swagger';

export class ConversationDto {
  @ApiProperty({ example: 'clyz7abc00000123456789xyz' })
  id!: string;

  @ApiProperty({ example: 'Resume follow-up chat' })
  title!: string;

  @ApiProperty({ example: 'active' })
  status!: string;

  @ApiProperty({ example: '2026-06-03T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-06-03T10:10:00.000Z' })
  updatedAt!: string;
}

export class ConversationMessageToolCallSummaryDto {
  @ApiProperty({ example: 'jd_parse_and_score' })
  toolName!: string;

  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({ example: 124, required: false, nullable: true })
  latencyMs?: number | null;
}

export class ConversationMessageDto {
  @ApiProperty({ example: 'clyz7msg00000123456789xyz' })
  id!: string;

  @ApiProperty({ example: 'user' })
  role!: string;

  @ApiProperty({ example: 'Please help me improve this resume bullet.' })
  content!: string;

  @ApiProperty({ example: 'resume_diagnosis', required: false, nullable: true })
  intent!: string | null;

  @ApiProperty({
    example: 'resumeDiagnosisAgent',
    required: false,
    nullable: true,
  })
  agentName!: string | null;

  @ApiProperty({
    type: [ConversationMessageToolCallSummaryDto],
    required: false,
    nullable: true,
  })
  toolCallSummary?: ConversationMessageToolCallSummaryDto[] | null;

  @ApiProperty({ example: '2026-06-03T10:01:00.000Z' })
  createdAt!: string;
}

export class ConversationListResponseDto {
  @ApiProperty({ type: [ConversationDto] })
  conversations!: ConversationDto[];
}

export class ConversationMessageListResponseDto {
  @ApiProperty({ example: 'clyz7abc00000123456789xyz' })
  conversationId!: string;

  @ApiProperty({ type: [ConversationMessageDto] })
  messages!: ConversationMessageDto[];
}
