import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Actor } from '../auth/types/actor';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { ListPaymentsQueryDto } from './dto/payment.dto';
import { PaymentsService } from './payments.service';

/**
 * Payment lookup for staff (the admin app). Branch-isolated through the owning
 * order: branch staff see only their branches' payments, owners see all.
 */
@ApiTags('payments (staff)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @RequirePermissions('payments:read')
  @ApiOperation({ summary: 'List payments' })
  list(@CurrentActor() actor: Actor, @Query() query: ListPaymentsQueryDto) {
    return this.payments.listForStaff(actor, query);
  }
}
