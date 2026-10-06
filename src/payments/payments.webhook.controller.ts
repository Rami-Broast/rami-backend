import { Body, Controller, Headers, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { SimulateRefundDto, SimulateWebhookDto } from './dto/payment.dto';
import { PaymentsService } from './payments.service';

/**
 * Inbound gateway webhooks.
 *
 * Public because a gateway is not an authenticated user — the security boundary
 * is the **signature over the raw body**, verified in the service before an
 * event is trusted. That is why the raw bytes are read from `req.rawBody`
 * (enabled by `rawBody: true` at bootstrap) rather than the parsed JSON: a
 * signature must be checked against exactly what was received.
 */
@ApiTags('webhooks')
@Public()
@Controller('webhooks/payments')
export class PaymentsWebhookController {
  constructor(private readonly payments: PaymentsService) {}

  @Post(':gateway')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Receive a payment gateway webhook',
    description:
      'The signature header is verified against the raw request body. Unverified events are recorded and rejected; verified events are processed exactly once.',
  })
  @ApiResponse({ status: 401, type: ApiErrorDto, description: 'Signature verification failed.' })
  receive(
    @Param('gateway') gateway: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-mock-signature') mockSignature?: string,
    @Headers('x-tap-signature') tapSignature?: string,
  ) {
    // The raw bytes as received. Falls back to the serialised parsed body only
    // if raw capture is unavailable (it is enabled in bootstrap for production).
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const signature = mockSignature ?? tapSignature;

    return this.payments.handleWebhook(gateway, rawBody, signature);
  }

  @Post(':gateway/simulate')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  @ApiOperation({
    summary: 'Sandbox: complete a mock charge',
    description:
      'Delivers a genuine, correctly signed mock webhook. Sandbox and mock gateway only.',
  })
  simulate(@Param('gateway') _gateway: string, @Body() dto: SimulateWebhookDto) {
    return this.payments.simulateWebhook(dto.gatewayPaymentId, dto.outcome, dto.amountMinor);
  }

  @Post(':gateway/simulate-refund')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  @ApiOperation({
    summary: 'Sandbox: complete a mock refund',
    description:
      'Delivers a genuine, correctly signed mock refund webhook. Sandbox and mock gateway only.',
  })
  simulateRefund(@Param('gateway') _gateway: string, @Body() dto: SimulateRefundDto) {
    return this.payments.simulateRefundWebhook(dto.gatewayRefundId, dto.outcome);
  }
}
