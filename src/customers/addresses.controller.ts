import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { Actor } from '../auth/types/actor';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { CustomersService } from './customers.service';
import { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';

/**
 * The customer app's saved-address surface.
 *
 * No permission requirement — customers hold none — so ownership is enforced in
 * the service by customer id. Authentication is still required (the global auth
 * guard establishes the customer actor).
 */
@ApiTags('customer addresses')
@ApiResponse({ status: 401, type: ApiErrorDto })
@Controller('customer/addresses')
export class AddressesController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @ApiOperation({ summary: 'List my saved addresses' })
  list(@CurrentActor() actor: Actor) {
    return this.customers.list(actor);
  }

  @Post()
  @ApiOperation({ summary: 'Save a new address' })
  create(@CurrentActor() actor: Actor, @Body() dto: CreateAddressDto) {
    return this.customers.create(actor, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an address' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  update(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return this.customers.update(actor, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an address' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  remove(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.remove(actor, id);
  }
}
