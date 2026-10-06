import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { Actor } from '../auth/types/actor';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { NotificationsQueryService } from './notifications-query.service';

/**
 * The customer app's notification feed. Ownership is enforced by customer id —
 * a customer reads only their own notifications.
 */
@ApiTags('notifications (customer)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@Controller('customer/notifications')
export class CustomerNotificationsController {
  constructor(private readonly notifications: NotificationsQueryService) {}

  @Get()
  @ApiOperation({ summary: 'List my notifications' })
  list(@CurrentActor() actor: Actor, @Query() query: PaginationQueryDto) {
    return this.notifications.listForCustomer(actor, query);
  }
}
