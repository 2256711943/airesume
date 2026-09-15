import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import {
  JD_LLM_PARSER_CLIENT,
  JD_LLM_REWRITER_CLIENT,
  type JdLlmParserClient,
  type JdLlmRewriterClient,
} from '../common/llm/llm-client.interface';
import { LlmModule } from '../common/llm/llm.module';
import { OpenAiAgentClient } from '../common/llm/openai-agent.client';
import { OpenAIJdLlmParserClient } from '../common/llm/openai-responses.client';
import { OpenAIJdLlmRewriterClient } from '../common/llm/openai-responses-rewriter.client';
import { ToolRegistry } from '../common/llm/tool-registry';
import { MemoryModule } from '../memory/memory.module';
import { PdfExportModule } from '../pdf-export/pdf-export.module';
import { JdJudgeService } from './jd-parser/jd-judge.service';
import { JdParserService } from './jd-parser/jd-parser.service';
import { JdRewriterService } from './jd-parser/jd-rewriter.service';
import {
  registerJdDiagnosisTools,
  registerJdTools,
} from './jd-parser/jd-parse-tool.schema';
import { JdToolExecutor } from './jd-parser/jd-tool-executor';
import { ResumeAgentLoopService } from './resume-agent-loop.service';
import { ResumeController } from './resume.controller';
import { ResumeAiService } from './resume.ai.service';
import { ResumeContextService } from './resume-context.service';
import { ResumeLearningService } from './resume-learning.service';
import { ResumePdfExportService } from './resume-pdf-export.service';
import { ResumeScorerService } from './resume-scorer.service';
import { ResumeService } from './resume.service';

/** 仅用于在模块初始化时把 JD 链路工具注册进 ToolRegistry。 */
const JD_TOOLS_INIT = Symbol('JD_TOOLS_INIT');

@Module({
  imports: [LlmModule, AuthModule, MemoryModule, PdfExportModule],
  controllers: [ResumeController],
  providers: [
    ResumeService,
    ResumeAiService,
    ResumeLearningService,
    ResumeScorerService,
    ResumeContextService,
    ResumePdfExportService,
    ResumeAgentLoopService,
    JdParserService,
    JdJudgeService,
    JdRewriterService,
    JdToolExecutor,
    {
      provide: JD_TOOLS_INIT,
      useFactory: (registry: ToolRegistry): void => {
        registerJdTools(registry);
        registerJdDiagnosisTools(registry);
      },
      inject: [ToolRegistry],
    },
    {
      provide: JD_LLM_PARSER_CLIENT,
      useFactory: (
        agent: OpenAiAgentClient,
        registry: ToolRegistry,
      ): JdLlmParserClient => new OpenAIJdLlmParserClient(agent, registry),
      inject: [OpenAiAgentClient, ToolRegistry],
    },
    {
      provide: JD_LLM_REWRITER_CLIENT,
      useFactory: (
        agent: OpenAiAgentClient,
        registry: ToolRegistry,
      ): JdLlmRewriterClient => new OpenAIJdLlmRewriterClient(agent, registry),
      inject: [OpenAiAgentClient, ToolRegistry],
    },
  ],
  exports: [
    JdParserService,
    JdJudgeService,
    ResumeContextService,
    JdToolExecutor,
  ],
})
export class ResumeModule {}
