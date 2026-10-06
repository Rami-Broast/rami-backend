import { Module } from '@nestjs/common';

import { AppConfigModule } from '../config/config.module';
import { PrintingController } from './printing.controller';
import { QzSigningService } from './qz-signing.service';

@Module({
  imports: [AppConfigModule],
  controllers: [PrintingController],
  providers: [QzSigningService],
  exports: [QzSigningService],
})
export class PrintingModule {}
