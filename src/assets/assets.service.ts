import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { assetUrl, rejectAsset } from './asset-rules';

export interface UploadedAsset {
  id: string;
  /** What a client stores and renders. Never a filesystem path. */
  url: string;
  mimeType: string;
  byteSize: number;
  filename: string | null;
}

export interface AssetBytes {
  mimeType: string;
  data: Buffer;
}

/**
 * Owner-uploaded artwork.
 *
 * See `Asset` in the schema for why the bytes live in Postgres. The important
 * property here is that a client only ever handles the **URL** — nothing about
 * where the bytes are is visible to the admin panel or the customer app, so
 * moving to object storage later is a change to this one service.
 */
@Injectable()
export class AssetsService {
  constructor(private readonly prisma: PrismaService) {}

  async upload(
    file: { mimetype?: string; size?: number; buffer?: Buffer; originalname?: string } | undefined,
    uploadedById: string | null,
  ): Promise<UploadedAsset> {
    const rejection = rejectAsset(file);
    if (rejection) {
      throw new BadRequestException(rejection.message);
    }

    // `rejectAsset` has already established the file is present and non-empty;
    // this narrows it for the type system rather than re-checking.
    const buffer = file?.buffer;
    if (!buffer) {
      throw new BadRequestException('No file was uploaded.');
    }

    const asset = await this.prisma.asset.create({
      data: {
        mimeType: (file?.mimetype ?? '').toLowerCase().split(';')[0]?.trim() ?? '',
        byteSize: buffer.byteLength,
        // Prisma types `Bytes` as a plain Uint8Array; a Node Buffer is one,
        // but its backing store is typed loosely enough that TypeScript will
        // not accept it without this.
        data: new Uint8Array(buffer),
        // Trimmed to something a picker can show. A 300-character filename is
        // not information, and it is never used to build a path.
        filename: file?.originalname ? file.originalname.slice(0, 200) : null,
        uploadedById,
      },
      select: { id: true, mimeType: true, byteSize: true, filename: true },
    });

    return { ...asset, url: assetUrl(asset.id) };
  }

  /**
   * The bytes, for serving.
   *
   * Selected explicitly rather than with a bare `findUnique`, so a future field
   * on `Asset` is never dragged into a response that is meant to be an image.
   */
  async getBytes(id: string): Promise<AssetBytes> {
    const asset = await this.prisma.asset.findUnique({
      where: { id },
      select: { mimeType: true, data: true },
    });
    if (!asset) {
      throw new NotFoundException('Image not found.');
    }
    return { mimeType: asset.mimeType, data: Buffer.from(asset.data) };
  }
}
