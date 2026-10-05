import { Controller, Headers, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { ZatcaInvoicingService } from './zatca-invoicing.service';

/**
 * Inbound RestoPOS ZATCA status webhook.
 *
 * Public because RestoPOS is not an authenticated user — the boundary is the
 * signature over the raw body (`x-restopos-signature`, HMAC-SHA256 hex),
 * verified in the service. The webhook only *nudges* us to re-fetch the
 * document's real status from RestoPOS, so it can never push a false status.
 */
@ApiTags('webhooks')
@Public()
@Controller('webhooks/zatca')
export class ZatcaWebhookController {
  constructor(private readonly zatca: ZatcaInvoicingService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Receive a RestoPOS ZATCA status update',
    description:
      'The signature header is verified against the raw request body; the document status is then re-fetched authoritatively from RestoPOS.',
  })
  @ApiResponse({ status: 401, type: ApiErrorDto, description: 'Signature verification failed.' })
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-restopos-signature') signature?: string,
  ): Promise<{ ok: true }> {
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    await this.zatca.handleStatusWebhook(rawBody, signature);
    return { ok: true };
  }
}
