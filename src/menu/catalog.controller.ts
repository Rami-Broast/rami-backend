import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { PromotionsService } from '../promotions/promotions.service';
import { PriceQuote } from '../vat/pricing.types';
import { VatService } from '../vat/vat.service';
import { CatalogService } from './catalog.service';
import { QuoteCartDto } from './dto/menu.dto';

@ApiTags('catalog')
@Controller()
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly vat: VatService,
    private readonly promotions: PromotionsService,
  ) {}

  /**
   * Public because customers browse before they sign in, and a menu is public
   * information. It exposes nothing but what is already printed on the wall.
   */
  /**
   * Public list of branches to order from. Public information, like the menu —
   * a customer browses before signing in.
   *
   * Deliberately **not** mounted at `GET /branches`: that path is the staff
   * resource served by `BranchesController`, and when both were registered the
   * public one won. The admin app's Branches page then received the customer
   * projection, which carries no `code` and no `status` — so the status chip
   * rendered blank and the wrong lifecycle buttons appeared (Activate on an
   * already-active branch, and never Suspend or Close). Two audiences need two
   * projections, so they get two paths, under the same `customer/` prefix as
   * the rest of the customer-facing surface.
   */
  @Public()
  @Get('customer/branches')
  @ApiOperation({ summary: 'List active branches customers can order from' })
  branches() {
    return this.catalog.listBranches();
  }

  @Public()
  @Get('branches/:branchId/menu')
  @ApiOperation({
    summary: 'The menu for one branch',
    description:
      'Only items the branch currently sells, priced with any branch override applied. Prices are VAT-inclusive minor units.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto, description: 'Branch not found.' })
  menu(@Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.catalog.menuForBranch(branchId);
  }

  /**
   * Prices a cart without creating an order.
   *
   * The client sends what it wants to buy — never what it thinks anything
   * costs. Every price is read from the catalog and every total comes from the
   * VAT engine, so this response is the only authority on the payable amount.
   * Clients display it; they do not recompute it.
   */
  @Post('pricing/quote')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Price a cart',
    description:
      'Returns the full breakdown the order will be created with. The request carries no prices — a client cannot influence what is charged.',
  })
  @ApiResponse({ status: 400, type: ApiErrorDto, description: 'Item unavailable or cart invalid.' })
  @ApiResponse({ status: 401, type: ApiErrorDto })
  async quote(@Body() dto: QuoteCartDto): Promise<PriceQuote> {
    const lines = await this.catalog.resolveCartLines(dto.branchId, dto.items, dto.type);

    // No drop-off point here: this route prices a cart, not an address. The
    // delivery leg comes back at the base fee. `POST /customer/orders/quote` is
    // the one that knows the customer's address and returns the real fee, and
    // it is what the customer app uses at checkout.
    const delivery = await this.catalog.quoteDelivery(
      dto.branchId,
      dto.type,
      null,
      this.vat.subtotalOf(lines),
    );

    const deliveryFeeMinor = delivery?.deliveryFeeMinor ?? 0;

    const base = this.vat.price({ currency: 'SAR', lines, deliveryFeeMinor });

    // A standing promotion is part of the price, so it belongs in the number
    // this route returns. The Branch POS prices its running total here and then
    // places through `placeOrderForStaff`, which applies promotions — without
    // this the counter would read one figure out to the customer and the till
    // would take a smaller one, and the member of staff would have no idea why.
    const promotion = await this.promotions.evaluateForCart({
      branchId: dto.branchId,
      lines: base.lines.map((line) => ({
        productId: line.productId,
        grossMinor: line.lineSubtotalMinor,
      })),
      subtotalMinor: base.subtotalMinor,
      deliveryFeeMinor,
    });

    if (!promotion) return base;

    return this.vat.price({
      currency: 'SAR',
      lines,
      deliveryFeeMinor,
      discounts: [promotion.discount],
    });
  }
}
