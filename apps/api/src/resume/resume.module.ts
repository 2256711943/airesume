import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { JdJudgeService } from './jd-parser/jd-judge.service';
import { JdParserService } from './jd-parser/jd-parser.service';
import { JdRewriterService } from './jd-parser/jd-rewriter.service';
import { ResumeController } from './resume.controller';
import { ResumeAiService } from './resume.ai.service';
import { ResumeService } from './resume.service';

@Module({
  imports: [AuthModule],
  controllers: [ResumeController],
  providers: [ResumeService, ResumeAiService, JdParserService, JdJudgeService, JdRewriterService],
})
export class ResumeModule {}
