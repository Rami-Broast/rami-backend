import { Body, Controller, Get, HttpCode, HttpStatus, Patch } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Actor } from '../auth/types/actor';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import {
  SetDriverAvailabilityDto,
  SetOnlineStatusDto,
  UpdateDriverLocationDto,
} from './dto/driver.dto';
import { DriversService } from './drivers.service';

/**
 * The driver app's own-profile surface.
 *
 * Gated by `deliveries:own` — the only permission the DRIVER role holds — and
 * every method resolves the profile by the caller's own user id, never by a
 * supplied driver id, so a driver can only ever act on their own shift status
 * and location.
 */
@ApiTags('drivers (self-service)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('driver/me')
export class DriverSelfController {
  constructor(private readonly drivers: DriversService) {}

  @Get()
  @RequirePermissions('deliveries:own')
  @ApiOperation({ summary: 'My driver profile' })
  @ApiResponse({ status: 404, type: ApiErrorDto, description: 'No driver profile exists yet.' })
  getProfile(@CurrentActor() actor: Actor) {
    return this.drivers.getOwnProfile(actor);
  }

  @Patch('status')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('deliveries:own')
  @ApiOperation({
    summary: 'Go online or offline',
    description:
      'Going online makes the driver available unless already mid-delivery. Going offline always clears availability.',
  })
  setOnlineStatus(@CurrentActor() actor: Actor, @Body() dto: SetOnlineStatusDto) {
    return this.drivers.setOnlineStatus(actor, dto.isOnline);
  }

  @Patch('availability')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('deliveries:own')
  @ApiOperation({
    summary: 'Step away or return while on shift',
    description: 'Rejected while online is false, or while a delivery is in progress.',
  })
  @ApiResponse({ status: 400, type: ApiErrorDto, description: 'Not currently online.' })
  @ApiResponse({ status: 409, type: ApiErrorDto, description: 'A delivery is in progress.' })
  setAvailability(@CurrentActor() actor: Actor, @Body() dto: SetDriverAvailabilityDto) {
    return this.drivers.setAvailability(actor, dto.isAvailable);
  }

  @Patch('location')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('deliveries:own')
  @ApiOperation({ summary: 'Report current location' })
  updateLocation(@CurrentActor() actor: Actor, @Body() dto: UpdateDriverLocationDto) {
    return this.drivers.updateLocation(actor, dto.latitude, dto.longitude);
  }
}
