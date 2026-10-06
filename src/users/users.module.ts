import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * Staff-user administration (owner-only).
 *
 * Depends on the global AuthModule for PasswordService and TokenService; the
 * database is reached via the global PrismaModule.
 */
@Module({
  imports: [AuditModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
