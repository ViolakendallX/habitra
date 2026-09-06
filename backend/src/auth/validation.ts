import { z } from 'zod';

/**
 * Shared request-validation helpers for the auth surface.
 *
 * `normalizeEmail` MUST be used everywhere an email is accepted so the same
 * address always resolves to the same account (e.g. "  Ada@Example.COM " and
 * "ada@example.com" are identical). `passwordSchema` centralizes the password
 * rules used by both registration and password reset.
 */

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function normalizeEmail(value: unknown): string | undefined {
  return readString(value)?.trim().toLowerCase();
}

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(72, 'Password must be 72 characters or fewer.');
