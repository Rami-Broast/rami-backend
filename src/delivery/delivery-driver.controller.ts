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
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Actor } from '../auth/types/actor';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { CashCollectionService } from './cash-collection.service';
import { DeliveryService } from './delivery.service';
import { RecordCashCollectedDto } from './dto/cash-collection.dto';
import {
  DeliveryProgressDto,
  MarkDeliveredDto,
  MarkDeliveryFailedDto,
  MyDeliveriesQueryDto,
} from './dto/delivery.dto';

/**
 * The driver app's delivery surface.
 *
 * Gated by `deliveries:own` — the only permission the DRIVER role holds.
 * Ownership is enforced in the service, not here: every method resolves the
 * caller's own driver profile and checks the delivery belongs to it, and an
 * unowned or unknown delivery id returns the same 404 so ids cannot be probed.
 */
@ApiTags('deliveries (driver)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('driver/deliveries')
export class DeliveryDriverController {
  constructor(
    private readonly delivery: DeliveryService,
    private readonly cash: CashCollectionService,
  ) {}

  @Get()
  @RequirePermissions('deliveries:own')
  @ApiOperation({ summary: 'My deliveries' })
  list(@CurrentActor() actor: Actor, @Query() query: MyDeliveriesQueryDto) {
    return this.delivery.myDeliveries(actor, query);
  }

  @Get(':id')
  @RequirePermissions('deliveries:own')
  @ApiOperation({ summary: 'Get one of my deliveries' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  get(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.delivery.getOwnDelivery(actor, id);
  }

  @Post(':id/picked-up')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('deliveries:own')
  @ApiOperation({ summary: 'Mark collected from the branch' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  @ApiResponse({ status: 409, type: ApiErrorDto, description: 'Not a legal transition.' })
  pickedUp(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeliveryProgressDto,
  ) {
    return this.delivery.markPickedUp(actor, id, dto);
  }

  @Post(':id/out-for-delivery')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('deliveries:own')
  @ApiOperation({ summary: 'Mark en route to the customer' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  @ApiResponse({ status: 409, type: ApiErrorDto, description: 'Not a legal transition.' })
  outForDelivery(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeliveryProgressDto,
  ) {
    return this.delivery.markOutForDelivery(actor, id, dto);
  }

  @Post(':id/delivered')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('deliveries:own')
  @ApiOperation({ summary: 'Mark delivered', description: 'Records proof of delivery.' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  @ApiResponse({ status: 409, type: ApiErrorDto, description: 'Not a legal transition.' })
  delivered(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkDeliveredDto,
  ) {
    return this.delivery.markDelivered(actor, id, dto);
  }

  @Post(':id/failed')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('deliveries:own')
  @ApiOperation({
    summary: 'Report a delivery that could not be completed',
    description:
      'Only after pickup — before pickup, staff should cancel the order instead. Does not change the order’s fulfilment status; staff resolve it manually.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  @ApiResponse({ status: 409, type: ApiErrorDto, description: 'Not a legal transition.' })
  failed(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkDeliveryFailedDto,
  ) {
    return this.delivery.markFailed(actor, id, dto);
  }

  @Post(':id/cash-collected')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('deliveries:own')
  @ApiOperation({
    summary: 'Record the cash the driver took for a COD delivery',
    description:
      'One row per delivery. The service copies the expected amount from the payment and computes the variance server-side — the client only sends what was actually collected plus an optional note. Immutable; a mistyped amount cannot be edited.',
  })
  @ApiResponse({
    status: 400,
    type: ApiErrorDto,
    description: 'Not COD, or delivery not delivered.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  @ApiResponse({ status: 409, type: ApiErrorDto, description: 'Already recorded.' })
  cashCollected(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordCashCollectedDto,
  ) {
    return this.cash.recordCollected(actor, id, dto);
  }
}
