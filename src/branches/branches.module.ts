import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { RestoposZatcaModule } from '../zatca-invoicing/restopos-zatca.module';

import { BranchesController } from './branches.controller';
import { BranchesService } from './branches.service';
import { BranchHoursController } from './branch-hours.controller';
import { BranchHoursService } from './branch-hours.service';
import { BranchSettingsController } from './branch-settings.controller';
import { BranchSettingsService } from './branch-settings.service';

@Module({
  // For PasswordService: deleting a branch re-checks the operator's own
  // password, so the destructive action needs more than a live session.
  imports: [AuthModule, RestoposZatcaModule, AuditModule],
  controllers: [BranchesController, BranchHoursController, BranchSettingsController],
  providers: [BranchesService, BranchHoursService, BranchSettingsService],
  exports: [BranchesService, BranchHoursService, BranchSettingsService],
})
export class BranchesModule {}
