import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { AuthModule } from '../auth/auth.module';
import { LlmModule } from '../common/llm/llm.module';
import { ToolRegistry } from '../common/llm/tool-registry';
import { ConversationModule } from '../conversation/conversation.module';
import { MemoryModule } from '../memory/memory.module';
import { ObservabilityModule } from '../observability';
import { ResumeModule } from '../resume/resume.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatWebToolsModule } from './tools/chat-web-tools.module';
import { registerChatWebTools } from './tools/web-tools.schema';

/** 仅用于在模块初始化时把 Chat 联网工具注册进 ToolRegistry。 */
const CHAT_WEB_TOOLS_INIT = Symbol('CHAT_WEB_TOOLS_INIT');

@Module({
  imports: [
    AuthModule,
    ConversationModule,
    AgentModule,
    ResumeModule,
    MemoryModule,
    ObservabilityModule,
    LlmModule,
    ChatWebToolsModule,
  ],
  controllers: [ChatController],
  providers: [
    ChatService,
    {
      provide: CHAT_WEB_TOOLS_INIT,
      useFactory: (registry: ToolRegistry): void =>
        registerChatWebTools(registry),
      inject: [ToolRegistry],
    },
  ],
})
export class ChatModule {}
