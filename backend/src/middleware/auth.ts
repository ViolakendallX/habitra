import type { NextFunction, Request, Response } from 'express';

import { prisma } from '../db/prisma.js';
import { AUTH_COOKIE, verifyAuthToken } from '../auth/jwt.js';
import { publicUserFields, type AuthUser } from '../auth/select.js';

/**
 * Reusable authentication middleware. Future protected routes mount this with
 * `router.use(requireAuth)` (or per-route) to identify the calling user.
 *
 * On success it loads the user from PostgreSQL and attaches the safe profile to
 * `req.authUser`. On any failure it sends a single generic 401 — it never
 * distinguishes "no cookie" / "expired" / "tampered", so the response does not
 * help an attacker enumerate states.
 */

export const UNAUTHORIZED = {
  status: 'error',
  message: 'Authentication required.',
} as const;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: AuthUser;
    }
  }
}

/** Reads our auth cookie out of the `Cookie` header (no extra dependency). */
export function getAuthToken(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;

    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    if (name === AUTH_COOKIE) {
      return value;
    }
  }

  return undefined;
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = getAuthToken(req);

  if (!token) {
    res.status(401).json(UNAUTHORIZED);
    return;
  }

  const payload = verifyAuthToken(token);

  if (!payload) {
    res.status(401).json(UNAUTHORIZED);
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: publicUserFields,
    });

    if (!user) {
      res.status(401).json(UNAUTHORIZED);
      return;
    }

    req.authUser = user;
    next();
  } catch {
    // Authentication errors intentionally collapse to the same generic 401.
    res.status(401).json(UNAUTHORIZED);
  }
}
