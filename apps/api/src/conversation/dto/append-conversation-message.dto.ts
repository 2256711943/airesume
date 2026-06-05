import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

const conversationMessageRoles = ['user', 'assistant', 'system', 'tool'] as const;

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
}
