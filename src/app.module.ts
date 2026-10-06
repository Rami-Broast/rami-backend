import { MiddlewareConsumer, Module, NestModule, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AuditModule } from './audit/audit.module';
import { RequestContextMiddleware } from './common/context/request-context.middleware';
import { RequestContextModule } from './common/context/request-context.module';
import { AuthModule } from './auth/auth.module';
import { BannersModule } from './banners/banners.module';
import { CustomerConfigModule } from './customer-config/customer-config.module';
import { FeatureFlagsModule } from './feature-flags/feature-flags.module';
import { AuthGuard } from './auth/guards/auth.guard';
import { PermissionsGuard } from './auth/guards/permissions.guard';
import { BranchAccessGuard } from './branches/guards/branch-access.guard';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AppConfigService } from './config/app-config.service';
import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { HomepageModule } from './homepage/homepage.module';
import { LoggerModule } from './logger/logger.module';
import { BranchesModule } from './branches/branches.module';
import { ChargesModule } from './charges/charges.module';
import { AssetsModule } from './assets/assets.module';
import { CouponsModule } from './coupons/coupons.module';
import { CustomersModule } from './customers/customers.module';
import { DeliveryModule } from './delivery/delivery.module';
import { DriversModule } from './drivers/drivers.module';
import { LoyaltyModule } from './loyalty/loyalty.module';
import { MenuModule } from './menu/menu.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { PrismaModule } from './prisma/prisma.module';
import { PromotionsModule } from './promotions/promotions.module';
import { PrintingModule } from './printing/printing.module';
import { ReceiptTemplatesModule } from './receipt-templates/receipt-templates.module';
import { RealtimeGatewayModule } from './realtime/realtime-gateway.module';
import { RefundsModule } from './refunds/refunds.module';
import { ReportsModule } from './reports/reports.module';
import { SettlementsModule } from './settlements/settlements.module';
import { UsersModule } from './users/users.module';
import { VatModule } from './vat/vat.module';
import { RestoposZatcaModule } from './zatca-invoicing/restopos-zatca.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule,
    PrismaModule,
    RequestContextModule,

    ThrottlerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.rateLimit.ttlMs,
            limit: config.rateLimit.max,
          },
        ],
      }),
    }),

    HealthModule,
    AuthModule,
    RealtimeGatewayModule,
    VatModule,
    RestoposZatcaModule,
    MenuModule,
    NotificationsModule,
    AssetsModule,
    CouponsModule,
    LoyaltyModule,
    OrdersModule,
    RefundsModule,
    PaymentsModule,
    DriversModule,
    DeliveryModule,
    SettlementsModule,
    ReportsModule,
    CustomersModule,
    BranchesModule,
    ChargesModule,
    BannersModule,
    HomepageModule,
    PromotionsModule,
    PrintingModule,
    ReceiptTemplatesModule,
    UsersModule,
    AuditModule,
    FeatureFlagsModule,
    CustomerConfigModule,

    // Remaining domain modules are introduced by their own phases — see
    // src/README.md.
  ],
  providers: [
    // Every guard below is global for the same reason: a new endpoint must be
    // protected because it exists, not because someone remembered to decorate
    // it. Order matters — they run in the order registered.
    //
    //   1. Throttle   — cheapest rejection first.
    //   2. Auth       — establishes the actor; opt out with @Public().
    //   3. Permission — checks @RequirePermissions() against that actor.
    //   4. Branch     — checks @BranchScoped() against that actor's scope.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: BranchAccessGuard },

    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        // Strips unknown properties, so a client cannot smuggle fields such as
        // `price` or `role` into a DTO that does not declare them.
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
        // Error text must not echo submitted values — they may contain OTPs.
        disableErrorMessages: false,
        validationError: { target: false, value: false },
      }),
    },

    { provide: APP_FILTER, useClass: AllExceptionsFilter },

    // Instantiated with DI so it can reach the global RequestContext; applied
    // to every route in `configure` below.
    RequestContextMiddleware,
  ],
})
export class AppModule implements NestModule {
  /**
   * Opens a request context for every route, before the guards run.
   *
   * It has to be first so the correlation id, IP and user-agent are captured
   * for the whole request — including the auth guard, which fills the actor
   * into the same context once it has resolved one.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
