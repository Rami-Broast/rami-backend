import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { Actor } from '../auth/types/actor';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { DeliveryService } from './delivery.service';

/**
 * The customer app's live-tracking surface for their own order's delivery.
 *
 * No permission requirement — customers hold none — so ownership is enforced in
 * the service by the order's customer id. Returns the delivery with the driver's
 * current map location (never a phone number).
 */
@ApiTags('deliveries (customer)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@Controller('customer/orders')
export class CustomerDeliveryController {
  constructor(private readonly delivery: DeliveryService) {}

  @Get(':orderId/delivery')
  @ApiOperation({ summary: 'Track my order’s delivery (status + driver location)' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  track(@CurrentActor() actor: Actor, @Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.delivery.getTrackingForCustomer(actor.id, orderId);
  }
}
