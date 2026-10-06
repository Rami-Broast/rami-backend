import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { BranchScoped } from './decorators/branch-scoped.decorator';
import { BranchSettingsService } from './branch-settings.service';
import { UpdateBranchSettingsDto } from './dto/branch-settings.dto';

/**
 * Branch settings for staff (the admin app).
 *
 * `@BranchScoped('branchId')` enforces branch isolation before the handler:
 * an owner may touch any branch, a branch admin only their own. Reading needs
 * `branches:read`; changing needs `branches:settings`.
 */
@ApiTags('branch settings (staff)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('branches/:branchId/settings')
export class BranchSettingsController {
  constructor(private readonly settings: BranchSettingsService) {}

  @Get()
  @RequirePermissions('branches:read')
  @BranchScoped('branchId')
  @ApiOperation({ summary: 'Get a branch’s operating settings' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  get(@Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.settings.get(branchId);
  }

  @Patch()
  @RequirePermissions('branches:settings')
  @BranchScoped('branchId')
  @ApiOperation({
    summary: 'Update operating settings',
    description: 'Turn delivery or pickup on/off, set fees, minimum order and prep time.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  update(@Param('branchId', ParseUUIDPipe) branchId: string, @Body() dto: UpdateBranchSettingsDto) {
    return this.settings.update(branchId, dto);
  }
}
