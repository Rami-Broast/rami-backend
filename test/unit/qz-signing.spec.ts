import { ServiceUnavailableException } from '@nestjs/common';
import { createVerify, generateKeyPairSync } from 'node:crypto';

import { AppConfigService } from '../../src/config/app-config.service';
import { QzSigningService } from '../../src/printing/qz-signing.service';

/**
 * Signing is what stops a counter being asked "allow this site to print?" on
 * every session. It fails in exactly one direction that matters: a signature
 * QZ Tray cannot verify is a print that does not happen, mid-service, on a
 * machine where nobody can read the reason.
 *
 * So this asserts against the real primitive rather than a mock — a signature
 * that verifies under SHA-512 with the matching public key.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function service(printing: {
  qzCertificate: string | null;
  qzPrivateKey: string | null;
}): QzSigningService {
  return new QzSigningService({ printing } as unknown as AppConfigService);
}

describe('QzSigningService', () => {
  const configured = service({
    qzCertificate: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
    qzPrivateKey: PRIVATE_PEM,
  });

  it('produces a signature QZ Tray can verify', () => {
    const request = '{"call":"print","params":{}}';

    const signature = configured.sign(request);

    // SHA-512, base64 — what QZ Tray 2.1 expects back from the signature
    // promise. If this ever silently became SHA-256, every print would be
    // refused and nothing here would look wrong.
    const verified = createVerify('SHA512')
      .update(request, 'utf8')
      .verify(PUBLIC_PEM, signature, 'base64');
    expect(verified).toBe(true);
  });

  it('signs the exact string it was given, not a normalised one', () => {
    // QZ hashes what it sent. A trimmed or re-encoded copy verifies against
    // nothing, and the failure looks like "the printer stopped working".
    const request = '  {"call":"print"}\n';
    const signature = configured.sign(request);

    expect(
      createVerify('SHA512').update(request, 'utf8').verify(PUBLIC_PEM, signature, 'base64'),
    ).toBe(true);
    expect(
      createVerify('SHA512').update(request.trim(), 'utf8').verify(PUBLIC_PEM, signature, 'base64'),
    ).toBe(false);
  });

  it('is not configured, and refuses, when there is no pair', () => {
    // A working state, not a failure: printing continues, with the prompt. The
    // POS asks `isConfigured` so a branch can be told which of the two it has.
    const none = service({ qzCertificate: null, qzPrivateKey: null });

    expect(none.isConfigured).toBe(false);
    expect(() => none.certificate()).toThrow(ServiceUnavailableException);
    expect(() => none.sign('x')).toThrow(ServiceUnavailableException);
  });

  it('reports configured only when both halves are present', () => {
    expect(configured.isConfigured).toBe(true);
    expect(service({ qzCertificate: 'cert', qzPrivateKey: null }).isConfigured).toBe(false);
    expect(service({ qzCertificate: null, qzPrivateKey: PRIVATE_PEM }).isConfigured).toBe(false);
  });

  it('hands out the certificate and never the key', () => {
    // The certificate is public by nature — it goes to every browser that
    // prints. The key is the whole reason this service exists on the server.
    const returned = configured.certificate();

    expect(returned).toContain('BEGIN CERTIFICATE');
    expect(returned).not.toContain('PRIVATE KEY');
  });
});
