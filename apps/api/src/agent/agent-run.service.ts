import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { OrchestratorDecision } from './orchestrator/orchestrator.service';

@Injectable()
export class AgentRunService {
  constructor(private readonly prisma: PrismaService) {}

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

  async markSucceeded(runId: string, latencyMs: number): Promise<void> {
    await this.updateStatus(runId, 'succeeded', {
      latencyMs,
      errorCode: null,
    });
  }

  async markFailed(runId: string, error: unknown, latencyMs: number): Promise<void> {
    await this.updateStatus(runId, 'failed', {
      latencyMs,
      errorCode: this.normalizeErrorCode(error),
    });
  }

  async markTimeout(runId: string, latencyMs: number): Promise<void> {
    await this.updateStatus(runId, 'timeout', {
      latencyMs,
      errorCode: 'TOOL_TIMEOUT',
    });
  }

  async markCanceled(runId: string, latencyMs: number): Promise<void> {
    await this.updateStatus(runId, 'canceled', {
      latencyMs,
      errorCode: 'USER_ABORT',
    });
  }

  async markPartialSuccess(runId: string, latencyMs: number): Promise<void> {
    await this.updateStatus(runId, 'partial_success', {
      latencyMs,
      errorCode: null,
    });
  }

  private async updateStatus(
    runId: string,
    status: 'running' | 'succeeded' | 'failed' | 'timeout' | 'canceled' | 'partial_success',
    data: {
      latencyMs: number;
      errorCode: string | null;
    },
  ): Promise<void> {
    await this.prisma.agentRun.update({
      where: { id: runId },
      data: {
        status,
        latencyMs: data.latencyMs,
        errorCode: data.errorCode,
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
