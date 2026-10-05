import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Actor } from '../auth/types/actor';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import {
  CreateDriverProfileDto,
  ListDriversQueryDto,
  UpdateDriverProfileDto,
} from './dto/driver.dto';
import { DriversService } from './drivers.service';

/**
 * Driver profile management for staff.
 *
 * Drivers are not branch-owned — a driver profile belongs to the organisation
 * and may be assigned a delivery from any branch — so there is no branch
 * isolation to apply here beyond `drivers:read` / `drivers:write`.
 */
@ApiTags('drivers (staff)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('drivers')
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  @Post()
  @RequirePermissions('drivers:write')
  @ApiOperation({
    summary: 'Create a driver profile',
    description: 'The target user must already hold the DRIVER role (see `npm run staff:create`).',
  })
  @ApiResponse({
    status: 400,
    type: ApiErrorDto,
    description: 'The user does not hold the DRIVER role.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto, description: 'User not found.' })
  @ApiResponse({
    status: 409,
    type: ApiErrorDto,
    description: 'A profile already exists for this user.',
  })
  create(@CurrentActor() actor: Actor, @Body() dto: CreateDriverProfileDto) {
    return this.drivers.createProfile(actor, dto);
  }

  @Get()
  @RequirePermissions('drivers:read')
  @ApiOperation({ summary: 'List drivers' })
  list(@CurrentActor() actor: Actor, @Query() query: ListDriversQueryDto) {
    return this.drivers.listForStaff(actor, query);
  }

  @Get(':id')
  @RequirePermissions('drivers:read')
  @ApiOperation({ summary: 'Get one driver' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  get(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.drivers.getForStaff(actor, id);
  }

  @Patch(':id')
  @RequirePermissions('drivers:write')
  @ApiOperation({ summary: 'Update a driver’s vehicle/license details' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  update(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDriverProfileDto,
  ) {
    return this.drivers.updateProfile(actor, id, dto);
  }

  @Post(':id/deactivate')
  @RequirePermissions('drivers:write')
  @ApiOperation({
    summary: 'Deactivate a driver profile',
    description: 'Soft-deletes and pulls the driver off shift.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  deactivate(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.drivers.deactivate(actor, id);
  }
}
