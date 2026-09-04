import jwt from 'jsonwebtoken';

import { env, isProduction } from '../config/env.js';

/**
 * JWT-based authentication (PRD section 6, Phase 2).
 *
 * The token's payload carries ONLY the authenticated user's id (as `sub`) plus
 * the standard `iat`/`exp` claims added by jsonwebtoken. Nothing else — no
 * email, no role — is embedded, so a leaked token cannot be used to learn about
 * the account beyond its id.
 */

/** Name of the HttpOnly cookie that carries the session JWT. */
export const AUTH_COOKIE = 'habitra_auth';

/** Token + cookie lifetime: 7 days. */
const JWT_EXPIRES_IN = '7d';
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const JWT_ALGORITHM = 'HS256';

export interface TokenPayload {
  userId: string;
}

export function signAuthToken(userId: string): string {
  if (!env.jwtSecret) {
    throw new Error('JWT_SECRET is not set. Add it to .env (see .env.example).');
  }

  return jwt.sign({ sub: userId }, env.jwtSecret, {
    algorithm: JWT_ALGORITHM,
    expiresIn: JWT_EXPIRES_IN,
  });
}

/**
 * Verifies a token and returns its payload, or `null` on ANY failure (missing
 * secret, expired, malformed, bad signature, wrong shape). The caller maps
 * `null` to a generic 401 so the response never reveals which case happened.
 */
export function verifyAuthToken(token: string): TokenPayload | null {
  if (!env.jwtSecret) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, env.jwtSecret, {
      algorithms: [JWT_ALGORITHM],
    });

    if (typeof decoded === 'string' || !decoded.sub || typeof decoded.sub !== 'string') {
      return null;
    }

    return { userId: decoded.sub };
  } catch {
    return null;
  }
}

/**
 * Cookie attributes for setting the session cookie.
 *
 * - httpOnly: true  -> not readable from JavaScript (no XSS token theft)
 * - Secure: only in production, where HTTPS is expected
 * - sameSite: `none` in production (the API is typically a different origin from
 *   the web app, so the cookie must be allowed on cross-origin fetches) and
 *   `lax` in development; `none` always travels with `Secure: true`.
 */
export function buildCookieOptions(): {
  httpOnly: true;
  sameSite: 'lax' | 'none';
  secure: boolean;
  maxAge: number;
  path: string;
} {
  return {
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax',
    secure: isProduction,
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/',
  };
}

/**
 * Cookie options used when clearing the session. These must match the path,
 * SameSite, and Secure attributes used when setting it; `maxAge` is omitted so
 * Express emits an immediate expiry instead of retaining the seven-day value.
 */
export function buildClearCookieOptions(): {
  httpOnly: true;
  sameSite: 'lax' | 'none';
  secure: boolean;
  path: string;
} {
  const { maxAge: _maxAge, ...options } = buildCookieOptions();
  return options;
}
