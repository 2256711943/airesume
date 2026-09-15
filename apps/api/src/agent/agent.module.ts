import { Module } from '@nestjs/common';
import { AgentExecutorService } from './agent-executor.service';
import { AgentRunService } from './agent-run.service';
import { OrchestratorService } from './orchestrator/orchestrator.service';
import { ToolCallLogService } from './tool-call-log.service';
import { AgentConfigRegistry, registerDefaultAgents } from './agent.config';
import { ChatWebToolsModule } from '../chat/tools/chat-web-tools.module';
import { MemoryModule } from '../memory/memory.module';

/** 仅用于在模块初始化时注册默认 Agent 配置。 */
const AGENTS_INIT = Symbol('AGENTS_INIT');

@Module({
  imports: [MemoryModule, ChatWebToolsModule],
  providers: [
    OrchestratorService,
    AgentRunService,
    AgentExecutorService,
    ToolCallLogService,
    AgentConfigRegistry,
    {
      provide: AGENTS_INIT,
      useFactory: (registry: AgentConfigRegistry): void =>
        registerDefaultAgents(registry),
      inject: [AgentConfigRegistry],
    },
  ],
  exports: [
    OrchestratorService,
    AgentRunService,
    AgentExecutorService,
    ToolCallLogService,
    AgentConfigRegistry,
  ],
})
export class AgentModule {}
