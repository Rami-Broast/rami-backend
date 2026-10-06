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
import { CreateRefundDto, ListRefundsQueryDto } from './dto/refund.dto';
import { RefundsService } from './refunds.service';

/**
 * Refund management for staff.
 *
 * Issuing a refund needs `refunds:write` (owner, or a branch admin for their own
 * branch); viewing needs `refunds:read`. Branch isolation is enforced through
 * the payment's owning order.
 */
@ApiTags('refunds (staff)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('refunds')
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('refunds:write')
  @ApiOperation({
    summary: 'Issue a full or partial refund',
    description:
      'Never exceeds the remaining refundable amount. Idempotent per idempotency key. Completion is asynchronous — the refund is PROCESSING until a verified gateway event confirms it.',
  })
  @ApiResponse({
    status: 400,
    type: ApiErrorDto,
    description: 'Amount invalid or exceeds refundable.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto, description: 'Payment not found.' })
  @ApiResponse({ status: 409, type: ApiErrorDto, description: 'Payment not refundable.' })
  create(@CurrentActor() actor: Actor, @Body() dto: CreateRefundDto) {
    return this.refunds.createRefund(actor, dto);
  }

  @Get()
  @RequirePermissions('refunds:read')
  @ApiOperation({ summary: 'List refunds' })
  list(@CurrentActor() actor: Actor, @Query() query: ListRefundsQueryDto) {
    return this.refunds.listForStaff(actor, query);
  }

  @Get(':id')
  @RequirePermissions('refunds:read')
  @ApiOperation({ summary: 'Get one refund' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  get(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.refunds.getForStaff(actor, id);
  }
}
