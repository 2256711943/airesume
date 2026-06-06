import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ChatModule } from './chat/chat.module';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { ConversationModule } from './conversation/conversation.module';
import { PrismaModule } from './prisma/prisma.module';
import { ResumeModule } from './resume/resume.module';
import { ToolModule } from './tool/tool.module';

@Module({
  imports: [PrismaModule, AuthModule, ResumeModule, ConversationModule, ChatModule, ToolModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('{*splat}');
  }
}
