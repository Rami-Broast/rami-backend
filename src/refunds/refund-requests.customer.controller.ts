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
import { Actor } from '../auth/types/actor';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { CreateRefundRequestDto, MyRefundRequestsQueryDto } from './dto/refund-request.dto';
import { RefundRequestsService } from './refund-requests.service';

/**
 * The customer's side: asking to cancel an order the kitchen has already
 * started, or asking for money back on one that has arrived.
 *
 * Like the rest of the customer surface these routes carry no permission —
 * customers hold none — and ownership is enforced in the service by customer id.
 * An order belonging to someone else returns the same "not found" as one that
 * does not exist, so ids cannot be probed.
 *
 * `POST /customer/orders/:id/cancel` (order engine) is still the fast path while
 * the order is early enough to cancel outright; this is what happens after that.
 * `GET .../refund-eligibility` says which of the two a client should offer, so
 * the rule lives on the server and no app carries a second copy of it.
 */
@ApiTags('refund requests (customer)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@Controller()
export class CustomerRefundRequestsController {
  constructor(private readonly requests: RefundRequestsService) {}

  @Get('customer/orders/:id/refund-eligibility')
  @ApiOperation({
    summary: 'Can I cancel this order, or ask for a refund?',
    description:
      'Returns whether the order can still be cancelled outright, whether a request can be raised, what such a request would be, and a customer-facing sentence for every case.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  eligibility(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.requests.eligibilityForCustomer(actor, id);
  }

  @Post('customer/orders/:id/refund-request')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Ask the branch to cancel this order or refund it',
    description:
      'One open request per order — a second while one is pending returns the open one rather than filing the same complaint twice.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  @ApiResponse({
    status: 409,
    type: ApiErrorDto,
    description: 'Not something that can be requested — the body says why.',
  })
  create(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateRefundRequestDto,
  ) {
    return this.requests.createForCustomer(actor, id, dto);
  }

  @Get('customer/refund-requests')
  @ApiOperation({ summary: 'List my refund and cancellation requests' })
  list(@CurrentActor() actor: Actor, @Query() query: MyRefundRequestsQueryDto) {
    return this.requests.listForCustomer(actor, query);
  }

  @Post('customer/refund-requests/:id/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Withdraw a request the branch has not decided yet',
    description: 'Changed your mind. Only possible while it is still pending.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  @ApiResponse({ status: 409, type: ApiErrorDto, description: 'Already decided.' })
  withdraw(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.requests.withdrawForCustomer(actor, id);
  }
}
