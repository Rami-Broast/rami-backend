import { Configuration } from './configuration';

/**
 * Typed accessor over the validated configuration tree.
 *
 * Prefer injecting this over `ConfigService` so that configuration access is
 * compile-time checked and no module reaches into `process.env` directly.
 *
 * Deliberately kept in its own file, separate from the module that registers
 * it: importing the module eagerly validates the entire environment, so a unit
 * test that only needs this class would otherwise be forced to supply a
 * database URL and every other production variable.
 */
export class AppConfigService {
  constructor(private readonly configuration: Configuration) {}

  get app(): Configuration['app'] {
    return this.configuration.app;
  }

  get logging(): Configuration['logging'] {
    return this.configuration.logging;
  }

  get database(): Configuration['database'] {
    return this.configuration.database;
  }

  get rateLimit(): Configuration['rateLimit'] {
    return this.configuration.rateLimit;
  }

  get docs(): Configuration['docs'] {
    return this.configuration.docs;
  }

  get auth(): Configuration['auth'] {
    return this.configuration.auth;
  }

  get otp(): Configuration['otp'] {
    return this.configuration.otp;
  }

  get sms(): Configuration['sms'] {
    return this.configuration.sms;
  }

  get push(): Configuration['push'] {
    return this.configuration.push;
  }

  get pricing(): Configuration['pricing'] {
    return this.configuration.pricing;
  }

  get payments(): Configuration['payments'] {
    return this.configuration.payments;
  }

  get zatca(): Configuration['zatca'] {
    return this.configuration.zatca;
  }

  get delivery(): Configuration['delivery'] {
    return this.configuration.delivery;
  }

  get loyalty(): Configuration['loyalty'] {
    return this.configuration.loyalty;
  }

  get refunds(): Configuration['refunds'] {
    return this.configuration.refunds;
  }

  get printing(): Configuration['printing'] {
    return this.configuration.printing;
  }
}
