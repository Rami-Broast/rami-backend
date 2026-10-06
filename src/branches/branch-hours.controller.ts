import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { BranchScoped } from './decorators/branch-scoped.decorator';
import { BranchHoursService } from './branch-hours.service';
import { HoursOverrideDto, SetOpeningHoursDto } from './dto/branch-hours.dto';

@ApiTags('branch hours (staff)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('branches/:branchId/hours')
export class BranchHoursController {
  constructor(private readonly hours: BranchHoursService) {}

  @Get()
  @RequirePermissions('branches:read')
  @BranchScoped('branchId')
  @ApiOperation({ summary: 'Get weekly hours and overrides for a branch' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  getHours(@Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.hours.getHours(branchId);
  }

  @Put()
  @RequirePermissions('branches:settings')
  @BranchScoped('branchId')
  @ApiOperation({
    summary: 'Set weekly opening hours (replaces existing)',
    description:
      'Replaces the full weekly schedule. Multiple entries per day are allowed for split shifts.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  setWeeklyHours(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: SetOpeningHoursDto,
  ) {
    return this.hours.setWeeklyHours(branchId, dto);
  }

  @Post('overrides')
  @RequirePermissions('branches:settings')
  @BranchScoped('branchId')
  @ApiOperation({
    summary: 'Add or update a date-specific hours override',
    description: 'Upserts by (branchId, date). Use for holidays, Ramadan, special events.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  addOverride(@Param('branchId', ParseUUIDPipe) branchId: string, @Body() dto: HoursOverrideDto) {
    return this.hours.addOverride(branchId, dto);
  }

  @Delete('overrides/:overrideId')
  @RequirePermissions('branches:settings')
  @BranchScoped('branchId')
  @ApiOperation({ summary: 'Remove a date-specific override' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  removeOverride(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('overrideId', ParseUUIDPipe) overrideId: string,
  ) {
    return this.hours.removeOverride(branchId, overrideId);
  }

  @Get('open')
  @RequirePermissions('branches:read')
  @BranchScoped('branchId')
  @ApiOperation({
    summary: 'Whether the branch is open right now, and when it next opens',
    description:
      'Returns the full state rather than a bare boolean: `configured` is false when nobody has set a schedule (which means unrestricted, not closed), `closedReason` says which kind of closure it is, and `opensAtMinute` lets a screen say "opens at 17:00" instead of just "closed".',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  isOpen(@Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.hours.openState(branchId, new Date());
  }
}
