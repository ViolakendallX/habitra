import type { NextFunction, Request, Response } from 'express';

/**
 * Tiny in-memory fixed-window rate limiter (no external dependency).
 *
 * Used to blunt automated abuse of the forgot-password endpoint, which would
 * otherwise allow account enumeration by timing if left unbounded. Limitations
 * (see feature report): state is per-process and resets on restart, and it is
 * not shared across multiple server instances — a distributed store (e.g. Redis)
 * is the follow-up for production.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export function createRateLimiter(opts: { windowMs: number; max: number }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > opts.max) {
      res.status(429).json({
        status: 'error',
        message: 'Too many requests. Please try again later.',
      });
      return;
    }

    next();
  };
}

/** Forgot-password abuse protection: at most 5 requests per 15 minutes per IP. */
export const forgotPasswordRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
});
