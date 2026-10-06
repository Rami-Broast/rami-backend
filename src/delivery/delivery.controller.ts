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
import { ListCashCollectionsQueryDto } from './dto/cash-collection.dto';
import { AssignDriverDto, ListDeliveriesQueryDto, UnassignDriverDto } from './dto/delivery.dto';

/**
 * Delivery management for staff (the admin app).
 *
 * Branch-isolated on `Delivery.branchId`, copied from the order at the moment
 * its delivery leg opens. Viewing needs `deliveries:read`; assigning a driver
 * needs `deliveries:assign` (owner, or a branch admin for their own branch).
 */
@ApiTags('deliveries (staff)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('deliveries')
export class DeliveryController {
  constructor(
    private readonly delivery: DeliveryService,
    private readonly cash: CashCollectionService,
  ) {}

  @Get('cash-collections')
  @RequirePermissions('deliveries:read')
  @ApiOperation({
    summary: 'Cash-on-delivery reconciliation view',
    description:
      'Per-driver / per-shift settlement — lists the driver-reported cash collections with per-window totals of expected, collected and variance. Branch-scoped for BRANCH_ADMIN.',
  })
  cashCollections(@CurrentActor() actor: Actor, @Query() query: ListCashCollectionsQueryDto) {
    return this.cash.listForStaff(actor, query);
  }

  @Get('cash-collections/:id')
  @RequirePermissions('deliveries:read')
  @ApiOperation({ summary: 'Get one cash collection' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  cashCollection(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.cash.getForStaff(actor, id);
  }

  @Get()
  @RequirePermissions('deliveries:read')
  @ApiOperation({ summary: 'List deliveries' })
  list(@CurrentActor() actor: Actor, @Query() query: ListDeliveriesQueryDto) {
    return this.delivery.listForStaff(actor, query);
  }

  @Get(':id')
  @RequirePermissions('deliveries:read')
  @ApiOperation({ summary: 'Get one delivery' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  get(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.delivery.getForStaff(actor, id);
  }

  @Post(':id/assign')
  @RequirePermissions('deliveries:assign')
  @ApiOperation({
    summary: 'Assign a driver',
    description: 'Moves the delivery to ASSIGNED and the order to DRIVER_ASSIGNED together.',
  })
  @ApiResponse({
    status: 400,
    type: ApiErrorDto,
    description: 'The driver is not currently available.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto, description: 'Delivery or driver not found.' })
  @ApiResponse({
    status: 409,
    type: ApiErrorDto,
    description: 'This delivery already has a driver.',
  })
  assign(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignDriverDto,
  ) {
    return this.delivery.assignDriver(actor, id, dto);
  }

  @Post(':id/unassign')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('deliveries:assign')
  @ApiOperation({
    summary: 'Take a delivery back off its driver',
    description:
      'Returns the delivery to the pool and the order to READY, and frees the driver if they are still on shift. Only before pickup — once the food is in the car, report a failed delivery instead. Without this a driver who went off shift, lost their phone or was deactivated left the delivery unassignable to anyone else.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto, description: 'Delivery not found.' })
  @ApiResponse({
    status: 409,
    type: ApiErrorDto,
    description: 'Already picked up, or no longer assigned.',
  })
  unassign(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UnassignDriverDto,
  ) {
    return this.delivery.unassignDriver(actor, id, dto.reason);
  }
}
