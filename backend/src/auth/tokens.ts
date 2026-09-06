import { createHash, randomBytes } from 'node:crypto';

/**
 * Password-reset token utilities.
 *
 * A reset token is a cryptographically random 256-bit value. The RAW token is
 * only ever sent to the user (inside the reset URL emailed to them) and is
 * NEVER stored, logged, or returned from the API. The database stores only a
 * SHA-256 hash of the raw token, so a database leak cannot be used to reset
 * passwords.
 */

/** Number of random bytes in a raw token (32 bytes => 64 hex chars => 256 bits). */
const RESET_TOKEN_BYTES = 32;

export function generateResetToken(): { raw: string; hash: string } {
  const raw = randomBytes(RESET_TOKEN_BYTES).toString('hex');
  return { raw, hash: hashResetToken(raw) };
}

export function hashResetToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
