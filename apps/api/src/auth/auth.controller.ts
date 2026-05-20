import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ok } from '../common/api-response';
import type { ApiResponse } from '../common/api-response';
import { EmptyDto } from '../common/dto/empty.dto';
import type { RequestWithId } from '../common/request-id.middleware';
import { ApiSuccessResponse } from '../common/swagger';
import { CurrentUser } from './current-user.decorator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { MeResponseDto } from './dto/me-response.dto';
import type { AuthenticatedUser } from './jwt-auth.guard';
import { JwtAuthGuard } from './jwt-auth.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @ApiOperation({ summary: 'User login' })
  @ApiSuccessResponse(LoginResponseDto)
  async login(
    @Body() dto: LoginDto,
    @Req() req: RequestWithId,
  ): Promise<ApiResponse<LoginResponseDto>> {
    return ok(req.requestId ?? 'unknown', await this.authService.login(dto));
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'User logout' })
  @ApiSuccessResponse(EmptyDto)
  logout(@Req() req: RequestWithId): ApiResponse<EmptyDto> {
    return ok(req.requestId ?? 'unknown', this.authService.logout());
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Current user profile' })
  @ApiSuccessResponse(MeResponseDto, HttpStatus.OK)
  me(
    @Req() req: RequestWithId,
    @CurrentUser() user: AuthenticatedUser,
  ): ApiResponse<MeResponseDto> {
    return ok(req.requestId ?? 'unknown', this.authService.me(user));
  }
}
