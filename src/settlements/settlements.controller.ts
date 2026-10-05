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
import { IngestPayoutDto, ListSettlementsQueryDto } from './dto/settlement.dto';
import { SettlementsService } from './settlements.service';

/**
 * Settlement and reconciliation for staff.
 *
 * Recording a payout needs `settlements:write`; viewing needs
 * `settlements:read`. Branch isolation applies: an organisation-wide settlement
 * (no branch) is owner-only, a branch-scoped one is reachable only by staff
 * assigned to that branch.
 */
@ApiTags('settlements (staff)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('settlements')
export class SettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('settlements:write')
  @ApiOperation({
    summary: 'Record and reconcile a gateway payout',
    description:
      'Matches the payout against our own captured payments and completed refunds, flagging every unmatched, duplicate, missing or unexpected line. Idempotent per (gateway, reference). Settlement is never derived from order totals.',
  })
  @ApiResponse({
    status: 400,
    type: ApiErrorDto,
    description: 'Invalid period, or org-wide payout by branch staff.',
  })
  @ApiResponse({
    status: 409,
    type: ApiErrorDto,
    description: 'This settlement reference is already recorded.',
  })
  ingest(@CurrentActor() actor: Actor, @Body() dto: IngestPayoutDto) {
    return this.settlements.ingestPayout(actor, dto);
  }

  @Get()
  @RequirePermissions('settlements:read')
  @ApiOperation({ summary: 'List settlements' })
  list(@CurrentActor() actor: Actor, @Query() query: ListSettlementsQueryDto) {
    return this.settlements.listForStaff(actor, query);
  }

  @Get(':id')
  @RequirePermissions('settlements:read')
  @ApiOperation({ summary: 'Get one settlement with its reconciled transaction lines' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  get(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.settlements.getForStaff(actor, id);
  }
}
