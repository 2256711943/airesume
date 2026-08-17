import { Controller, Get, Param, Query } from '@nestjs/common';
import { ObservabilityReplayService } from './observability-replay.service';
import { ObservabilityRunEventsQueryDto } from './dto/observability-run-events-query.dto';

/**
 * Replay 查询接口：为历史 run 复盘提供只读数据源。
 * 所有接口均不写库、不消费实时 SSE 流，与实时观测态解耦。
 */
@Controller('observability')
export class ObservabilityReplayController {
  constructor(private readonly replayService: ObservabilityReplayService) {}

  /**
   * 查询指定 run 的事件列表（按 seq 升序，支持范围与类型过滤）。
   */
  @Get('runs/:runId/events')
  async getRunEvents(
    @Param('runId') runId: string,
    @Query() query: ObservabilityRunEventsQueryDto,
  ) {
    const events = await this.replayService.listRunEvents(runId, query);
    return { runId, count: events.length, events };
  }

  /**
   * 返回一次 run 的 replay 完整包：summary + events + checkpoints + diagnostics。
   */
  @Get('runs/:runId/replay')
  async getRunReplay(@Param('runId') runId: string) {
    return this.replayService.getRunReplay(runId);
  }

  /**
   * 返回同一会话下可 replay 的 run 列表（最新在前）。
   */
  @Get('conversations/:conversationId/runs')
  async listConversationRuns(
    @Param('conversationId') conversationId: string,
  ) {
    const runs = await this.replayService.listConversationRuns(conversationId);
    return { conversationId, count: runs.length, runs };
  }
}
