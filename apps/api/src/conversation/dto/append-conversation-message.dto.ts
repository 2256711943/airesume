import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
  MaxLength,
  Min,
} from 'class-validator';

export class AppendConversationMessageToolCallSummaryDto {
  @ApiProperty({ example: 'jd_parse_and_score' })
  @IsString()
  @MaxLength(80)
  toolName!: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  success!: boolean;

  @ApiProperty({ example: 124, required: false, nullable: true })
  @IsInt()
  @Min(0)
  @IsOptional()
  latencyMs?: number | null;
}

const conversationMessageRoles = [
  'user',
  'assistant',
  'system',
  'tool',
] as const;

export class AppendConversationMessageDto {
  @ApiProperty({ example: 'user', enum: conversationMessageRoles })
  @IsIn(conversationMessageRoles)
  role!: (typeof conversationMessageRoles)[number];

  @ApiProperty({ example: 'Please help me improve this resume bullet.' })
  @IsString()
  @MaxLength(5000)
  content!: string;

  @ApiProperty({ example: 'resume_diagnosis', required: false })
  @IsString()
  @MaxLength(80)
  @IsOptional()
  intent?: string;

  @ApiProperty({ example: 'resumeDiagnosisAgent', required: false })
  @IsString()
  @MaxLength(80)
  @IsOptional()
  agentName?: string;

  @ApiProperty({
    type: [AppendConversationMessageToolCallSummaryDto],
    required: false,
    nullable: true,
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AppendConversationMessageToolCallSummaryDto)
  @IsOptional()
  toolCallSummary?: AppendConversationMessageToolCallSummaryDto[] | null;
}
