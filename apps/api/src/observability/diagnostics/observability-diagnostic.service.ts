import { Injectable } from '@nestjs/common';
import type { ObservabilityDiagnosticIssue } from '../observability.types';
import { ObservabilityEventStore } from '../observability.store';
import { runObservabilityDiagnostics } from './observability-diagnostic.engine';

/**
 * 诊断服务：对已落盘的 run 按需执行规则引擎（复盘诊断）。
 *
 * - 从事件 store 按 seq 拉取该 run 全部事件；
 * - 交给纯函数引擎计算并聚合，不写库、不阻塞 SSE 主链路。
 */
@Injectable()
export class ObservabilityDiagnosticService {
  constructor(private readonly eventStore: ObservabilityEventStore) {}

  async diagnoseRun(runId: string): Promise<ObservabilityDiagnosticIssue[]> {
    const events = await this.eventStore.list({
      runId,
      orderBy: { field: 'seq', direction: 'asc' },
    });

    return runObservabilityDiagnostics(runId, events);
  }
}
