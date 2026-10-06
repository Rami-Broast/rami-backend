import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { HomepageService } from './homepage.service';
import { ReorderHomepageDto, UpsertHomepageSectionDto } from './dto/homepage.dto';

@ApiTags('homepage (owner)')
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@Controller('homepage')
export class HomepageController {
  constructor(private readonly homepage: HomepageService) {}

  @Get('sections')
  @RequirePermissions('customer-app:write')
  @ApiOperation({ summary: 'List all homepage sections (admin)' })
  list() {
    return this.homepage.list();
  }

  @Put('sections')
  @RequirePermissions('customer-app:write')
  @ApiOperation({ summary: 'Upsert a homepage section by kind' })
  upsert(@Body() dto: UpsertHomepageSectionDto) {
    return this.homepage.upsert(dto);
  }

  @Post('sections/reorder')
  @RequirePermissions('customer-app:write')
  @ApiOperation({ summary: 'Reorder homepage sections' })
  reorder(@Body() dto: ReorderHomepageDto) {
    return this.homepage.reorder(dto);
  }

  @Delete('sections/:id')
  @RequirePermissions('customer-app:write')
  @ApiOperation({ summary: 'Remove a homepage section' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.homepage.remove(id);
  }
}
