import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class SendChatMessageDto {
  @ApiProperty({ example: 'clyz7abc00000123456789xyz', required: false })
  @IsString()
  @MaxLength(40)
  @IsOptional()
  conversationId?: string;

  @ApiProperty({ example: '请根据我当前简历给出优化建议' })
  @IsString()
  @MaxLength(5000)
  message!: string;

  @ApiProperty({ example: 'Resume follow-up chat', required: false })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  title?: string;

  @ApiProperty({ example: 10, required: false, minimum: 1, maximum: 20, default: 10 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  @IsOptional()
  historyLimit = 10;
}
