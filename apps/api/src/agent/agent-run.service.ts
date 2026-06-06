import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { OrchestratorDecision } from './orchestrator/orchestrator.service';

@Injectable()
export class AgentRunService {
  constructor(private readonly prisma: PrismaService) {}

  // 创建一条 running 状态的 AgentRun，等待后续执行结果回写。
  async createRunningRun(params: {
    conversationId: string;
    messageId: string;
    selectedAgent: string;
    orchestratorDecision: OrchestratorDecision;
  }): Promise<{ id: string }> {
    const run = await this.prisma.agentRun.create({
      data: {
        conversationId: params.conversationId,
        messageId: params.messageId,
        selectedAgent: params.selectedAgent,
        orchestratorDecision: params.orchestratorDecision as unknown as Prisma.InputJsonValue,
        status: 'running',
      },
      select: {
        id: true,
      },
    });

    return run;
  }

  // 将运行状态更新为 succeeded，并记录本次执行耗时。
  async markSucceeded(runId: string, latencyMs: number): Promise<void> {
    await this.prisma.agentRun.update({
      where: { id: runId },
      data: {
        status: 'succeeded',
        latencyMs,
        errorCode: null,
      },
    });
  }

  // 将运行状态更新为 failed，并写入稳定错误码。
  async markFailed(runId: string, error: unknown, latencyMs: number): Promise<void> {
    await this.prisma.agentRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        latencyMs,
        errorCode: this.normalizeErrorCode(error),
      },
    });
  }

  private normalizeErrorCode(error: unknown): string {
    if (error && typeof error === 'object') {
      const candidate = (error as { code?: unknown }).code;
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim().slice(0, 80);
      }
    }

    return 'INTERNAL_ERROR';
  }
}
