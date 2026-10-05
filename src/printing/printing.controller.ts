import { Body, Controller, Get, Header, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { SignPrintRequestDto } from './dto/sign-request.dto';
import { QzSigningService } from './qz-signing.service';

@ApiTags('printing')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('printing/qz')
export class PrintingController {
  constructor(private readonly signing: QzSigningService) {}

  /**
   * Whether prints will be silent, so the Branch POS's setup screen can say so
   * rather than leaving somebody to discover it from a dialog mid-service.
   */
  @Get('status')
  @RequirePermissions('printing:sign')
  @ApiOperation({ summary: 'Is QZ request signing configured?' })
  status() {
    return { signingConfigured: this.signing.isConfigured };
  }

  @Get('certificate')
  @RequirePermissions('printing:sign')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @ApiOperation({ summary: 'The public certificate QZ Tray checks against its trust store' })
  @ApiResponse({ status: 503, type: ApiErrorDto, description: 'No certificate configured.' })
  certificate(): string {
    return this.signing.certificate();
  }

  /**
   * POST rather than QZ's documented `GET /sign-message?request=…`: a print
   * request carries the whole ticket, which is both too long for a query string
   * on some proxies and something that would then sit in every access log along
   * the way — a customer's name, phone and address among it.
   */
  @Post('sign')
  @HttpCode(200)
  @RequirePermissions('printing:sign')
  @ApiOperation({ summary: 'Sign one QZ Tray request' })
  @ApiResponse({ status: 503, type: ApiErrorDto, description: 'No signing key configured.' })
  sign(@Body() dto: SignPrintRequestDto) {
    return { signature: this.signing.sign(dto.request) };
  }
}
