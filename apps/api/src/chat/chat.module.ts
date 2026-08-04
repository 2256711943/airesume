import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { AuthModule } from '../auth/auth.module';
import { ConversationModule } from '../conversation/conversation.module';
import { MemoryModule } from '../memory/memory.module';
import { ObservabilityModule } from '../observability';
import { ResumeModule } from '../resume/resume.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

@Module({
  imports: [
    AuthModule,
    ConversationModule,
    AgentModule,
    ResumeModule,
    MemoryModule,
    ObservabilityModule,
  ],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
