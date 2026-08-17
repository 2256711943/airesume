import { Controller, Get, Param } from '@nestjs/common';
import { ObservabilityDiagnosticService } from './observability-diagnostic.service';

@Controller('observability')
export class ObservabilityDiagnosticController {
  constructor(
    private readonly diagnosticService: ObservabilityDiagnosticService,
  ) {}

  /**
   * 获取指定 run 的规则诊断结果（复盘按需计算，不依赖持久化诊断表）。
   */
  @Get('runs/:runId/diagnostics')
  async getRunDiagnostics(@Param('runId') runId: string) {
    const issues = await this.diagnosticService.diagnoseRun(runId);
    return { runId, count: issues.length, issues };
  }
}
