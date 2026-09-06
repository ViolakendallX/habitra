import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { UNAUTHORIZED, requireAuth } from '../middleware/auth.js';
import { computeUserAnalytics, normalizeCalendarDate } from '../services/analytics.js';

const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/;

const analyticsQuerySchema = z.object({
  from: z
    .string()
    .regex(calendarDatePattern, 'From must be in YYYY-MM-DD format.')
    .optional(),
  to: z
    .string()
    .regex(calendarDatePattern, 'To must be in YYYY-MM-DD format.')
    .optional(),
});

export const analyticsRouter: Router = Router();

analyticsRouter.get('/analytics', requireAuth, async (req: Request, res: Response) => {
  const authenticatedUser = req.authUser;

  if (!authenticatedUser) {
    res.status(401).json(UNAUTHORIZED);
    return;
  }

  const parsedQuery = analyticsQuerySchema.safeParse(req.query ?? {});

  if (!parsedQuery.success) {
    res.status(400).json({
      status: 'error',
      message: 'Validation failed.',
      errors: z.flattenError(parsedQuery.error).fieldErrors,
    });
    return;
  }

  const normalizedFrom = parsedQuery.data.from
    ? normalizeCalendarDate(parsedQuery.data.from)
    : null;
  const normalizedTo = parsedQuery.data.to
    ? normalizeCalendarDate(parsedQuery.data.to)
    : null;

  const dateErrors: Record<string, string[]> = {};

  if (parsedQuery.data.from && !normalizedFrom) {
    dateErrors.from = ['From must be a valid calendar date.'];
  }

  if (parsedQuery.data.to && !normalizedTo) {
    dateErrors.to = ['To must be a valid calendar date.'];
  }

  if (Object.keys(dateErrors).length > 0) {
    res.status(400).json({
      status: 'error',
      message: 'Validation failed.',
      errors: dateErrors,
    });
    return;
  }

  if (normalizedFrom && normalizedTo && normalizedFrom.getTime() > normalizedTo.getTime()) {
    res.status(400).json({
      status: 'error',
      message: 'Validation failed.',
      errors: {
        from: ['From must be on or before to.'],
      },
    });
    return;
  }

  try {
    const analytics = await computeUserAnalytics(authenticatedUser.id, {
      from: parsedQuery.data.from ?? null,
      to: parsedQuery.data.to ?? null,
    });

    res.status(200).json({
      status: 'success',
      data: { analytics },
    });
  } catch {
    res.status(500).json({
      status: 'error',
      message: 'Unable to load analytics.',
    });
  }
});
