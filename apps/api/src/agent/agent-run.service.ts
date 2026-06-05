import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { OrchestratorDecision } from './orchestrator/orchestrator.service';

@Injectable()
export class AgentRunService {
  constructor(private readonly prisma: PrismaService) {}

  // 记录一次最小化的 orchestrator 运行结果，供后续追踪和审计。
  async createSucceededRun(params: {
    conversationId: string;
    messageId: string;
    selectedAgent: string;
    orchestratorDecision: OrchestratorDecision;
    latencyMs: number;
  }): Promise<{ id: string }> {
    const run = await this.prisma.agentRun.create({
      data: {
        conversationId: params.conversationId,
        messageId: params.messageId,
        selectedAgent: params.selectedAgent,
        orchestratorDecision: params.orchestratorDecision as unknown as Prisma.InputJsonValue,
        status: 'succeeded',
        latencyMs: params.latencyMs,
      },
      select: {
        id: true,
      },
    });

    return run;
  }
}
