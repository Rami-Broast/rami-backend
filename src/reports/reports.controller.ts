import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Actor } from '../auth/types/actor';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { ReportQueryDto } from './dto/report.dto';
import { ReportsService } from './reports.service';

/**
 * Sales, VAT and payment reports for staff.
 *
 * All gated by `reports:read` and branch-isolated: an owner spans every branch,
 * branch staff see only their assignments. Every figure is read from
 * snapshotted order/payment data, so a historical report never moves.
 */
@ApiTags('reports (staff)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@ApiResponse({ status: 400, type: ApiErrorDto, description: 'Invalid reporting window.' })
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('sales')
  @RequirePermissions('reports:read')
  @ApiOperation({
    summary: 'Sales report',
    description: 'Order counts by status and snapshotted revenue over realised sales.',
  })
  sales(@CurrentActor() actor: Actor, @Query() query: ReportQueryDto) {
    return this.reports.salesReport(actor, query);
  }

  @Get('charges')
  @RequirePermissions('reports:read')
  @ApiOperation({
    summary: 'Charges breakdown',
    description:
      'Revenue per charge type (delivery fee, platform fee, custom charges) over realised sales in the window.',
  })
  charges(@CurrentActor() actor: Actor, @Query() query: ReportQueryDto) {
    return this.reports.chargesReport(actor, query);
  }

  @Get('vat')
  @RequirePermissions('reports:read')
  @ApiOperation({
    summary: 'VAT report',
    description: 'Gross output VAT over realised sales, grouped by the rate snapshotted per order.',
  })
  vat(@CurrentActor() actor: Actor, @Query() query: ReportQueryDto) {
    return this.reports.vatReport(actor, query);
  }

  @Get('payments')
  @RequirePermissions('reports:read')
  @ApiOperation({
    summary: 'Payments report',
    description: 'Captured and refunded money by payment status and method.',
  })
  payments(@CurrentActor() actor: Actor, @Query() query: ReportQueryDto) {
    return this.reports.paymentsReport(actor, query);
  }

  @Get('drivers')
  @RequirePermissions('reports:read')
  @ApiOperation({
    summary: 'Driver performance report',
    description:
      'Per-driver avg time-to-pickup, avg delivery time and deliveries/day over the window. Completed deliveries only.',
  })
  drivers(@CurrentActor() actor: Actor, @Query() query: ReportQueryDto) {
    return this.reports.driverPerformanceReport(actor, query);
  }

  @Get('refund-window-misses')
  @RequirePermissions('reports:read')
  @ApiOperation({
    summary: 'Customers a refund/cancellation window turned away',
    description:
      'The only view of what the windows *prevented*. A refused customer leaves no request, no refund and no order change, so without this a window that is too short looks exactly like a window nobody needed. `wouldHaveBeenCaughtBy` says how many a longer window would have admitted.',
  })
  refundWindowMisses(@CurrentActor() actor: Actor, @Query() query: ReportQueryDto) {
    return this.reports.refundWindowMissesReport(actor, query);
  }

  @Get('dashboard-kpis')
  @RequirePermissions('reports:read')
  @ApiOperation({
    summary: 'Dashboard KPI tiles',
    description:
      'Compact rollup for the admin home page — avg prep time (CONFIRMED → READY) and avg delivery time (pickedUp → delivered).',
  })
  dashboardKpis(@CurrentActor() actor: Actor, @Query() query: ReportQueryDto) {
    return this.reports.dashboardKpis(actor, query);
  }
}
