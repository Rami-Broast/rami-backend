import { Controller, Get, Headers, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';

import { Public } from '../auth/decorators/public.decorator';
import { CustomerConfigService } from './customer-config.service';

@ApiTags('Customer Config')
@Controller('customer/config')
export class CustomerConfigController {
  constructor(private readonly service: CustomerConfigService) {}

  @Get()
  @Public()
  @ApiOperation({
    summary: 'Public config for the customer app.',
    description:
      'Returns branding, feature flags, branches with settings. ' +
      'Supports ETag / If-None-Match caching.',
  })
  @ApiResponse({ status: 200, description: 'Full config payload.' })
  @ApiResponse({ status: 304, description: 'Not modified (ETag match).' })
  async getConfig(
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const config = await this.service.getConfig();

    const etag = `"config-v${config.version}"`;

    if (ifNoneMatch === etag) {
      res.status(304);
      return;
    }

    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-cache');
    return config;
  }
}
