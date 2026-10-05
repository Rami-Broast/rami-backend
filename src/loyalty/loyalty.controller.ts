import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Actor } from '../auth/types/actor';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { AdjustLoyaltyDto } from './dto/loyalty.dto';
import { LoyaltyService } from './loyalty.service';

/** Loyalty for the customer app: their own balance and ledger. */
@ApiTags('loyalty (customer)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@Controller('customer/loyalty')
export class CustomerLoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get()
  @ApiOperation({ summary: 'My loyalty balance and points history' })
  mine(@CurrentActor() actor: Actor, @Query() query: PaginationQueryDto) {
    return this.loyalty.ledger(actor.id, query);
  }
}

/** Loyalty administration for staff. */
@ApiTags('loyalty (staff)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('loyalty')
export class LoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Post('adjust')
  @RequirePermissions('loyalty:adjust')
  @ApiOperation({
    summary: 'Manually adjust a customer’s points',
    description: 'Creates a new signed ledger entry, attributed and audited — never edits history.',
  })
  adjust(@CurrentActor() actor: Actor, @Body() dto: AdjustLoyaltyDto) {
    return this.loyalty.adjust(actor, dto.customerId, dto.points, dto.reason);
  }

  @Get(':customerId')
  @RequirePermissions('loyalty:read')
  @ApiOperation({ summary: 'A customer’s loyalty balance and ledger' })
  ledger(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.loyalty.ledger(customerId, query);
  }
}
