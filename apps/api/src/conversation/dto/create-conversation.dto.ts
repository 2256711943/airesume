import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateConversationDto {
  @ApiProperty({ example: 'Resume follow-up chat', required: false })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  title?: string;
}
