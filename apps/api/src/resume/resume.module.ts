import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ResumeController } from './resume.controller';
import { ResumeAiService } from './resume.ai.service';
import { ResumeService } from './resume.service';

@Module({
  imports: [AuthModule],
  controllers: [ResumeController],
  providers: [ResumeService, ResumeAiService],
})
export class ResumeModule {}

