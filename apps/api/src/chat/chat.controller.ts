import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { ApiResponse } from '../common/api-response';
import { ok } from '../common/api-response';
import type { RequestWithId } from '../common/request-id.middleware';
import { ApiSuccessResponse } from '../common/swagger';
import { ChatService } from './chat.service';
import { SendChatMessageResponseDto } from './dto/chat-response.dto';
import { SendChatMessageDto } from './dto/send-chat-message.dto';

@ApiTags('chat')
@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('message')
  @ApiOperation({ summary: '发送一条聊天消息并返回最近对话历史' })
  @ApiSuccessResponse(SendChatMessageResponseDto)
  async sendMessage(
    @Body() dto: SendChatMessageDto,
    @Req() req: RequestWithId,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiResponse<SendChatMessageResponseDto>> {
    return ok(req.requestId ?? 'unknown', await this.chatService.sendMessage(user.id, dto));
  }
}
