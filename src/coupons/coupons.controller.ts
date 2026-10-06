import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { CreateCouponDto, UpdateCouponDto } from './dto/coupon.dto';
import { CouponsService } from './coupons.service';

/**
 * Coupon management for staff. Coupons are organisation-wide (like the catalog),
 * so creating and viewing them is `coupons:write` / `coupons:read` — an owner
 * concern. Their per-branch applicability is expressed as a BRANCH rule.
 */
@ApiTags('coupons (staff)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('coupons')
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @Post()
  @RequirePermissions('coupons:write')
  @ApiOperation({ summary: 'Create a coupon with its eligibility rules' })
  @ApiResponse({ status: 409, type: ApiErrorDto, description: 'Code already exists.' })
  create(@Body() dto: CreateCouponDto) {
    return this.coupons.create(dto);
  }

  @Get()
  @RequirePermissions('coupons:read')
  @ApiOperation({ summary: 'List coupons' })
  list(@Query() query: PaginationQueryDto) {
    return this.coupons.list(query);
  }

  @Patch(':id')
  @RequirePermissions('coupons:write')
  @ApiOperation({
    summary: 'Update a coupon’s presentation and availability',
    description:
      'Name, description, offer artwork, whether it is listed on the customer app’s Offers ' +
      'page, and whether it is redeemable at all. The code, discount, validity window and ' +
      'usage limits are the terms customers were given and past redemptions were made under, ' +
      'so they are deliberately not editable — a different offer is a different coupon.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCouponDto) {
    return this.coupons.update(id, dto);
  }

  @Get(':id')
  @RequirePermissions('coupons:read')
  @ApiOperation({ summary: 'Get one coupon with rules and usage count' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.coupons.get(id);
  }
}
