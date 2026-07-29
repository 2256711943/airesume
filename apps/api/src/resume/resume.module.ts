import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MemoryModule } from '../memory/memory.module';
import { JdJudgeService } from './jd-parser/jd-judge.service';
import { JdParserService } from './jd-parser/jd-parser.service';
import { JdRewriterService } from './jd-parser/jd-rewriter.service';
import { ResumeController } from './resume.controller';
import { ResumeAiService } from './resume.ai.service';
import { ResumeContextService } from './resume-context.service';
import { ResumeLearningService } from './resume-learning.service';
import { ResumeScorerService } from './resume-scorer.service';
import { ResumeService } from './resume.service';

@Module({
  imports: [AuthModule, MemoryModule],
  controllers: [ResumeController],
  providers: [
    ResumeService,
    ResumeAiService,
    ResumeLearningService,
    ResumeScorerService,
    ResumeContextService,
    JdParserService,
    JdJudgeService,
    JdRewriterService,
  ],
  exports: [JdParserService, JdJudgeService, ResumeContextService],
})
export class ResumeModule {}
