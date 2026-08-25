/**
 * Port: cryptographic randomness.
 *
 * Injected rather than imported from `node:crypto` so the domain stays
 * framework-free and join-code generation can be driven by a deterministic
 * source in tests.
 */
export interface CodeGenerator {
  randomBytes(size: number): Uint8Array;
}

export const CODE_GENERATOR = Symbol('CODE_GENERATOR');
