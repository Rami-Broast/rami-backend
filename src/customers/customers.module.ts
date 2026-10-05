import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AddressesController } from './addresses.controller';
import { CustomerDirectoryController } from './customer-directory.controller';
import { CustomerDirectoryService } from './customer-directory.service';
import { CustomerProfileController } from './customer-profile.controller';
import { CustomersService } from './customers.service';

/**
 * Customers module.
 *
 * Two distinct surfaces that share the underlying `Customer` table:
 * - `CustomersService` / `AddressesController` — the caller's own addresses.
 * - `CustomerDirectoryService` / `CustomerDirectoryController` — staff read
 *   view over the whole table, gated by `customers:read` and scoped to the
 *   caller's branches for BRANCH_ADMIN.
 *
 * Kept as separate services so a bug in one can never silently apply to the
 * other (a staff read is not a self-read).
 */
@Module({
  // `AuthModule` for `TokenService`: deleting an account has to revoke its
  // sessions, or the deleted customer stays signed in on every other device
  // until the refresh token expires. `AuthModule` does not import this one, so
  // there is no cycle.
  imports: [AuthModule],
  controllers: [AddressesController, CustomerDirectoryController, CustomerProfileController],
  providers: [CustomersService, CustomerDirectoryService],
  exports: [CustomersService, CustomerDirectoryService],
})
export class CustomersModule {}
