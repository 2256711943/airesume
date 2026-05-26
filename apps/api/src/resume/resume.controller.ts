import { Body, Controller, Post, Query, Req, Sse, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Observable } from 'rxjs';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ok } from '../common/api-response';
import type { ApiResponse } from '../common/api-response';
import type { RequestWithId } from '../common/request-id.middleware';
import { ApiSuccessResponse } from '../common/swagger';
import { GenerateResumeDto } from './dto/generate-resume.dto';
import { GenerateResumeResponseDto } from './dto/generate-resume-response.dto';
import { GenerateResumeStreamDto } from './dto/generate-resume-stream.dto';
import { ResumeService, type ResumeSsePayload } from './resume.service';

@ApiTags('resume')
@Controller('resume')
@UseGuards(JwtAuthGuard)
export class ResumeController {
  constructor(private readonly resumeService: ResumeService) {}

  @Post('generate')
  @ApiOperation({ summary: 'Generate structured resume content' })
  @ApiSuccessResponse(GenerateResumeResponseDto)
  async generate(
    @Body() dto: GenerateResumeDto,
    @Req() req: RequestWithId,
    @CurrentUser() _user: AuthenticatedUser,
  ): Promise<ApiResponse<GenerateResumeResponseDto>> {
    return ok(req.requestId ?? 'unknown', await this.resumeService.generate(dto));
  }

  @Sse('generate/stream')
  @ApiOperation({ summary: 'Generate structured resume content via SSE stream' })
  generateStream(
    @Query() query: GenerateResumeStreamDto,
    @CurrentUser() _user: AuthenticatedUser,
  ): Observable<ResumeSsePayload> {
    return this.resumeService.generateStream(query);
  }
}

