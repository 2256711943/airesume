import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Observable } from 'rxjs';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ok } from '../common/api-response';
import type { ApiResponse } from '../common/api-response';
import type { RequestWithId } from '../common/request-id.middleware';
import { ApiSuccessResponse } from '../common/swagger';
import { AdoptCopyDto } from './dto/adopt-copy.dto';
import { AdoptedCopyListResponseDto } from './dto/adopted-copy-list-response.dto';
import { AdoptCopyResponseDto } from './dto/adopt-copy-response.dto';
import { GenerateCopyDto } from './dto/generate-copy.dto';
import { GenerateCopyResponseDto } from './dto/generate-copy-response.dto';
import { RewriteCopyResponseDto } from './dto/rewrite-copy-response.dto';
import { ScoreCopyResponseDto } from './dto/score-copy-response.dto';
import { CopyService, type SsePayload } from './copy.service';

@ApiTags('copy')
@Controller('copy')
@UseGuards(JwtAuthGuard)
export class CopyController {
  constructor(private readonly copyService: CopyService) {}

  @Get('adopted')
  @ApiOperation({ summary: 'List adopted copies with product and reason tags' })
  @ApiSuccessResponse(AdoptedCopyListResponseDto)
  async adoptedList(
    @Req() req: RequestWithId,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiResponse<AdoptedCopyListResponseDto>> {
    return ok(req.requestId ?? 'unknown', await this.copyService.listAdopted(user.id));
  }

  @Post('generate')
  @ApiOperation({ summary: 'Generate marketing copy (non-stream fallback)' })
  @ApiSuccessResponse(GenerateCopyResponseDto)
  async generate(
    @Body() dto: GenerateCopyDto,
    @Req() req: RequestWithId,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiResponse<GenerateCopyResponseDto>> {
    return ok(req.requestId ?? 'unknown', await this.copyService.generate(user.id, dto));
  }

  @Sse('generate/stream')
  @ApiOperation({ summary: 'Generate marketing copy via SSE stream' })
  generateStream(
    @Query() query: GenerateCopyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Observable<SsePayload> {
    return this.copyService.generateStream(user.id, query);
  }

  @Post(':copyId/score')
  @ApiOperation({ summary: 'Score generated copy' })
  @ApiParam({ name: 'copyId', type: String })
  @ApiSuccessResponse(ScoreCopyResponseDto)
  async score(
    @Param('copyId') copyId: string,
    @Req() req: RequestWithId,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiResponse<ScoreCopyResponseDto>> {
    return ok(req.requestId ?? 'unknown', await this.copyService.score(user.id, copyId));
  }

  @Post(':copyId/rewrite')
  @ApiOperation({ summary: 'Rewrite generated copy based on score issues' })
  @ApiParam({ name: 'copyId', type: String })
  @ApiSuccessResponse(RewriteCopyResponseDto)
  async rewrite(
    @Param('copyId') copyId: string,
    @Req() req: RequestWithId,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiResponse<RewriteCopyResponseDto>> {
    return ok(req.requestId ?? 'unknown', await this.copyService.rewrite(user.id, copyId));
  }

  @Post(':copyId/adopt')
  @ApiOperation({ summary: 'Adopt a copy variant and save feedback' })
  @ApiParam({ name: 'copyId', type: String })
  @ApiSuccessResponse(AdoptCopyResponseDto)
  async adopt(
    @Param('copyId') copyId: string,
    @Body() dto: AdoptCopyDto,
    @Req() req: RequestWithId,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiResponse<AdoptCopyResponseDto>> {
    return ok(req.requestId ?? 'unknown', await this.copyService.adopt(user.id, copyId, dto));
  }
}
