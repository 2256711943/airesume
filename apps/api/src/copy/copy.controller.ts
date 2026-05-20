import {
  Body,
  Controller,
  Param,
  Post,
  Query,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Observable } from 'rxjs';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ok } from '../common/api-response';
import type { ApiResponse } from '../common/api-response';
import type { RequestWithId } from '../common/request-id.middleware';
import { ApiSuccessResponse } from '../common/swagger';
import { AdoptCopyDto } from './dto/adopt-copy.dto';
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

  @Post('generate')
  @ApiOperation({ summary: 'Generate marketing copy (non-stream fallback)' })
  @ApiSuccessResponse(GenerateCopyResponseDto)
  generate(
    @Body() dto: GenerateCopyDto,
    @Req() req: RequestWithId,
  ): ApiResponse<GenerateCopyResponseDto> {
    return ok(req.requestId ?? 'unknown', this.copyService.generate(dto));
  }

  @Sse('generate/stream')
  @ApiOperation({ summary: 'Generate marketing copy via SSE stream' })
  generateStream(@Query() query: GenerateCopyDto): Observable<SsePayload> {
    return this.copyService.generateStream(query);
  }

  @Post(':copyId/score')
  @ApiOperation({ summary: 'Score generated copy' })
  @ApiParam({ name: 'copyId', type: String })
  @ApiSuccessResponse(ScoreCopyResponseDto)
  score(
    @Param('copyId') copyId: string,
    @Req() req: RequestWithId,
  ): ApiResponse<ScoreCopyResponseDto> {
    return ok(req.requestId ?? 'unknown', this.copyService.score(copyId));
  }

  @Post(':copyId/rewrite')
  @ApiOperation({ summary: 'Rewrite generated copy based on score issues' })
  @ApiParam({ name: 'copyId', type: String })
  @ApiSuccessResponse(RewriteCopyResponseDto)
  rewrite(
    @Param('copyId') copyId: string,
    @Req() req: RequestWithId,
  ): ApiResponse<RewriteCopyResponseDto> {
    return ok(req.requestId ?? 'unknown', this.copyService.rewrite(copyId));
  }

  @Post(':copyId/adopt')
  @ApiOperation({ summary: 'Adopt a copy variant and save feedback' })
  @ApiParam({ name: 'copyId', type: String })
  @ApiSuccessResponse(AdoptCopyResponseDto)
  adopt(
    @Param('copyId') copyId: string,
    @Body() dto: AdoptCopyDto,
    @Req() req: RequestWithId,
  ): ApiResponse<AdoptCopyResponseDto> {
    return ok(req.requestId ?? 'unknown', this.copyService.adopt(copyId, dto));
  }
}
