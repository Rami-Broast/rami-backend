import { Module } from '@nestjs/common';

import { RealtimeModule } from '../realtime/realtime.module';
import { DriverSelfController } from './driver-self.controller';
import { DriversController } from './drivers.controller';
import { DriversService } from './drivers.service';

/**
 * Drivers (Phase 14).
 *
 * Depends on the database and on `RealtimeModule` (to push a driver's live
 * location to the branch watching it). Exports `DriversService` so the
 * delivery module can resolve "which driver is this actor" and check
 * active-delivery status without duplicating that query.
 */
@Module({
  imports: [RealtimeModule],
  controllers: [DriversController, DriverSelfController],
  providers: [DriversService],
  exports: [DriversService],
})
export class DriversModule {}
