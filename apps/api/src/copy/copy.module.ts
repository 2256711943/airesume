import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CopyController } from './copy.controller';
import { CopyAiService } from './copy.ai.service';
import { CopyService } from './copy.service';

@Module({
  imports: [AuthModule],
  controllers: [CopyController],
  providers: [CopyService, CopyAiService],
})
export class CopyModule {}
