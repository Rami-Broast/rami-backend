import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { AuditService } from './audit.service';
import { ListAuditLogQueryDto } from './dto/audit.dto';

/**
 * Read-only view over the append-only audit log (owner-only in the seed).
 * The log itself is written by other modules through {@link AuditRecorder} —
 * no mutation surface is exposed here.
 */
@ApiTags('audit (staff)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions('audit:read')
  @ApiOperation({
    summary: 'Search the audit log',
    description:
      'Filter by actor, entity, branch, outcome, date range or correlation id. All filters are optional; without any, returns the newest rows.',
  })
  list(@Query() query: ListAuditLogQueryDto) {
    return this.audit.list(query);
  }
}
