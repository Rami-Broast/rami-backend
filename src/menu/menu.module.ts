import { Module } from '@nestjs/common';

import { BranchesModule } from '../branches/branches.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { MenuController } from './menu.controller';
import { MenuService } from './menu.service';

@Module({
  // `BranchesModule` for the opening-hours rule on the public branch list.
  imports: [PromotionsModule, BranchesModule],
  controllers: [MenuController, CatalogController],
  providers: [MenuService, CatalogService],
  exports: [CatalogService],
})
export class MenuModule {}
