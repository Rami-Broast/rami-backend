import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { Actor } from '../auth/types/actor';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { IdempotencyKey } from '../common/idempotency/idempotency-key.decorator';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import {
  CustomerCancelOrderDto,
  MyOrdersQueryDto,
  PlaceOrderDto,
  QuoteOrderDto,
} from './dto/order.dto';
import { OrdersService } from './orders.service';

/**
 * The customer app's order surface.
 *
 * These routes carry no permission requirement — customers hold none — so
 * ownership is enforced in the service by customer id: a customer reaches only
 * their own orders, and a missing or someone-else's order id returns the same
 * "not found" so ids cannot be probed. Authentication is still required; the
 * global auth guard establishes the customer actor.
 */
@ApiTags('orders (customer)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@Controller('customer/orders')
export class CustomerOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Place an order',
    description:
      'The request carries what to buy, never what it costs. The catalog and VAT engine decide every price, and the breakdown is snapshotted onto the order. Send an `Idempotency-Key` header — one value per checkout attempt, not per request — and a retry after a timeout replays the original order instead of placing a second one.',
  })
  @ApiResponse({
    status: 400,
    type: ApiErrorDto,
    description: 'Item unavailable, branch closed, or method not offered.',
  })
  @ApiResponse({ status: 403, type: ApiErrorDto, description: 'Only customers may place orders.' })
  @ApiResponse({
    status: 409,
    type: ApiErrorDto,
    description: 'A request with this idempotency key is still being processed.',
  })
  @ApiResponse({
    status: 422,
    type: ApiErrorDto,
    description: 'This idempotency key was already used for a different request.',
  })
  place(
    @CurrentActor() actor: Actor,
    @Body() dto: PlaceOrderDto,
    @IdempotencyKey() idempotencyKey?: string,
  ) {
    // Scoped per customer, so two customers cannot collide on a key one of
    // them generated badly.
    return this.idempotency.run(`order.place:${actor.id}`, idempotencyKey, dto, () =>
      this.orders.placeOrder(actor, dto),
    );
  }

  @Post('quote')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview a cart price, optionally with a coupon',
    description:
      'Authenticated so a coupon can be evaluated for this customer. Read-only — no usage is recorded; the coupon is applied atomically only at placement. An invalid coupon returns the base price plus a couponError message.',
  })
  @ApiResponse({ status: 400, type: ApiErrorDto, description: 'Item unavailable or cart invalid.' })
  @ApiResponse({
    status: 403,
    type: ApiErrorDto,
    description: 'Only customers may request a quote.',
  })
  quote(@CurrentActor() actor: Actor, @Body() dto: QuoteOrderDto) {
    return this.orders.quoteForCustomer(actor, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List my orders' })
  list(@CurrentActor() actor: Actor, @Query() query: MyOrdersQueryDto) {
    return this.orders.listForCustomer(actor, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Track one of my orders',
    description: 'The order with its full status history, for live tracking.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  get(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.getForCustomer(actor, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel one of my orders',
    description:
      "Allowed only before the kitchen starts preparing **and only while nothing has been paid** — once a payment is captured, cancelling means giving money back, which is the branch's decision. A paid order is refused here and must go through `POST /customer/orders/:id/refund-request` instead. A reason is required.",
  })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  @ApiResponse({ status: 409, type: ApiErrorDto, description: 'Too late to cancel.' })
  cancel(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CustomerCancelOrderDto,
  ) {
    return this.orders.cancelByCustomer(actor, id, dto);
  }
}
