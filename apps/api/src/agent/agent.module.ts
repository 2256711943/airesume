import { forwardRef, Module } from '@nestjs/common';
import { AgentExecutorService } from './agent-executor.service';
import { AgentRunService } from './agent-run.service';
import { OrchestratorService } from './orchestrator/orchestrator.service';
import { ToolCallLogService } from './tool-call-log.service';
import { MemoryModule } from '../memory/memory.module';
import { ToolModule } from '../tool/tool.module';

@Module({
  imports: [forwardRef(() => ToolModule), MemoryModule],
  providers: [
    OrchestratorService,
    AgentRunService,
    AgentExecutorService,
    ToolCallLogService,
  ],
  exports: [
    OrchestratorService,
    AgentRunService,
    AgentExecutorService,
    ToolCallLogService,
  ],
})
export class AgentModule {}
