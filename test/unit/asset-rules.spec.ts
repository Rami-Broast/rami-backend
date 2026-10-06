import {
  ALLOWED_IMAGE_TYPES,
  MAX_ASSET_BYTES,
  assetUrl,
  rejectAsset,
} from '../../src/assets/asset-rules';

describe('rejectAsset', () => {
  const ok = { mimetype: 'image/jpeg', size: 250_000 };

  it('accepts an ordinary phone photo', () => {
    expect(rejectAsset(ok)).toBeNull();
    for (const mimetype of ALLOWED_IMAGE_TYPES) {
      expect(rejectAsset({ mimetype, size: 1000 })).toBeNull();
    }
  });

  it('refuses SVG even though it is an image', () => {
    // An SVG is a document that can carry script, and these bytes are served
    // back from our own origin. An owner grabbing one from a free-icons site
    // would be handing that site's author a foothold in the admin panel.
    expect(rejectAsset({ mimetype: 'image/svg+xml', size: 1000 })?.reason).toBe('TYPE');
  });

  it('refuses anything that is not an image at all', () => {
    expect(rejectAsset({ mimetype: 'application/pdf', size: 1000 })?.reason).toBe('TYPE');
    expect(rejectAsset({ mimetype: '', size: 1000 })?.reason).toBe('TYPE');
  });

  it('reads a content type that carries parameters', () => {
    // Browsers and phone galleries send these; a naive equality check refuses
    // a perfectly good photo.
    expect(rejectAsset({ mimetype: 'image/jpeg; charset=binary', size: 1000 })).toBeNull();
    expect(rejectAsset({ mimetype: 'IMAGE/PNG', size: 1000 })).toBeNull();
  });

  it('caps the size, because these bytes go in the database', () => {
    expect(rejectAsset({ ...ok, size: MAX_ASSET_BYTES })).toBeNull();
    const tooBig = rejectAsset({ ...ok, size: MAX_ASSET_BYTES + 1 });
    expect(tooBig?.reason).toBe('SIZE');
    // The owner is told the actual numbers, not that a predicate failed.
    expect(tooBig?.message).toMatch(/6\.0 MB/);
  });

  it('refuses an empty file and a missing one, differently', () => {
    expect(rejectAsset({ ...ok, size: 0 })?.reason).toBe('EMPTY');
    expect(rejectAsset(undefined)?.reason).toBe('MISSING');
    expect(rejectAsset(null)?.reason).toBe('MISSING');
  });
});

describe('assetUrl', () => {
  it('is the only handle a client ever gets', () => {
    // Nothing about where the bytes live leaks into a client, which is what
    // makes moving them to object storage later a change to one service.
    expect(assetUrl('abc')).toBe('/assets/abc');
  });
});
