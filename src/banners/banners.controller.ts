import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { BannersService } from './banners.service';
import { CreateBannerDto, UpdateBannerDto } from './dto/banner.dto';

@ApiTags('banners (owner)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('banners')
export class BannersController {
  constructor(private readonly banners: BannersService) {}

  @Get()
  @RequirePermissions('banners:read')
  @ApiOperation({ summary: 'List all banners' })
  list() {
    return this.banners.list();
  }

  @Get(':id')
  @RequirePermissions('banners:read')
  @ApiOperation({ summary: 'Get a banner by ID' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.banners.findById(id);
  }

  @Post()
  @RequirePermissions('banners:write')
  @ApiOperation({ summary: 'Create a new banner' })
  create(@Body() dto: CreateBannerDto) {
    return this.banners.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('banners:write')
  @ApiOperation({ summary: 'Update a banner' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBannerDto) {
    return this.banners.update(id, dto);
  }

  @Post(':id/publish')
  @RequirePermissions('banners:write')
  @ApiOperation({ summary: 'Publish a banner (set active + stamp publishedAt)' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  publish(@Param('id', ParseUUIDPipe) id: string) {
    return this.banners.publish(id);
  }

  @Post(':id/unpublish')
  @RequirePermissions('banners:write')
  @ApiOperation({ summary: 'Unpublish a banner (set inactive)' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  unpublish(@Param('id', ParseUUIDPipe) id: string) {
    return this.banners.unpublish(id);
  }

  @Delete(':id')
  @RequirePermissions('banners:write')
  @ApiOperation({ summary: 'Delete a banner' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.banners.remove(id);
  }
}
