import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CopyController } from './copy.controller';
import { CopyService } from './copy.service';

@Module({
  imports: [AuthModule],
  controllers: [CopyController],
  providers: [CopyService],
})
export class CopyModule {}
