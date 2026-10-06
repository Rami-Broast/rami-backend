import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Actor } from '../auth/types/actor';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { CustomerDirectoryService } from './customer-directory.service';
import { ListCustomersQueryDto } from './dto/customer-directory.dto';

/**
 * Staff customer directory: list + phone/email/name search + one-customer view.
 *
 * OWNER sees every customer. BRANCH_ADMIN sees customers who have ordered
 * from at least one of their assigned branches — enforced at the SQL layer,
 * not at the response layer.
 */
@ApiTags('customers (staff)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('customers')
export class CustomerDirectoryController {
  constructor(private readonly directory: CustomerDirectoryService) {}

  @Get()
  @RequirePermissions('customers:read')
  @ApiOperation({
    summary: 'List customers',
    description:
      'q performs a case-insensitive substring match on phone, email and full name — a support caller reading out the last four digits still finds their record.',
  })
  list(@CurrentActor() actor: Actor, @Query() query: ListCustomersQueryDto) {
    return this.directory.list(actor, query);
  }

  @Get(':id')
  @RequirePermissions('customers:read')
  @ApiOperation({ summary: 'Get one customer with their saved addresses' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  get(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.directory.getById(actor, id);
  }
}
