import { Global, Module } from '@nestjs/common';

import { AppConfigModule } from '../config/config.module';
import { PrismaService } from './prisma.service';

/**
 * Global so that domain modules added in later phases can inject
 * {@link PrismaService} without re-importing this module each time.
 */
@Global()
@Module({
  imports: [AppConfigModule],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
