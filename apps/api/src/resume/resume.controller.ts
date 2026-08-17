import {
  Body,
  Controller,
  Logger,
  Post,
  Query,
  Req,
  Res,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { Observable } from 'rxjs';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ok } from '../common/api-response';
import type { ApiResponse as ApiEnvelope } from '../common/api-response';
import type { RequestWithId } from '../common/request-id.middleware';
import { ApiSuccessResponse } from '../common/swagger';
import { GenerateResumeDto } from './dto/generate-resume.dto';
import { GenerateResumeResponseDto } from './dto/generate-resume-response.dto';
import { GenerateResumeStreamDto } from './dto/generate-resume-stream.dto';
import { RewriteJdDto } from './dto/rewrite-jd.dto';
import { RewriteJdResponseDto } from './dto/rewrite-jd-response.dto';
import { SelectResumeVariantDto } from './dto/select-resume-variant.dto';
import { SelectResumeVariantResponseDto } from './dto/select-resume-variant-response.dto';
import { ExportResumePdfDto } from './dto/export-resume-pdf.dto';
import { ResumePdfExportService } from './resume-pdf-export.service';
import { ResumeService, type ResumeSsePayload } from './resume.service';

@ApiTags('resume')
@Controller('resume')
@UseGuards(JwtAuthGuard)
export class ResumeController {
  private readonly logger = new Logger(ResumeController.name);

  constructor(
    private readonly resumeService: ResumeService,
    private readonly resumePdfExportService: ResumePdfExportService,
  ) {}

  @Post('generate')
  @ApiOperation({ summary: 'Generate structured resume content' })
  @ApiSuccessResponse(GenerateResumeResponseDto)
  async generate(
    @Body() dto: GenerateResumeDto,
    @Req() req: RequestWithId,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiEnvelope<GenerateResumeResponseDto>> {
    return ok(
      req.requestId ?? 'unknown',
      await this.resumeService.generate(dto, user),
    );
  }

  @Post('jd/rewrite')
  @ApiOperation({
    summary: 'Rewrite a JD by improving its low-scoring dimensions',
  })
  @ApiSuccessResponse(RewriteJdResponseDto)
  async rewriteJd(
    @Body() dto: RewriteJdDto,
    @Req() req: RequestWithId,
  ): Promise<ApiEnvelope<RewriteJdResponseDto>> {
    return ok(
      req.requestId ?? 'unknown',
      await this.resumeService.rewriteJd(dto),
    );
  }

  @Post('variant/select')
  @ApiOperation({
    summary:
      'Record selected rewritten variant and optionally save to resume library',
  })
  @ApiSuccessResponse(SelectResumeVariantResponseDto)
  async selectVariant(
    @Body() dto: SelectResumeVariantDto,
    @Req() req: RequestWithId,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiEnvelope<SelectResumeVariantResponseDto>> {
    return ok(
      req.requestId ?? 'unknown',
      await this.resumeService.selectVariant(dto, user),
    );
  }

  @Post('export-pdf')
  @ApiOperation({ summary: 'Export rendered resume HTML as PDF' })
  @ApiBody({ type: ExportResumePdfDto })
  @ApiResponse({
    status: 200,
    content: {
      'application/pdf': {
        schema: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  async exportPdf(
    @Body() body: Record<string, unknown>,
    @Req() req: RequestWithId,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ): Promise<void> {
    const requestId = req.requestId ?? 'unknown';

    try {
      const startedAt = Date.now();
      const result = await this.resumePdfExportService.exportPdf(
        requestId,
        body,
        user.id,
      );
      this.logger.log(
        `PDF export response requestId=${requestId} userId=${user.id} status=200 pages=${result.pageCount} bytes=${result.buffer.length} elapsedMs=${Date.now() - startedAt}`,
      );

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        this.buildContentDisposition(result.fileName),
      );
      res.setHeader('X-Pdf-Page-Count', String(result.pageCount));
      res.status(200).send(result.buffer);
    } catch (error) {
      this.logger.error(
        `PDF export error caught requestId=${requestId} userId=${user.id}`,
        error instanceof Error ? error.stack : String(error),
      );
      const mapped = this.resumePdfExportService.formatErrorResponse(
        requestId,
        error,
      );
      this.logger.warn(
        `PDF export error response requestId=${requestId} userId=${user.id} status=${mapped.statusCode} code=${mapped.body.error.code} message=${mapped.body.error.message}`,
      );
      res.status(mapped.statusCode).json(mapped.body);
    }
  }

  /**
   * 构造符合 RFC 5987 的 Content-Disposition 头。
   *
   * 文件名可能包含中文等非 ASCII 字符，直接放进 `filename="..."` 会让
   * Node 的 setHeader 抛出 `ERR_INVALID_CHAR`。因此 ASCII 兜底名 + UTF-8 编码名。
   *
   * @param fileName 不带扩展名的文件名（可能含中文）
   * @returns 可安全写入响应头的 Content-Disposition 值
   */
  private buildContentDisposition(fileName: string): string {
    const asciiFallback = 'resume.pdf';
    const encoded = encodeURIComponent(`${fileName}.pdf`);
    return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
  }

  @Sse('generate/stream')
  @ApiOperation({
    summary: 'Generate structured resume content via SSE stream',
  })
  generateStream(
    @Query() query: GenerateResumeStreamDto,
  ): Observable<ResumeSsePayload> {
    return this.resumeService.generateStream(query);
  }
}
