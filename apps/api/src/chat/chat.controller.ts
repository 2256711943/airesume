import { Body, Controller, Post, Req, Sse, UseGuards } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequestMethod } from '@nestjs/common';
import { Observable } from 'rxjs';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ApiSuccessResponse } from '../common/swagger';
import type { RequestWithId } from '../common/request-id.middleware';
import { ok } from '../common/api-response';
import type { ApiResponse } from '../common/api-response';
import { ChatService } from './chat.service';
import type { ChatSsePayload } from './chat.service';
import { SendChatMessageDto } from './dto/send-chat-message.dto';
import { SendChatMessageResponseDto } from './dto/chat-response.dto';

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
    return ok(
      req.requestId ?? 'unknown',
      await this.chatService.sendMessage(user.id, dto),
    );
  }

  @Sse('message/stream', {
    [METHOD_METADATA]: RequestMethod.POST,
  })
  @ApiOperation({ summary: 'AI Assistant 流式聊天' })
  sendMessageStream(
    @Body() dto: SendChatMessageDto,
    @Req() req: RequestWithId,
    @CurrentUser() user: AuthenticatedUser,
  ): Observable<ChatSsePayload> {
    return this.chatService.sendMessageStream(
      user.id,
      dto,
      req.requestId ?? 'unknown',
    );
  }
}
