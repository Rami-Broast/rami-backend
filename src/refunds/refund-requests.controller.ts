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
import {
  ApproveRefundRequestDto,
  ListRefundRequestsQueryDto,
  RecordRefundIssuedDto,
  RejectRefundRequestDto,
} from './dto/refund-request.dto';
import { RefundRequestsService } from './refund-requests.service';

/**
 * The branch's queue of customer refund and cancellation requests.
 *
 * **Three permissions, because there are three different acts** (owner
 * decision):
 *
 * | Act | Permission | Who holds it |
 * | --- | --- | --- |
 * | See the queue | `refunds:read` | Owner, branch admin |
 * | Approve / decline | `refund-requests:decide` | Owner, branch admin |
 * | Record a refund paid out | `refunds:write` | Owner only |
 *
 * The split is the whole point: a **branch** decides whether a customer gets
 * their money back, and the **owner** is the one who moves it — by issuing the
 * refund in the payment gateway's own dashboard and recording it here.
 * Approving therefore promises money; it does not send any. Reusing
 * `refunds:write` for the decision would also have handed every branch manager
 * the direct-refund button on the Payments page, which is the opposite of what
 * was asked for.
 *
 * Branch isolation is enforced on every route through the request's own
 * `branchId`.
 */
@ApiTags('refund requests (staff)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('refund-requests')
export class RefundRequestsController {
  constructor(private readonly requests: RefundRequestsService) {}

  @Get()
  @RequirePermissions('refunds:read')
  @ApiOperation({
    summary: 'List refund and cancellation requests',
    description: 'Filter by `status=PENDING` for the queue a branch works.',
  })
  list(@CurrentActor() actor: Actor, @Query() query: ListRefundRequestsQueryDto) {
    return this.requests.listForStaff(actor, query);
  }

  @Get(':id')
  @RequirePermissions('refunds:read')
  @ApiOperation({ summary: 'Get one request' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  get(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.requests.getForStaff(actor, id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('refund-requests:decide')
  @ApiOperation({
    summary: 'Approve a request',
    description:
      'Cancels the order where that is still legal and records what is owed, reporting which in `outcome`. **It does not move money**: `AWAITING_PAYOUT` means the owner still has to issue the refund in the gateway dashboard and record it with `POST /:id/record-refund`. The customer is told their refund is being arranged, never that it has been sent.',
  })
  @ApiResponse({
    status: 400,
    type: ApiErrorDto,
    description: 'Amount invalid, or the order can no longer be cancelled.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  @ApiResponse({ status: 409, type: ApiErrorDto, description: 'Already decided.' })
  approve(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveRefundRequestDto,
  ) {
    return this.requests.approve(actor, id, dto);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('refund-requests:decide')
  @ApiOperation({
    summary: 'Decline a request',
    description: 'The note is required and is sent to the customer.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  @ApiResponse({ status: 409, type: ApiErrorDto, description: 'Already decided.' })
  reject(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectRefundRequestDto,
  ) {
    return this.requests.reject(actor, id, dto);
  }

  @Post(':id/record-refund')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('refunds:write')
  @ApiOperation({
    summary: 'Record a refund already issued in the gateway dashboard',
    description:
      'Owner-only, and the act that actually moves the money columns: it writes a COMPLETED `Refund` marked `issuedManually`, updates the payment and the order, reverses loyalty in proportion, and tells the customer their refund has been sent. Do this **after** paying out in the gateway, with its own reference — recording it before means telling a customer money is on its way that is not.',
  })
  @ApiResponse({
    status: 400,
    type: ApiErrorDto,
    description: 'Amount invalid, or nothing left to refund on this order.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  @ApiResponse({
    status: 409,
    type: ApiErrorDto,
    description: 'Not approved, or a refund is already recorded.',
  })
  recordRefund(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordRefundIssuedDto,
  ) {
    return this.requests.recordRefundIssued(actor, id, dto);
  }
}
