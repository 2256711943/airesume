import { Module } from '@nestjs/common';
import { AgentRunService } from './agent-run.service';
import { OrchestratorService } from './orchestrator/orchestrator.service';

@Module({
  providers: [OrchestratorService, AgentRunService],
  exports: [OrchestratorService, AgentRunService],
})
export class AgentModule {}
