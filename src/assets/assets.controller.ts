import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ActorKind, type Actor } from '../auth/types/actor';
import { ApiErrorDto } from '../common/dto/api-error.dto';
import { AssetsService } from './assets.service';
import { MAX_ASSET_BYTES } from './asset-rules';

/**
 * Image upload and delivery.
 *
 * Uploading is `assets:write` — an owner action. Reading is **public**, because
 * the customer app renders menu photography before anyone signs in and a menu
 * of broken images is not a menu.
 */
@ApiTags('assets')
@Controller('assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Post()
  @RequirePermissions('assets:write')
  @UseInterceptors(
    // Memory storage, not disk: Cloud Run's filesystem is ephemeral and per
    // instance, so a file written there is gone or invisible by the next
    // request. The size limit is enforced here as well as in `rejectAsset` —
    // this one stops a large body being read at all, rather than reading it and
    // then objecting.
    FileInterceptor('file', { limits: { fileSize: MAX_ASSET_BYTES, files: 1 } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiOperation({
    summary: 'Upload an image',
    description:
      'Returns the `url` to store on a product or coupon. Clients never handle the bytes again.',
  })
  @ApiResponse({
    status: 400,
    type: ApiErrorDto,
    description: 'Not an image, empty, or too large.',
  })
  @ApiResponse({ status: 401, type: ApiErrorDto })
  @ApiResponse({ status: 403, type: ApiErrorDto })
  upload(
    @CurrentActor() actor: Actor,
    @UploadedFile()
    file?: { mimetype?: string; size?: number; buffer?: Buffer; originalname?: string },
  ) {
    // Attributed to the staff account that uploaded it, so an owner can tell
    // who added an image. A customer actor can never reach here (the permission
    // is staff-only), but the kind is checked rather than assumed.
    const uploadedById = actor.kind === ActorKind.Staff ? actor.id : null;
    return this.assets.upload(file, uploadedById);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Fetch an uploaded image' })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  async serve(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const asset = await this.assets.getBytes(id);

    res.setHeader('Content-Type', asset.mimeType);
    res.setHeader('Content-Length', String(asset.data.byteLength));
    // An asset's bytes never change — a new image is a new id — so this is
    // safe to cache hard, and it is what keeps images out of the database on
    // the second view. Without it every menu render is a Postgres read.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    // This image is DELIBERATELY embedded cross-origin: the admin panel, the
    // customer app, the driver app and the POS each run on their own origin and
    // render it with an <img> pointed at this API. `helmet()` sets a global
    // `Cross-Origin-Resource-Policy: same-origin`, which makes the browser
    // *block* exactly that embed — the image loads, then vanishes, and every
    // uploaded menu photo and offer/coupon artwork is invisible on every client
    // while a direct visit to the URL still works. `cross-origin` is the correct
    // policy for a public image host and must be set here, overriding the global
    // default, or none of these images can be shown. (CORS governs the JSON API;
    // CORP governs embedded resources like this one — they are separate, which
    // is why fetch() calls worked while images did not.)
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    // `nosniff` stops a browser second-guessing the declared type, and the
    // sandbox CSP means even a file that slipped the type allow-list cannot
    // execute anything. Neither blocks an <img> from rendering the bytes.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.end(asset.data);
  }
}
