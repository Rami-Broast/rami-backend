/**
 * What may be uploaded, and how big.
 *
 * Pure, so the rules are testable without a request, a file or a database —
 * and so the reason a file was refused is one place rather than scattered
 * through a controller.
 */

/**
 * The image types a browser will reliably render and a phone gallery will
 * reliably produce.
 *
 * **SVG is deliberately excluded.** An SVG is a document that can carry script,
 * and these files are served back from our own origin — an owner uploading one
 * from a "free icons" site would be handing that site's author a foothold in
 * the admin panel. Every raster format here is inert.
 */
export const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
] as const;

/**
 * 6 MB. Comfortably above a phone camera's JPEG and far below anything that
 * would make a menu response or a database backup unpleasant. A cap is not
 * optional here: these bytes go in Postgres, so an unbounded upload is an
 * unbounded database.
 */
export const MAX_ASSET_BYTES = 6 * 1024 * 1024;

export type AssetRejection =
  | { reason: 'MISSING'; message: string }
  | { reason: 'TYPE'; message: string }
  | { reason: 'SIZE'; message: string }
  | { reason: 'EMPTY'; message: string };

/**
 * Checks one upload. Returns null when it is acceptable.
 *
 * The messages are written for the person at the screen — an owner who has just
 * picked a photo needs to know it was too big and by how much, not that a
 * validation predicate returned false.
 */
export function rejectAsset(
  file:
    | {
        mimetype?: string;
        size?: number;
      }
    | null
    | undefined,
): AssetRejection | null {
  if (!file) {
    return { reason: 'MISSING', message: 'No file was uploaded.' };
  }

  const mimetype = (file.mimetype ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(mimetype)) {
    return {
      reason: 'TYPE',
      message: `That file is not an image we can show (${mimetype || 'unknown type'}). Use a JPEG, PNG, WebP, GIF or AVIF.`,
    };
  }

  const size = file.size ?? 0;
  if (size <= 0) {
    return { reason: 'EMPTY', message: 'That file is empty.' };
  }
  if (size > MAX_ASSET_BYTES) {
    return {
      reason: 'SIZE',
      message: `That image is ${formatMb(size)} and the limit is ${formatMb(MAX_ASSET_BYTES)}. Please pick a smaller one.`,
    };
  }

  return null;
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The path prefix every uploaded asset is served under.
 *
 * Exported so `assetUrl` (which produces these) and `isImageRef` (which has to
 * accept them on the way back in) cannot drift apart — an image-bearing DTO that
 * rejects the very value this module hands out is exactly the bug that made
 * `POST /assets` useless for coupons and banners.
 */
export const ASSET_URL_PREFIX = '/assets';

/** The public URL a client uses to render the asset. The only handle a client gets. */
export function assetUrl(id: string): string {
  return `${ASSET_URL_PREFIX}/${id}`;
}
