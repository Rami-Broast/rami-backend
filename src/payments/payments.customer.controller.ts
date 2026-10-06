import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { Actor } from '../auth/types/actor';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { InitiatePaymentDto } from './dto/payment.dto';
import { PaymentsService } from './payments.service';

/**
 * The customer app's payment surface.
 *
 * Initiating a charge returns what the client must do next (typically a
 * redirect). It never marks the order paid — the order advances only when a
 * signature-verified webhook arrives. Ownership is enforced by customer id in
 * the service.
 */
@ApiTags('payments (customer)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@Controller('customer/orders/:orderId')
export class CustomerPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('pay')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start paying for an order',
    description:
      'Creates or reuses the order’s payment and returns the next client action. Idempotent per idempotency key. Does not mark the order paid.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  @ApiResponse({
    status: 409,
    type: ApiErrorDto,
    description: 'Order not awaiting online payment.',
  })
  initiate(
    @CurrentActor() actor: Actor,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: InitiatePaymentDto,
  ) {
    return this.payments.initiate(actor, orderId, dto);
  }

  @Get('payment')
  @ApiOperation({ summary: 'The payment status for one of my orders' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  get(@CurrentActor() actor: Actor, @Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.payments.getForCustomer(actor, orderId);
  }
}
