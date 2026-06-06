import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { JdJudgeService } from '../resume/jd-parser/jd-judge.service';
import { JdParserService } from '../resume/jd-parser/jd-parser.service';
import { ToolCallLogService } from '../agent/tool-call-log.service';
import type {
  JdParseAndScoreToolInput,
  JdParseAndScoreToolOutput,
  ToolExecutionResult,
  ToolName,
} from './tool.types';

@Injectable()
export class ToolRegistryService {
  constructor(
    private readonly jdParserService: JdParserService,
    private readonly jdJudgeService: JdJudgeService,
    private readonly toolCallLogService: ToolCallLogService,
  ) {}

  // 统一工具入口：负责路由、超时、错误收敛和日志记录。
  async execute<TName extends ToolName>(
    toolName: TName,
    input: TName extends 'jd_parse_and_score' ? JdParseAndScoreToolInput : never,
    options: {
      agentRunId?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<ToolExecutionResult<JdParseAndScoreToolOutput>> {
    const startedAt = Date.now();
    try {
      const output = await this.executeInternal(toolName, input, options.timeoutMs ?? 8000);
      const result: ToolExecutionResult<JdParseAndScoreToolOutput> = {
        success: true,
        toolName,
        data: output,
        error: null,
        latencyMs: Date.now() - startedAt,
        sourceMeta: {
          source: 'internal',
          version: 'tool-registry-v1',
        },
      };

      await this.writeLog(options.agentRunId, toolName, input, result);
      return result;
    } catch (error) {
      const result: ToolExecutionResult<JdParseAndScoreToolOutput> = {
        success: false,
        toolName,
        data: null,
        error: this.normalizeError(error),
        latencyMs: Date.now() - startedAt,
        sourceMeta: {
          source: 'internal',
          version: 'tool-registry-v1',
        },
      };

      await this.writeLog(options.agentRunId, toolName, input, result);
      return result;
    }
  }

  // 当前只接入一个真实工具：JD 解析 + 评分。
  private async executeInternal(
    toolName: ToolName,
    input: JdParseAndScoreToolInput,
    timeoutMs: number,
  ): Promise<JdParseAndScoreToolOutput> {
    switch (toolName) {
      case 'jd_parse_and_score':
        return this.withTimeout(
          Promise.resolve().then(async () => {
            if (!input.jdText?.trim()) {
              throw new ServiceUnavailableException('JD text is required');
            }

            const parsedJd = await this.jdParserService.parse(input.jdText);
            const judge = this.jdJudgeService.judge(parsedJd, input.jdText);
            return {
              parsedJd,
              judge,
            };
          }),
          timeoutMs,
        );
      default:
        throw new ServiceUnavailableException(`Unsupported tool: ${toolName}`);
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new ServiceUnavailableException('TOOL_TIMEOUT')), timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async writeLog(
    agentRunId: string | undefined,
    toolName: ToolName,
    input: JdParseAndScoreToolInput,
    result: ToolExecutionResult<JdParseAndScoreToolOutput>,
  ): Promise<void> {
    if (!agentRunId) {
      return;
    }

    await this.toolCallLogService.createLog({
      agentRunId,
      toolName,
      inputJson: input as never,
      outputJson: result as never,
      success: result.success,
      latencyMs: result.latencyMs,
    });
  }

  private normalizeError(error: unknown): { code: string; message: string } {
    if (error instanceof ServiceUnavailableException) {
      return {
        code: 'SERVICE_UNAVAILABLE',
        message: error.message,
      };
    }

    if (error instanceof Error) {
      return {
        code: 'INTERNAL_ERROR',
        message: error.message,
      };
    }

    return {
      code: 'INTERNAL_ERROR',
      message: 'Unknown tool error',
    };
  }
}
