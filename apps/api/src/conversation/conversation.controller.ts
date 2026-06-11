import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { ApiResponse } from '../common/api-response';
import { ok } from '../common/api-response';
import type { RequestWithId } from '../common/request-id.middleware';
import { ApiSuccessResponse } from '../common/swagger';
import { ConversationService } from './conversation.service';
import { AppendConversationMessageDto } from './dto/append-conversation-message.dto';
import { ConversationResumeContextDetailDto } from './dto/conversation-resume-context-detail.dto';
import { ConversationResumeContextDto } from './dto/conversation-resume-context-response.dto';
import {
  ConversationDto,
  ConversationListResponseDto,
  ConversationMessageDto,
  ConversationMessageListResponseDto,
} from './dto/conversation-response.dto';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { ListConversationMessagesDto } from './dto/list-conversation-messages.dto';
import { SetConversationResumeContextDto } from './dto/set-conversation-resume-context.dto';

@ApiTags('conversation')
@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationController {
  constructor(private readonly conversationService: ConversationService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new conversation' })
  @ApiSuccessResponse(ConversationDto)
  async createConversation(
    @Body() dto: CreateConversationDto,
    @Req() req: RequestWithId,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiResponse<ConversationDto>> {
    return ok(req.requestId ?? 'unknown', await this.conversationService.createConversation(user.id, dto));
  }

  @Get()
  @ApiOperation({ summary: '获取最近的对话列表' })
  @ApiSuccessResponse(ConversationListResponseDto)
  async listConversations(
    @Req() req: RequestWithId,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiResponse<ConversationListResponseDto>> {
    return ok(req.requestId ?? 'unknown', await this.conversationService.listConversations(user.id));
  }

  @Post(':conversationId/messages')
  @ApiOperation({ summary: 'Append a message into a conversation' })
  @ApiSuccessResponse(ConversationMessageDto)
  async appendMessage(
    @Param('conversationId') conversationId: string,
    @Body() dto: AppendConversationMessageDto,
    @Req() req: RequestWithId,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiResponse<ConversationMessageDto>> {
    return ok(
      req.requestId ?? 'unknown',
      await this.conversationService.appendMessage(user.id, conversationId, dto),
    );
  }

  @Get(':conversationId/messages')
  @ApiOperation({ summary: 'List recent messages from a conversation' })
  @ApiSuccessResponse(ConversationMessageListResponseDto)
  async listMessages(
    @Param('conversationId') conversationId: string,
    @Query() query: ListConversationMessagesDto,
    @Req() req: RequestWithId,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiResponse<ConversationMessageListResponseDto>> {
    return ok(
      req.requestId ?? 'unknown',
      await this.conversationService.listRecentMessages(user.id, conversationId, query.limit),
    );
  }

  @Post(':conversationId/resume-context')
  @ApiOperation({ summary: 'Set active resume library items for a conversation' })
  @ApiSuccessResponse(ConversationResumeContextDto)
  async setResumeContext(
    @Param('conversationId') conversationId: string,
    @Body() dto: SetConversationResumeContextDto,
    @Req() req: RequestWithId,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiResponse<ConversationResumeContextDto>> {
    return ok(
      req.requestId ?? 'unknown',
      await this.conversationService.setResumeContext(user.id, conversationId, dto),
    );
  }

  @Get(':conversationId/resume-context')
  @ApiOperation({ summary: 'Get active resume library items for a conversation' })
  @ApiSuccessResponse(ConversationResumeContextDetailDto)
  async getResumeContext(
    @Param('conversationId') conversationId: string,
    @Req() req: RequestWithId,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiResponse<ConversationResumeContextDetailDto>> {
    return ok(
      req.requestId ?? 'unknown',
      await this.conversationService.getResumeContext(user.id, conversationId),
    );
  }
}
