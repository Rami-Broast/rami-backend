import { Controller, Get, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { Actor } from '../auth/types/actor';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { ZatcaInvoicingService } from './zatca-invoicing.service';

/**
 * The customer's digital tax invoice for one of their orders.
 *
 * No permission requirement (customers hold none); ownership is by customer id
 * in the service, and a missing or someone-else's order returns 404 so ids
 * cannot be probed — the same contract as the rest of `customer/orders`.
 */
@ApiTags('orders (customer)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@Controller('customer/orders/:orderId/invoice')
export class CustomerZatcaInvoiceController {
  constructor(private readonly zatca: ZatcaInvoicingService) {}

  @Get()
  @ApiOperation({
    summary: "The order's ZATCA tax invoice",
    description:
      'Returns the tax invoice RestoPOS issued for this order — serial, QR, totals and submission status — or 404 if none exists yet.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto, description: 'No invoice for this order yet.' })
  async get(@CurrentActor() actor: Actor, @Param('orderId', ParseUUIDPipe) orderId: string) {
    const invoice = await this.zatca.getInvoiceForCustomer(actor.id, orderId);
    if (!invoice) {
      throw new NotFoundException('No tax invoice is available for this order yet.');
    }
    return invoice;
  }
}
