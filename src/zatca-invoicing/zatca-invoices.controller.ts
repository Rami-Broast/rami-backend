import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsInt, IsISO8601, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ZatcaSubmissionState } from '@prisma/client';

import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Actor } from '../auth/types/actor';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { ZatcaInvoicingService } from './zatca-invoicing.service';

class ListZatcaInvoicesQueryDto {
  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsEnum(ZatcaSubmissionState)
  status?: ZatcaSubmissionState;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

/**
 * Staff view of the ZATCA tax invoices RestoPOS issued.
 *
 * Gated by `orders:read` (held by owner and branch admin) and branch-isolated
 * exactly like reports — an owner spans every branch, a branch admin sees only
 * their own. This is a read of what RestoPOS produced; this backend issues
 * nothing here.
 */
@ApiTags('zatca invoices (staff)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('zatca/invoices')
export class ZatcaInvoicesController {
  constructor(private readonly zatca: ZatcaInvoicingService) {}

  @Get()
  @RequirePermissions('orders:read')
  @ApiOperation({
    summary: 'List ZATCA invoices/credit notes',
    description: 'Branch-isolated; filter by branch, submission status and date window.',
  })
  list(@CurrentActor() actor: Actor, @Query() query: ListZatcaInvoicesQueryDto) {
    return this.zatca.listInvoices(actor, query);
  }

  @Get('summary')
  @RequirePermissions('orders:read')
  @ApiOperation({
    summary: 'Reported / pending / failed counts',
    description: 'Per-branch submission-status tally for the branch-details view.',
  })
  summary(@CurrentActor() actor: Actor, @Query('branchId') branchId?: string) {
    return this.zatca.statusSummary(actor, branchId);
  }

  @Post(':documentId/refresh')
  @RequirePermissions('orders:read')
  @ApiOperation({
    summary: 'Refresh one document status from RestoPOS',
    description: 'Authoritatively re-fetches the submission status (fallback to the webhook).',
  })
  refresh(@CurrentActor() actor: Actor, @Param('documentId') documentId: string) {
    return this.zatca.refreshInvoiceStatus(actor, documentId);
  }
}
