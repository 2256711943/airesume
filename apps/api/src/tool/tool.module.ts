import { forwardRef, Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { ResumeModule } from '../resume/resume.module';
import { ToolRegistryService } from './tool-registry.service';

@Module({
  imports: [ResumeModule, forwardRef(() => AgentModule)],
  providers: [ToolRegistryService],
  exports: [ToolRegistryService],
})
export class ToolModule {}
