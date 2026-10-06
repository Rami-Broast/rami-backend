import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { PromotionsService } from './promotions.service';
import { CreatePromotionDto, UpdatePromotionDto } from './dto/promotion.dto';

@ApiTags('promotions (owner)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('promotions')
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  @Get()
  @RequirePermissions('promotions:read')
  @ApiOperation({ summary: 'List all promotions' })
  list() {
    return this.promotions.list();
  }

  @Get(':id')
  @RequirePermissions('promotions:read')
  @ApiOperation({ summary: 'Get a promotion by ID' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.promotions.findById(id);
  }

  @Post()
  @RequirePermissions('promotions:write')
  @ApiOperation({ summary: 'Create a promotion' })
  create(@Body() dto: CreatePromotionDto) {
    return this.promotions.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('promotions:write')
  @ApiOperation({ summary: 'Update a promotion' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePromotionDto) {
    return this.promotions.update(id, dto);
  }

  @Post(':id/publish')
  @RequirePermissions('promotions:write')
  @ApiOperation({ summary: 'Publish a promotion' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  publish(@Param('id', ParseUUIDPipe) id: string) {
    return this.promotions.publish(id);
  }

  @Post(':id/unpublish')
  @RequirePermissions('promotions:write')
  @ApiOperation({ summary: 'Unpublish a promotion' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  unpublish(@Param('id', ParseUUIDPipe) id: string) {
    return this.promotions.unpublish(id);
  }

  @Delete(':id')
  @RequirePermissions('promotions:write')
  @ApiOperation({ summary: 'Soft-delete a promotion' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.promotions.remove(id);
  }
}
