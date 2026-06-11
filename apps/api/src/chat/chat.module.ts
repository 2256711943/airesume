import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { AuthModule } from '../auth/auth.module';
import { ConversationModule } from '../conversation/conversation.module';
import { ResumeModule } from '../resume/resume.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

@Module({
  imports: [AuthModule, ConversationModule, AgentModule, ResumeModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
