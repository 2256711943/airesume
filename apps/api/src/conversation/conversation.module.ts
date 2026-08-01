import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { AuthModule } from '../auth/auth.module';
import { ResumeModule } from '../resume/resume.module';
import { ConversationController } from './conversation.controller';
import { ConversationService } from './conversation.service';

@Module({
  imports: [AuthModule, ResumeModule, MemoryModule],
  controllers: [ConversationController],
  providers: [ConversationService],
  exports: [ConversationService],
})
export class ConversationModule {}
