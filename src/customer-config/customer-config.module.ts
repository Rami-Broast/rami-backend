import { Module } from '@nestjs/common';

import { BannersModule } from '../banners/banners.module';
import { CouponsModule } from '../coupons/coupons.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { HomepageModule } from '../homepage/homepage.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { CustomerConfigController } from './customer-config.controller';
import { CustomerConfigService } from './customer-config.service';

@Module({
  imports: [FeatureFlagsModule, BannersModule, HomepageModule, PromotionsModule, CouponsModule],
  controllers: [CustomerConfigController],
  providers: [CustomerConfigService],
  exports: [CustomerConfigService],
})
export class CustomerConfigModule {}
