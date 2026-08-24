/**
 * Port: password hashing.
 *
 * The domain states that passwords must be hashed and verified; it does not
 * know that argon2 exists. That keeps the algorithm an infrastructure decision,
 * which matters because hashing parameters get re-tuned as hardware improves.
 */
export interface PasswordHasher {
  hash(plaintext: string): Promise<string>;

  /**
   * Must be constant-time with respect to the stored hash, and must return
   * false rather than throwing on a malformed hash.
   */
  verify(hash: string, plaintext: string): Promise<boolean>;

  /**
   * True when a stored hash used weaker parameters than the current policy, so
   * it can be transparently upgraded on the user's next successful login.
   */
  needsRehash(hash: string): boolean;
}

export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
