import { applyDecorators } from '@nestjs/common';
import { registerDecorator, ValidationOptions } from 'class-validator';

import { ASSET_URL_PREFIX } from '../../assets/asset-rules';

/**
 * The two shapes an image reference legitimately takes in this system.
 *
 * 1. **An uploaded asset**: `/assets/<uuid>` — what `POST /assets` returns and
 *    what every client stores. It is deliberately relative so the same row
 *    resolves against whichever API base the admin panel, the customer app or a
 *    local build is pointed at.
 * 2. **An absolute `http(s)` URL** — images referenced before uploading existed.
 *    They still have to load, so they are still accepted.
 *
 * This exists because `@IsUrl()` accepts only the second, and every image-bearing
 * DTO used it. `POST /assets` would take the upload, return `/assets/<uuid>`, and
 * the save that followed was rejected with "imageUrl must be a URL address" —
 * so an owner could not put artwork on an offer or create a banner at all, and
 * the failure looked like their mistake. Products escaped only because their DTO
 * validated `imageUrl` as a plain string.
 *
 * Anything else is still refused: this is not a loosening to "any string". A
 * `javascript:` or `data:` value in a field that ends up in an `<img src>` is
 * exactly what the allow-list is for.
 */
const ASSET_PATH = new RegExp(
  `^${ASSET_URL_PREFIX}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`,
);

/** Pure predicate, so the rule is unit-testable without standing up a DTO. */
export function isImageRef(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000) {
    return false;
  }
  if (ASSET_PATH.test(value)) {
    return true;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validates an image reference: an uploaded `/assets/<uuid>` path or an absolute
 * `http(s)` URL.
 */
export function IsImageRef(options?: ValidationOptions): PropertyDecorator {
  return applyDecorators((target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isImageRef',
      target: target.constructor,
      propertyName: propertyName as string,
      options: {
        message:
          '$property must be an uploaded image path (/assets/<id>) or an absolute http(s) URL',
        ...options,
      },
      validator: { validate: (value: unknown) => isImageRef(value) },
    });
  });
}
