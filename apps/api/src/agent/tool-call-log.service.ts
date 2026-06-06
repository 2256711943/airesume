import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ToolCallLogService {
  constructor(private readonly prisma: PrismaService) {}

  // 记录一次工具调用或工具占位调用，供后续审计和调试使用。
  async createLog(params: {
    agentRunId: string;
    toolName: string;
    inputJson: Prisma.InputJsonValue;
    outputJson?: Prisma.InputJsonValue;
    success: boolean;
    latencyMs?: number;
  }): Promise<{ id: string }> {
    const log = await this.prisma.toolCallLog.create({
      data: {
        agentRunId: params.agentRunId,
        toolName: params.toolName,
        inputJson: params.inputJson,
        outputJson: params.outputJson,
        success: params.success,
        latencyMs: params.latencyMs,
      },
      select: {
        id: true,
      },
    });

    return log;
  }
}
