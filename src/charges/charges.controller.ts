import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { ChargesService } from './charges.service';
import { CreateChargeDto, UpdateChargeDto } from './dto/charge.dto';

@ApiTags('charges (owner)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('charges')
export class ChargesController {
  constructor(private readonly charges: ChargesService) {}

  @Get()
  @RequirePermissions('charges:read')
  @ApiOperation({ summary: 'List all charges' })
  list() {
    return this.charges.list();
  }

  @Get(':id')
  @RequirePermissions('charges:read')
  @ApiOperation({ summary: 'Get a charge by ID' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.charges.findById(id);
  }

  @Post()
  @RequirePermissions('charges:write')
  @ApiOperation({ summary: 'Create a new charge' })
  create(@Body() dto: CreateChargeDto) {
    return this.charges.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('charges:write')
  @ApiOperation({ summary: 'Update a charge' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateChargeDto) {
    return this.charges.update(id, dto);
  }
}
