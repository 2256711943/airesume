import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StreamsController } from './streams.controller';
import { StreamsControlService } from './streams-control.service';

@Module({
  imports: [AuthModule],
  controllers: [StreamsController],
  providers: [StreamsControlService],
})
export class StreamsModule {}
