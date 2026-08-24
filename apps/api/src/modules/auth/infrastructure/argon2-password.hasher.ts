import { Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { PasswordHasher } from '../domain/password-hasher.port';

/**
 * argon2id password hashing.
 *
 * argon2id rather than bcrypt: bcrypt caps the password at 72 bytes and is
 * cheap to attack on GPUs. argon2id is memory-hard, which is what makes
 * purpose-built cracking hardware expensive.
 *
 * Parameters follow current OWASP guidance (19 MiB, 2 iterations, 1 lane).
 * They are named constants because they must be re-tuned as hardware improves,
 * and `needsRehash` transparently upgrades stored hashes when they change.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class Argon2PasswordHasher implements PasswordHasher {
  private readonly logger = new Logger(Argon2PasswordHasher.name);

  hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, ARGON2_OPTIONS);
  }

  async verify(hash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plaintext);
    } catch {
      // A malformed or truncated hash must read as "wrong password", not as a
      // 500. Throwing here would let an attacker distinguish a corrupted record
      // from a wrong password.
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, ARGON2_OPTIONS);
    } catch {
      this.logger.warn('Could not inspect password hash parameters');
      return false;
    }
  }
}
