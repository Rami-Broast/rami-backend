import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Actor } from '../auth/types/actor';
import {
  CreateFeatureFlagDto,
  FeatureFlagResponseDto,
  UpdateFeatureFlagDto,
} from './dto/feature-flag.dto';
import { FeatureFlagsService } from './feature-flags.service';

@ApiTags('Feature Flags')
@Controller('feature-flags')
export class FeatureFlagsController {
  constructor(private readonly service: FeatureFlagsService) {}

  @Get()
  @RequirePermissions('features:write')
  @ApiOperation({ summary: 'List all feature flags.' })
  @ApiResponse({ status: 200, type: [FeatureFlagResponseDto] })
  list() {
    return this.service.list();
  }

  @Get(':key')
  @RequirePermissions('features:write')
  @ApiOperation({ summary: 'Get a feature flag by key.' })
  @ApiResponse({ status: 200, type: FeatureFlagResponseDto })
  findByKey(@Param('key') key: string) {
    return this.service.findByKey(key);
  }

  @Post()
  @RequirePermissions('features:write')
  @ApiOperation({ summary: 'Create a feature flag.' })
  @ApiResponse({ status: 201, type: FeatureFlagResponseDto })
  create(@Body() dto: CreateFeatureFlagDto, @CurrentActor() actor: Actor) {
    return this.service.create(dto, actor.id);
  }

  @Patch(':key')
  @RequirePermissions('features:write')
  @ApiOperation({ summary: 'Toggle a feature flag.' })
  @ApiResponse({ status: 200, type: FeatureFlagResponseDto })
  update(
    @Param('key') key: string,
    @Body() dto: UpdateFeatureFlagDto,
    @CurrentActor() actor: Actor,
  ) {
    return this.service.update(key, dto, actor.id);
  }
}
