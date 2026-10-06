import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { BranchScoped } from '../branches/decorators/branch-scoped.decorator';
import { Actor } from '../auth/types/actor';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { UpdateBranchDocketOverrideDto, UpdateDocketTemplateDto } from './dto/receipt-template.dto';
import { DocketTemplate } from './receipt-template';
import { ReceiptTemplatesService } from './receipt-templates.service';

@ApiTags('receipt templates')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('receipt-templates')
export class ReceiptTemplatesController {
  constructor(private readonly templates: ReceiptTemplatesService) {}

  @Get('default')
  @RequirePermissions('receipt-template:read')
  @ApiOperation({ summary: "The organisation's docket template" })
  organisationDefault() {
    return this.templates.organisationDefault();
  }

  @Get('shipped')
  @RequirePermissions('receipt-template:read')
  @ApiOperation({ summary: 'The built-in template, for a reset' })
  shipped() {
    return { template: this.templates.shipped() };
  }

  @Put('default')
  @RequirePermissions('receipt-template:write')
  @ApiOperation({ summary: "Replace the organisation's docket template" })
  saveDefault(@CurrentActor() actor: Actor, @Body() dto: UpdateDocketTemplateDto) {
    return this.templates.saveOrganisationDefault(actor, dto as unknown as DocketTemplate);
  }

  /**
   * What this branch prints. The POS reads this on sign-in and before a print,
   * so it is the one endpoint that must work for counter staff.
   */
  @Get('branches/:branchId')
  @RequirePermissions('receipt-template:read')
  @BranchScoped('branchId')
  @ApiOperation({ summary: "A branch's resolved docket template" })
  forBranch(@CurrentActor() actor: Actor, @Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.templates.forBranch(actor, branchId);
  }

  @Put('branches/:branchId')
  @RequirePermissions('receipt-template:branch')
  @BranchScoped('branchId')
  @ApiOperation({ summary: "Set this branch's override of the owner's template" })
  saveBranch(
    @CurrentActor() actor: Actor,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: UpdateBranchDocketOverrideDto,
  ) {
    return this.templates.saveBranchOverride(actor, branchId, dto);
  }

  @Delete('branches/:branchId')
  @RequirePermissions('receipt-template:branch')
  @BranchScoped('branchId')
  @ApiOperation({ summary: "Drop this branch back to the owner's template" })
  clearBranch(@CurrentActor() actor: Actor, @Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.templates.clearBranchOverride(actor, branchId);
  }
}
