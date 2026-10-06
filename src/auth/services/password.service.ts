import { hash, verify, Algorithm } from '@node-rs/argon2';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Password hashing for staff accounts.
 *
 * Argon2id, which is memory-hard: an attacker with a stolen hash cannot trade
 * cheap parallel GPU cycles for speed the way they can against SHA-family
 * hashes. Parameters are pinned here rather than left to defaults so that a
 * library upgrade cannot silently weaken them.
 */
@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);

  // OWASP-aligned baseline: 19 MiB of memory, 2 passes, 1 lane.
  private readonly options = {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  };

  async hash(plaintext: string): Promise<string> {
    // The salt is generated per hash by the library and embedded in the output.
    return hash(plaintext, this.options);
  }

  /**
   * Verifies a password against a stored hash.
   *
   * Returns false rather than throwing on a malformed hash: a corrupt stored
   * value is an authentication failure, not a 500 that tells an attacker their
   * input reached something interesting.
   */
  async verify(storedHash: string, plaintext: string): Promise<boolean> {
    try {
      return await verify(storedHash, plaintext);
    } catch {
      // Deliberately logs no part of the hash or the attempted password.
      this.logger.warn('Password verification failed against a malformed hash');
      return false;
    }
  }
}
