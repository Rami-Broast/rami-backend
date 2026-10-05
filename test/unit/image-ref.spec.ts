import { assetUrl } from '../../src/assets/asset-rules';
import { isImageRef } from '../../src/common/validators/image-ref.validator';

/**
 * The rule that decides what may be stored in an `imageUrl` column.
 *
 * The case that matters most is the first one: this validator has to accept the
 * exact string `POST /assets` hands out. It did not, and the consequence was
 * that an owner could upload artwork and then not save it — "imageUrl must be a
 * URL address" on a value the backend itself had just produced.
 */
describe('isImageRef', () => {
  it('accepts the value assetUrl() produces — the whole point of the rule', () => {
    expect(isImageRef(assetUrl('01a072df-4867-7630-92c1-7b6a9327f930'))).toBe(true);
  });

  it('accepts an uploaded asset path', () => {
    expect(isImageRef('/assets/01a072df-4867-7630-92c1-7b6a9327f930')).toBe(true);
  });

  it('accepts absolute http(s) URLs, so artwork predating uploads still loads', () => {
    expect(isImageRef('https://cdn.example.com/hero.jpg')).toBe(true);
    expect(isImageRef('http://cdn.example.com/hero.jpg')).toBe(true);
  });

  it('rejects a path that is not an asset id', () => {
    expect(isImageRef('/assets/not-a-uuid')).toBe(false);
    expect(isImageRef('/assets/')).toBe(false);
    expect(isImageRef('/uploads/01a072df-4867-7630-92c1-7b6a9327f930')).toBe(false);
  });

  it('rejects script-bearing and non-http schemes', () => {
    // These end up in an <img src>; the allow-list is what keeps them out.
    expect(isImageRef('javascript:alert(1)')).toBe(false);
    expect(isImageRef('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toBe(false);
    expect(isImageRef('file:///etc/passwd')).toBe(false);
  });

  it('rejects empty, non-string and oversized values', () => {
    expect(isImageRef('')).toBe(false);
    expect(isImageRef(null)).toBe(false);
    expect(isImageRef(undefined)).toBe(false);
    expect(isImageRef(42)).toBe(false);
    expect(isImageRef(`https://example.com/${'a'.repeat(2000)}`)).toBe(false);
  });
});
