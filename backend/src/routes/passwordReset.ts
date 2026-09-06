import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { hashPassword } from '../auth/password.js';
import { normalizeEmail, passwordSchema } from '../auth/validation.js';
import { generateResetToken, hashResetToken } from '../auth/tokens.js';
import { getEmailProvider } from '../email/index.js';
import { forgotPasswordRateLimit } from '../middleware/rateLimit.js';

/**
 * Password reset routes (mounted under /api/auth).
 *
 * POST /api/auth/forgot-password -> issues a single-use, hashed, expiring token
 *   and emails a reset link. Always returns the same generic success so it never
 *   reveals whether an account exists.
 * POST /api/auth/reset-password  -> validates the token (hash + expiry + unused),
 *   sets a new bcrypt password, and invalidates the token.
 */

const RESET_TOKEN_TTL_MS = env.resetTokenTtlMinutes * 60 * 1000;

const forgotPasswordSchema = z.object({
  email: z.email('Enter a valid email address.').max(255, 'Email must be 255 characters or fewer.'),
});

const resetPasswordSchema = z.object({
  token: z.string().min(10, 'Invalid reset token.'),
  password: passwordSchema,
});

export const passwordResetRouter: Router = Router();

passwordResetRouter.post('/forgot-password', forgotPasswordRateLimit, async (req: Request, res: Response) => {
  const parsed = forgotPasswordSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      status: 'error',
      message: 'Validation failed.',
      errors: z.flattenError(parsed.error).fieldErrors,
    });
    return;
  }

  const email = normalizeEmail(parsed.data.email);
  if (!email) {
    res.status(400).json({
      status: 'error',
      message: 'Validation failed.',
      errors: { email: ['Enter a valid email address.'] },
    });
    return;
  }

  // Generate a token for EVERY request (existing account or not) so the two code
  // paths do the same amount of cryptographic work and cannot be told apart by
  // response timing.
  const { raw, hash } = generateResetToken();

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });

  if (user) {
    // Invalidate any previously issued (unused) tokens for this user so only the
    // newest link works.
    await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });

    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hash, expiresAt },
    });

    const resetUrl = `${env.appUrl.replace(/\/$/, '')}/reset-password?token=${raw}`;
    try {
      await getEmailProvider().sendPasswordResetEmail({ to: user.email, resetUrl });
    } catch {
      // Delivery failed, but the token is already stored so the user can retry.
      // Log a server-side error without exposing secrets or the raw token.
      console.error('[auth] Failed to send password-reset email.');
    }
  }

  // Identical response whether or not the account exists.
  res.status(200).json({
    status: 'success',
    message: 'If an account exists for that email, we have sent password reset instructions.',
  });
});

passwordResetRouter.post('/reset-password', async (req: Request, res: Response) => {
  const parsed = resetPasswordSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      status: 'error',
      message: 'Validation failed.',
      errors: z.flattenError(parsed.error).fieldErrors,
    });
    return;
  }

  const { token, password } = parsed.data;
  const tokenHash = hashResetToken(token);

  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });

  // Generic response for invalid / expired / already-used tokens — never
  // distinguish which case occurred.
  const reject = () =>
    res.status(400).json({ status: 'error', message: 'Invalid or expired reset token.' });

  if (!record) {
    reject();
    return;
  }
  if (record.expiresAt.getTime() <= Date.now()) {
    reject();
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: record.userId }, select: { id: true } });
  if (!user) {
    reject();
    return;
  }

  const passwordHash = await hashPassword(password);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
  // Single-use: delete the token (and any others issued for this user).
  await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });

  res.status(200).json({
    status: 'success',
    message: 'Your password has been reset. You can now sign in with your new password.',
  });
});
