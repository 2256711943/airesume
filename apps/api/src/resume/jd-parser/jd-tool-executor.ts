import { Injectable } from '@nestjs/common';
import type { AgentToolCall } from '../../common/llm/openai-agent.client';
import { ToolRegistry } from '../../common/llm/tool-registry';
import {
  JD_PARSE_TOOL_NAME,
  JD_SCORE_TOOL_NAME,
  type JdParseToolInput,
  type JdScoreToolInput,
} from './jd-parse-tool.schema';
import { JdJudgeService } from './jd-judge.service';
import { JdParserService } from './jd-parser.service';
import type { ParsedJdResult } from './types';

/**
 * JD 诊断工具执行器。
 *
 * 与 `ChatWebToolExecutor` 对称：
 * - 构造时把 `jd_parse` / `jd_score` 的执行函数注册进 `ToolRegistry`
 *   （每个执行函数先 `validateArguments` 按 zod schema 校验，失败抛错由客户端
 *   `safeExecute` 回填 `{ ok:false, error }` 给模型，不中断 loop）；
 * - `execute` 只做查表分发，不维护工具路由分支。
 */
@Injectable()
export class JdToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly jdParserService: JdParserService,
    private readonly jdJudgeService: JdJudgeService,
  ) {
    this.registerExecutors();
  }

  private registerExecutors(): void {
    this.registry.registerExecutor(JD_PARSE_TOOL_NAME, async (call) => {
      const { jdText } = this.registry.validateArguments(
        call.name,
        call.arguments ?? {},
      ) as JdParseToolInput;
      const parsedJd = await this.jdParserService.parse(jdText);
      return { parsedJd };
    });

    this.registry.registerExecutor(JD_SCORE_TOOL_NAME, async (call) => {
      const { jdText, parsedJd } = this.registry.validateArguments(
        call.name,
        call.arguments ?? {},
      ) as JdScoreToolInput;
      const judge = this.jdJudgeService.judge(
        parsedJd as unknown as ParsedJdResult,
        jdText,
      );
      return { judge };
    });
  }

  async execute(call: AgentToolCall): Promise<unknown> {
    const executor = this.registry.getExecutor(call.name);
    if (!executor) {
      throw new Error(`tool_not_registered: ${call.name}`);
    }
    return executor(call);
  }
}
