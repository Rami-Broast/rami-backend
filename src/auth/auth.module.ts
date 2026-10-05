import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuditModule } from '../audit/audit.module';
import { SmsModule } from '../notifications/sms/sms.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ActorService } from './services/actor.service';
import { OtpService } from './services/otp.service';
import { PasswordService } from './services/password.service';
import { TokenService } from './services/token.service';

/**
 * Global so that the application-wide guards registered in AppModule can
 * resolve TokenService and ActorService without every feature module having to
 * re-import this one.
 */
@Global()
@Module({
  imports: [
    // Secret and expiry are passed per call from validated configuration, so
    // they cannot drift from what the config tree says.
    JwtModule.register({}),
    SmsModule,
    AuditModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, ActorService, OtpService, PasswordService, TokenService],
  exports: [AuthService, ActorService, TokenService, PasswordService],
})
export class AuthModule {}
