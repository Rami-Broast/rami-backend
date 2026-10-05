import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { ApiErrorDto } from '../common/dto/api-error.dto';
import { AuthService } from './auth.service';
import { CurrentActor } from './decorators/current-actor.decorator';
import { Public } from './decorators/public.decorator';
import {
  AuthTokensDto,
  CurrentActorDto,
  OtpRequestedDto,
  RefreshTokenDto,
  RequestOtpDto,
  StaffLoginDto,
  VerifyOtpDto,
} from './dto/auth.dto';
import { TokenContext } from './services/token.service';
import { Actor } from './types/actor';

/** Identical for a known and an unknown number, by design. */
const OTP_SENT_MESSAGE = 'A verification code has been sent.';

@ApiTags('auth')
@ApiResponse({ status: 400, type: ApiErrorDto, description: 'Validation failed.' })
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private contextOf(request: Request): TokenContext {
    return {
      userAgent: request.headers['user-agent'],
      ipAddress: request.ip,
    };
  }

  @Public()
  @Post('customer/otp/request')
  @HttpCode(HttpStatus.OK)
  // Tighter than the global limit: this endpoint costs real money per call.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Request a login code',
    description:
      'Sends a one-time code by SMS. The response is identical whether or not the number is registered, so this cannot be used to discover which customers exist.',
  })
  @ApiResponse({ status: 200, type: OtpRequestedDto })
  @ApiResponse({ status: 429, type: ApiErrorDto, description: 'Cooldown or hourly cap hit.' })
  async requestOtp(@Body() dto: RequestOtpDto, @Req() request: Request): Promise<OtpRequestedDto> {
    const { expiresAt } = await this.auth.requestCustomerOtp(dto.phone, request.ip);

    return { expiresAt, message: OTP_SENT_MESSAGE };
  }

  @Public()
  @Post('customer/otp/verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Complete customer login',
    description:
      'Exchanges a valid code for tokens. The customer account is created on first successful verification.',
  })
  @ApiResponse({ status: 200, type: AuthTokensDto })
  @ApiResponse({ status: 401, type: ApiErrorDto, description: 'Code invalid or expired.' })
  verifyOtp(@Body() dto: VerifyOtpDto, @Req() request: Request): Promise<AuthTokensDto> {
    return this.auth.verifyCustomerOtp(dto.phone, dto.code, this.contextOf(request));
  }

  @Public()
  @Post('staff/login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Staff login with email and password' })
  @ApiResponse({ status: 200, type: AuthTokensDto })
  @ApiResponse({ status: 401, type: ApiErrorDto, description: 'Invalid credentials.' })
  staffLogin(@Body() dto: StaffLoginDto, @Req() request: Request): Promise<AuthTokensDto> {
    return this.auth.staffLogin(dto.email, dto.password, this.contextOf(request));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new pair',
    description:
      'Refresh tokens are single-use and rotated. Presenting one that has already been rotated revokes the whole session family, because reuse means the token was replayed.',
  })
  @ApiResponse({ status: 200, type: AuthTokensDto })
  @ApiResponse({ status: 401, type: ApiErrorDto, description: 'Token invalid, expired or reused.' })
  refresh(@Body() dto: RefreshTokenDto, @Req() request: Request): Promise<AuthTokensDto> {
    return this.auth.refresh(dto.refreshToken, this.contextOf(request));
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Sign out',
    description:
      'Revokes the session family. Idempotent, and reveals nothing about whether the token existed.',
  })
  @ApiResponse({ status: 204, description: 'Signed out.' })
  logout(@Body() dto: RefreshTokenDto): Promise<void> {
    return this.auth.logout(dto.refreshToken);
  }

  @Get('me')
  @ApiOperation({
    summary: 'The authenticated actor',
    description:
      'Roles, permissions and branch scope as resolved server-side on this request — not as claimed by the token.',
  })
  @ApiResponse({ status: 200, type: CurrentActorDto })
  @ApiResponse({ status: 401, type: ApiErrorDto })
  me(@CurrentActor() actor: Actor): CurrentActorDto {
    return this.auth.describeActor(actor);
  }
}
