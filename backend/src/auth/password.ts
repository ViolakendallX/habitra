import * as bcrypt from 'bcrypt';

/**
 * Password hashing helpers shared by registration and password reset.
 *
 * bcrypt cost factor 12 is the current OWASP recommendation; raise it if the
 * hosting hardware gets faster. bcrypt only uses the first 72 bytes, so callers
 * should validate password length before hashing (see `passwordSchema`).
 */

export const SALT_ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
