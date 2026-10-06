import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { ReceiptTemplatesController } from './receipt-templates.controller';
import { ReceiptTemplatesService } from './receipt-templates.service';

@Module({
  imports: [PrismaModule],
  controllers: [ReceiptTemplatesController],
  providers: [ReceiptTemplatesService],
  exports: [ReceiptTemplatesService],
})
export class ReceiptTemplatesModule {}
