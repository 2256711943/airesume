import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class ConversationContextPackUsageDto {
  @ApiProperty({ example: 4_000 })
  maxTokens!: number;

  @ApiProperty({ example: 500 })
  reservedTokens!: number;

  @ApiProperty({ example: 1_240 })
  usedTokens!: number;

  @ApiProperty({ example: 320 })
  droppedTokens!: number;
}

export class ConversationContextPackSummaryBlockDto {
  @ApiProperty({ example: 'pack_x:block:1' })
  blockId!: string;

  @ApiProperty({ example: 'memory' })
  type!: string;

  @ApiProperty({ example: 'resume' })
  layer!: string;

  @ApiProperty({ example: 1 })
  position!: number;

  @ApiProperty({ example: 'Resume Context' })
  title!: string;

  @ApiProperty({ example: '- Backend engineer profile' })
  content!: string;

  @ApiProperty({ type: [String], example: ['memory-1'] })
  memoryIds!: string[];

  @ApiProperty({ example: 120 })
  tokenEstimate!: number;

  @ApiProperty({ example: false })
  truncated!: boolean;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  metadata?: Record<string, unknown>;
}

export class ConversationContextPackDroppedMemoryDto {
  @ApiProperty({ example: 'memory-2' })
  memoryId!: string;

  @ApiProperty({ example: 'session' })
  layer!: string;

  @ApiProperty({ example: 'pack_token_limit' })
  reason!: string;

  @ApiProperty({ example: 80 })
  tokenEstimate!: number;

  @ApiProperty({ example: 1 })
  priority!: number;

  @ApiProperty({ example: false })
  pinned!: boolean;

  @ApiProperty({
    example: 'Older conversation summary',
    required: false,
    nullable: true,
  })
  summary!: string | null;
}

export class ConversationContextPackSummaryDto {
  @ApiProperty({ example: 'pack_mdy1l4yt_ab12cd34' })
  packId!: string;

  @ApiProperty({ example: 'run-1', required: false, nullable: true })
  runId!: string | null;

  @ApiProperty({
    example: 'interview_guidance',
    required: false,
    nullable: true,
  })
  intent!: string | null;

  @ApiProperty({ example: 4_000 })
  maxTokens!: number;

  @ApiProperty({ type: [String], example: ['resume', 'preference', 'session'] })
  layerOrder!: string[];

  @ApiProperty({ type: () => ConversationContextPackUsageDto })
  usage!: ConversationContextPackUsageDto;

  @ApiProperty({ example: 3 })
  selectedCount!: number;

  @ApiProperty({ example: 2 })
  droppedCount!: number;

  @ApiProperty({ example: 4 })
  summaryBlockCount!: number;

  @ApiProperty({ example: '2026-08-01T10:00:00.000Z' })
  generatedAt!: string;
}

export class ConversationContextPackDetailDto {
  @ApiProperty({ example: 'pack_mdy1l4yt_ab12cd34' })
  packId!: string;

  @ApiProperty({ example: 'clyz7abc00000123456789xyz' })
  conversationId!: string;

  @ApiProperty({ example: 'run-1', required: false, nullable: true })
  runId!: string | null;

  @ApiProperty({
    example: 'interview_guidance',
    required: false,
    nullable: true,
  })
  intent!: string | null;

  @ApiProperty({ example: 4_000 })
  maxTokens!: number;

  @ApiProperty({ type: [String], example: ['resume', 'preference', 'session'] })
  layerOrder!: string[];

  @ApiProperty({ type: [String], example: ['memory-1', 'memory-2'] })
  selectedMemoryIds!: string[];

  @ApiProperty({ type: [String], example: ['memory-3'] })
  droppedMemoryIds!: string[];

  @ApiProperty({ type: [ConversationContextPackDroppedMemoryDto] })
  droppedMemories!: ConversationContextPackDroppedMemoryDto[];

  @ApiProperty({ type: [ConversationContextPackSummaryBlockDto] })
  summaryBlocks!: ConversationContextPackSummaryBlockDto[];

  @ApiProperty({ example: '## Resume Context\n- Backend engineer profile' })
  finalPromptPreview!: string;

  @ApiProperty({ type: () => ConversationContextPackUsageDto })
  usage!: ConversationContextPackUsageDto;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  metadata!: Record<string, unknown> | null;

  @ApiProperty({ example: 2 })
  selectedCount!: number;

  @ApiProperty({ example: 1 })
  droppedCount!: number;

  @ApiProperty({ example: 3 })
  summaryBlockCount!: number;

  @ApiProperty({ example: '2026-08-01T10:00:00.000Z' })
  generatedAt!: string;
}

export class ConversationLatestContextPackDto {
  @ApiProperty({ example: 'clyz7abc00000123456789xyz' })
  conversationId!: string;

  @ApiProperty({
    type: () => ConversationContextPackDetailDto,
    required: false,
    nullable: true,
  })
  contextPack!: ConversationContextPackDetailDto | null;
}

export class ConversationContextPackHistoryDto {
  @ApiProperty({ example: 'clyz7abc00000123456789xyz' })
  conversationId!: string;

  @ApiProperty({ type: [ConversationContextPackSummaryDto] })
  packs!: ConversationContextPackSummaryDto[];
}

export class ListConversationContextPacksDto {
  @ApiProperty({
    example: 20,
    required: false,
    minimum: 1,
    maximum: 50,
    default: 20,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  @IsOptional()
  limit = 20;
}
