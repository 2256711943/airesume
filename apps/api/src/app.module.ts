import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ChatModule } from './chat/chat.module';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { LlmModule } from './common/llm/llm.module';
import { ConversationModule } from './conversation/conversation.module';
import { PrismaModule } from './prisma/prisma.module';
import { PdfExportModule } from './pdf-export/pdf-export.module';
import { ResumeModule } from './resume/resume.module';
import { StreamsModule } from './streams/streams.module';
import { ToolModule } from './tool/tool.module';

@Module({
  imports: [
    PrismaModule,
    LlmModule,
    AuthModule,
    PdfExportModule,
    ResumeModule,
    StreamsModule,
    ConversationModule,
    ChatModule,
    ToolModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('{*splat}');
  }
}
