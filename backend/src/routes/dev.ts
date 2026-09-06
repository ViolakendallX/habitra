import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { hashResetToken } from '../auth/tokens.js';
import { prisma } from '../db/prisma.js';
import { getLastResetLink } from '../email/index.js';

/**
 * DEV-ONLY routes. Mounted ONLY when NODE_ENV !== 'production' (see app.ts).
 *
 * Exposes the last password-reset link captured by the dev console email
 * provider so local tests can exercise the reset flow without a real inbox.
 * The raw token is never returned from the public auth APIs; it appears here,
 * in non-production only, strictly for testing.
 */
export const devRouter: Router = Router();

devRouter.get('/password-reset-link', (_req: Request, res: Response) => {
  const link = getLastResetLink();
  if (!link) {
    res.status(404).json({ status: 'error', message: 'No reset link captured yet.' });
    return;
  }
  res.status(200).json({ status: 'success', data: { resetLink: link } });
});

const expireResetTokenSchema = z.object({
  token: z.string().min(10, 'Invalid token.'),
});

devRouter.post('/expire-reset-token', async (req: Request, res: Response) => {
  const parsed = expireResetTokenSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      status: 'error',
      message: 'Validation failed.',
      errors: z.flattenError(parsed.error).fieldErrors,
    });
    return;
  }

  const tokenHash = hashResetToken(parsed.data.token);
  await prisma.passwordResetToken.updateMany({
    where: { tokenHash },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });

  res.status(200).json({ status: 'success' });
});
