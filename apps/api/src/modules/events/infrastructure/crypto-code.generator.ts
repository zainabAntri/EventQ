import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { CodeGenerator } from '../domain/code-generator.port';

/**
 * Cryptographic randomness for join codes.
 *
 * `crypto.randomBytes`, not `Math.random`: a predictable join code would let
 * someone derive the codes of other events from one they legitimately hold.
 */
@Injectable()
export class CryptoCodeGenerator implements CodeGenerator {
  // Bound as a property so it can be passed as a bare function to the pure
  // domain generator without losing `this`.
  readonly randomBytes = (size: number): Uint8Array => randomBytes(size);
}
