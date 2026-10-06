import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Actor } from '../auth/types/actor';
import { BranchScoped } from '../branches/decorators/branch-scoped.decorator';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { IdempotencyKey } from '../common/idempotency/idempotency-key.decorator';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { UpdateOrderItemDto } from './dto/order-edit.dto';
import {
  CancelOrderDto,
  CounterOrderDto,
  ListOrdersQueryDto,
  RejectOrderDto,
} from './dto/order.dto';
import { OrderEditsService } from './order-edits.service';
import { OrdersService } from './orders.service';

/**
 * Order management for staff (the admin app — owner and branch views).
 *
 * Every route is branch-isolated server-side: list queries are filtered to the
 * caller's branches, and a route acting on one order asserts access to that
 * order's branch before doing anything. Kitchen transitions are gated with
 * `orders:kitchen`; cancellation with `orders:cancel`.
 */
@ApiTags('orders (staff)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly edits: OrderEditsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  @RequirePermissions('orders:write')
  @ApiOperation({
    summary: 'Place a counter order (Branch POS)',
    description:
      'A branch member takes a walk-in or phone order on a customer’s behalf. The branch is validated against the caller’s scope, so a branch user can only place orders for their own branch. The cart is priced entirely server-side — no price is accepted from the client — and payment is settled at the counter (cash) or on delivery (COD). Online/card payment stays the customer app’s flow.',
  })
  @ApiResponse({
    status: 400,
    type: ApiErrorDto,
    description:
      'Item unavailable, branch closed/at minimum, method not offered, or address missing.',
  })
  @ApiResponse({ status: 403, type: ApiErrorDto, description: 'Not your branch.' })
  @ApiResponse({
    status: 409,
    type: ApiErrorDto,
    description: 'A request with this idempotency key is still being processed.',
  })
  placeCounterOrder(
    @CurrentActor() actor: Actor,
    @Body() dto: CounterOrderDto,
    @IdempotencyKey() idempotencyKey?: string,
  ) {
    // A counter terminal on flaky branch wifi retries too, and a duplicate
    // walk-in order is a second meal the kitchen cooks.
    return this.idempotency.run(`order.counter:${actor.id}`, idempotencyKey, dto, () =>
      this.orders.placeOrderForStaff(actor, dto),
    );
  }

  @Patch(':id/items/:itemId')
  @RequirePermissions('orders:write')
  @ApiOperation({
    summary: 'Edit an item on a placed order',
    description:
      'Correct an item quantity or notes on an order still in a pre-shipping status. Records who / why / old / new in an append-only history. The order-level totals are NOT re-priced here (follow-up on the money side) — the item-line totals are recalculated to keep per-line invariants consistent.',
  })
  @ApiResponse({
    status: 400,
    type: ApiErrorDto,
    description: 'Order is past the editable window.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  updateItem(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateOrderItemDto,
  ) {
    return this.edits.updateItem(actor, id, itemId, dto);
  }

  @Get(':id/edits')
  @RequirePermissions('orders:read')
  @ApiOperation({ summary: 'List every edit applied to this order' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  listEdits(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.edits.listEdits(actor, id);
  }

  @Get()
  @RequirePermissions('orders:read')
  @ApiOperation({
    summary: 'List orders',
    description:
      'Filtered to the caller’s branches. Owners see all branches; branch staff see only their own, whether or not a branchId filter is supplied.',
  })
  list(@CurrentActor() actor: Actor, @Query() query: ListOrdersQueryDto) {
    return this.orders.listForStaff(actor, query);
  }

  @Get('kitchen/queue')
  @RequirePermissions('orders:kitchen')
  @BranchScoped('branchId')
  @ApiOperation({
    summary: 'The live kitchen queue for a branch',
    description: 'Confirmed, preparing and ready orders, oldest first.',
  })
  kitchenQueue(@CurrentActor() actor: Actor, @Query('branchId', ParseUUIDPipe) branchId: string) {
    return this.orders.kitchenQueue(actor, branchId);
  }

  @Get('awaiting-acceptance/queue')
  @RequirePermissions('orders:kitchen')
  @BranchScoped('branchId')
  @ApiOperation({
    summary: 'Orders waiting for the branch to accept or reject',
    description:
      'Populated only for branches with autoAcceptOrders=false. Oldest first, so the queue drains FIFO.',
  })
  awaitingAcceptanceQueue(
    @CurrentActor() actor: Actor,
    @Query('branchId', ParseUUIDPipe) branchId: string,
  ) {
    return this.orders.awaitingAcceptanceQueue(actor, branchId);
  }

  @Get(':id')
  @RequirePermissions('orders:read')
  @ApiOperation({ summary: 'Get one order with items and status history' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  get(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.getForStaff(actor, id);
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('orders:kitchen')
  @ApiOperation({
    summary: 'Branch accepts an order (§7)',
    description: 'Promotes an AWAITING_ACCEPTANCE order to CONFIRMED for the kitchen.',
  })
  @ApiResponse({ status: 409, type: ApiErrorDto, description: 'Not a legal transition.' })
  accept(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.accept(actor, id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('orders:kitchen')
  @ApiOperation({
    summary: 'Branch rejects an order (§7)',
    description:
      'Cancels an AWAITING_ACCEPTANCE order with a required reason recorded on the status history.',
  })
  @ApiResponse({ status: 409, type: ApiErrorDto, description: 'Not a legal transition.' })
  reject(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectOrderDto,
  ) {
    return this.orders.reject(actor, id, dto.reason);
  }

  @Post(':id/preparing')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('orders:kitchen')
  @ApiOperation({ summary: 'Start preparing a confirmed order' })
  @ApiResponse({ status: 409, type: ApiErrorDto, description: 'Not a legal transition.' })
  markPreparing(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.markPreparing(actor, id);
  }

  @Post(':id/ready')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('orders:kitchen')
  @ApiOperation({ summary: 'Mark a preparing order ready' })
  @ApiResponse({ status: 409, type: ApiErrorDto, description: 'Not a legal transition.' })
  markReady(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.markReady(actor, id);
  }

  @Post(':id/complete-pickup')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('orders:kitchen')
  @ApiOperation({
    summary: 'Mark a pickup order collected',
    description: 'Pickup orders only. A delivery order is completed through its delivery.',
  })
  @ApiResponse({ status: 400, type: ApiErrorDto, description: 'Not a pickup order.' })
  @ApiResponse({ status: 409, type: ApiErrorDto, description: 'Not a legal transition.' })
  completePickup(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.completePickup(actor, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('orders:cancel')
  @ApiOperation({ summary: 'Cancel an order' })
  @ApiResponse({ status: 409, type: ApiErrorDto, description: 'Order can no longer be cancelled.' })
  cancel(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelOrderDto,
  ) {
    return this.orders.cancelByStaff(actor, id, dto);
  }
}
