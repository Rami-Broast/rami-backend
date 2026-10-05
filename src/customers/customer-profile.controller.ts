import { Body, Controller, Delete, Get, Patch } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { Actor } from '../auth/types/actor';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { CustomersService } from './customers.service';
import { UpdateProfileDto } from './dto/profile.dto';

/**
 * The customer app's own-profile surface.
 *
 * No permission requirement — customers hold none — so the service scopes every
 * call to the caller's own customer id. The phone number is returned for display
 * but is not editable here (it is the OTP login identity).
 */
@ApiTags('profile (customer)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@Controller('customer/me')
export class CustomerProfileController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @ApiOperation({ summary: 'My profile' })
  me(@CurrentActor() actor: Actor) {
    return this.customers.getProfile(actor);
  }

  @Patch()
  @ApiOperation({ summary: 'Update my display name' })
  @ApiResponse({
    status: 403,
    type: ApiErrorDto,
    description: 'Only a customer can edit their profile.',
  })
  update(@CurrentActor() actor: Actor, @Body() dto: UpdateProfileDto) {
    return this.customers.updateProfile(actor, dto);
  }

  @Delete()
  @ApiOperation({
    summary: 'Delete my account',
    description:
      "Anonymises and deactivates the account: name, email and every saved address are erased, the phone number is released so the person can sign up again, and every session is revoked. Past orders are NOT deleted — they are the restaurant's sales and VAT records, and the app must say so before the customer confirms.",
  })
  @ApiResponse({
    status: 403,
    type: ApiErrorDto,
    description: 'Only a customer can delete their own account.',
  })
  @ApiResponse({ status: 404, type: ApiErrorDto, description: 'Already deleted.' })
  deleteAccount(@CurrentActor() actor: Actor) {
    return this.customers.deleteAccount(actor);
  }
}
