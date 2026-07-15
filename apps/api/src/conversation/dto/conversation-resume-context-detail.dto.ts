import { ApiProperty } from '@nestjs/swagger';

export class ConversationResumeContextProjectDto {
  @ApiProperty({ example: 'AI Resume Assistant' })
  name!: string;

  @ApiProperty({ type: [String], example: ['Designed SSE output'] })
  highlights!: string[];
}

export class ConversationResumeContextExperienceDto {
  @ApiProperty({ example: 'Acme Corp' })
  company!: string;

  @ApiProperty({ example: 'Backend Engineer' })
  role!: string;

  @ApiProperty({ type: [String], example: ['Built API gateway'] })
  highlights!: string[];
}

export class ConversationResumeContextSummaryDto {
  @ApiProperty({ example: 'clyz7resume00000123456789xyz' })
  id!: string;

  @ApiProperty({ example: 'Backend Resume' })
  title!: string;

  @ApiProperty({ example: 'Backend engineer profile' })
  summary!: string;

  @ApiProperty({ example: 'hybrid' })
  sourceMode!: string;

  @ApiProperty({ type: [String], example: ['NestJS', 'Node.js', 'PostgreSQL'] })
  keySkills!: string[];

  @ApiProperty({ type: [ConversationResumeContextProjectDto] })
  keyProjects!: ConversationResumeContextProjectDto[];

  @ApiProperty({ type: [ConversationResumeContextExperienceDto] })
  keyExperiences!: ConversationResumeContextExperienceDto[];
}

export class ConversationResumeContextDetailDto {
  @ApiProperty({ example: 'clyz7abc00000123456789xyz' })
  conversationId!: string;

  @ApiProperty({ type: [String], example: ['clyz7resume00000123456789xyz'] })
  resumeLibraryItemIds!: string[];

  @ApiProperty({ example: 1 })
  selectedCount!: number;

  @ApiProperty({ example: 'selected_resume_item_ids' })
  slotKey!: string;

  @ApiProperty({ type: [ConversationResumeContextSummaryDto] })
  activeResumeSummaries!: ConversationResumeContextSummaryDto[];

  @ApiProperty({
    example: {
      summary: 'user: 想切到数据分析 | assistant: 建议先补数据建模基础',
      messageCount: 2,
      lastMessageAt: '2026-06-06T00:00:01.000Z',
    },
    required: false,
    nullable: true,
  })
  conversationHistorySummary?: {
    summary: string;
    messageCount: number;
    lastMessageAt: string | null;
  } | null;
}
