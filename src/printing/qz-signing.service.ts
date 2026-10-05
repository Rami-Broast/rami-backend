import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createSign } from 'node:crypto';

import { AppConfigService } from '../config/app-config.service';

/**
 * Signs QZ Tray's print requests, so a counter is never asked to allow
 * printing.
 *
 * QZ prompts once per session for any page it cannot verify — "allow this site
 * to print?" — and a counter terminal that nobody reloads still meets that
 * every morning, mid-service, on a machine where the person who knows what the
 * dialog means is not standing. Signing each request with a certificate QZ
 * trusts is the supported way to remove it.
 *
 * **The private key lives here and only here.** A key in the POS bundle is a
 * published key: the POS is a static web app served to every branch, and
 * anything in it can be read from the browser's source tab. So the browser
 * sends QZ's challenge string, this signs it, and the key never crosses the
 * network.
 *
 * Two properties worth stating, because both are easy to lose later:
 *
 *  - **Unconfigured is a working state, not a failure.** With no pair, the
 *    endpoints refuse and the POS prints exactly as it does today, with the
 *    prompt. The alternative — printing that stops until a certificate is
 *    bought — would hold a branch's service hostage to a purchase order.
 *  - **This is a signing oracle for staff accounts, by design.** QZ's protocol
 *    signs whatever it is asked to sign, so the endpoint is authenticated, is
 *    permission-gated to accounts that print, caps the payload, and never logs
 *    it. What a signature asserts is "this platform approved this print", which
 *    is exactly what QZ needs to hear and nothing more.
 */
@Injectable()
export class QzSigningService {
  constructor(private readonly config: AppConfigService) {}

  /** True when a branch's prints will be silent. */
  get isConfigured(): boolean {
    return Boolean(this.config.printing.qzCertificate && this.config.printing.qzPrivateKey);
  }

  /**
   * The **public** certificate, which is what QZ compares against its trust
   * store. Public by nature — it is handed to every browser that prints.
   */
  certificate(): string {
    const certificate = this.config.printing.qzCertificate;
    if (!certificate) {
      throw new ServiceUnavailableException(
        'No QZ signing certificate is configured. Printing still works; the branch is prompted to allow it once per session.',
      );
    }
    return certificate;
  }

  /**
   * Signs one request. SHA-512 over the raw string QZ handed the browser,
   * returned base64 — the algorithm QZ Tray 2.1 expects.
   */
  sign(request: string): string {
    const key = this.config.printing.qzPrivateKey;
    if (!key) {
      throw new ServiceUnavailableException('No QZ signing key is configured.');
    }

    return createSign('SHA512').update(request, 'utf8').sign(key, 'base64');
  }
}
