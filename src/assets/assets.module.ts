import { Module } from '@nestjs/common';

import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';

/**
 * Owner-uploaded artwork. Self-contained: nothing else imports it, because
 * every other module only ever stores the URL this one hands back.
 */
@Module({
  controllers: [AssetsController],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
