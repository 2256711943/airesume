import {
  Body,
  Controller,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ok } from '../common/api-response';
import type { ApiResponse } from '../common/api-response';
import type { RequestWithId } from '../common/request-id.middleware';
import { EmptyDto } from '../common/dto/empty.dto';
import { ApiSuccessResponse } from '../common/swagger';
import { StreamControlDto } from './dto/stream-control.dto';
import { StreamsControlService } from './streams-control.service';

@ApiTags('streams')
@Controller('streams')
@UseGuards(JwtAuthGuard)
export class StreamsController {
  constructor(private readonly streamsControlService: StreamsControlService) {}

  @Post(':streamKey/control')
  @ApiOperation({ summary: 'Adjust SSE stream pressure control state' })
  @ApiSuccessResponse(EmptyDto, HttpStatus.OK)
  controlStream(
    @Param('streamKey') streamKey: string,
    @Body() dto: StreamControlDto,
    @Req() req: RequestWithId,
  ): ApiResponse<EmptyDto> {
    const applied = this.streamsControlService.applyControl(streamKey, dto);
    if (!applied) {
      throw new NotFoundException(`Unknown streamKey: ${streamKey}`);
    }

    const response = new EmptyDto();
    response.acknowledged = true;
    return ok(req.requestId ?? 'unknown', response);
  }
}
