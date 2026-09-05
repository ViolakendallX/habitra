import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { prisma } from '../db/prisma.js';
import { UNAUTHORIZED, requireAuth } from '../middleware/auth.js';

const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const createHabitSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required.')
    .max(100, 'Name must be 100 characters or fewer.'),
  description: z
    .string()
    .trim()
    .max(500, 'Description must be 500 characters or fewer.')
    .nullable()
    .optional(),
  frequency: z.enum(['DAILY', 'WEEKLY'], {
    error: 'Frequency must be DAILY or WEEKLY.',
  }),
  target: z
    .number()
    .int('Target must be an integer.')
    .positive('Target must be greater than 0.'),
  preferredTime: z
    .string()
    .regex(timePattern, 'Preferred time must be a valid 24-hour HH:mm time.')
    .nullable()
    .optional(),
});

const completionDatePattern = /^\d{4}-\d{2}-\d{2}$/;

const createCompletionSchema = z
  .object({
    date: z
      .string()
      .regex(completionDatePattern, 'Date must be in YYYY-MM-DD format.'),
    status: z.enum(['COMPLETED', 'MISSED'], {
      error: 'Status must be COMPLETED or MISSED.',
    }),
    missReason: z
      .string()
      .trim()
      .max(500, 'Miss reason must be 500 characters or fewer.')
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'COMPLETED' && value.missReason !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['missReason'],
        message: 'Miss reason is only allowed when status is MISSED.',
      });
    }
  });

function normalizeCalendarDate(dateString: string): Date | null {
  const [yearText, monthText, dayText] = dateString.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  const normalized = new Date(Date.UTC(year, month - 1, day));

  if (
    normalized.getUTCFullYear() !== year
    || normalized.getUTCMonth() !== month - 1
    || normalized.getUTCDate() !== day
  ) {
    return null;
  }

  return normalized;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  return (error as { code?: string }).code === 'P2002';
}

/**
 * The Habit columns that are safe to return from the API. Applied through
 * Prisma's `select` so columns added to the model later can never leak by
 * accident, and shared by the create and list routes so both return the same
 * shape. No relation is included, so no User field (and never a passwordHash)
 * can appear in a habit response.
 */
export const habitPublicFields = {
  id: true,
  userId: true,
  name: true,
  description: true,
  frequency: true,
  target: true,
  preferredTime: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

const completionPublicFields = {
  id: true,
  habitId: true,
  userId: true,
  date: true,
  status: true,
  missReason: true,
  createdAt: true,
} as const;

export const habitsRouter: Router = Router();

/**
 * GET /api/habits
 *
 * Lists the authenticated user's habits, newest first. The filter is always the
 * id that requireAuth resolved from the session cookie; no query parameter,
 * body field, or header is read, so a client cannot request another user's rows.
 */
habitsRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  const authenticatedUser = req.authUser;
  if (!authenticatedUser) {
    res.status(401).json(UNAUTHORIZED);
    return;
  }

  try {
    const habits = await prisma.habit.findMany({
      where: { userId: authenticatedUser.id },
      // `id` breaks ties so habits created in the same millisecond still have a
      // stable, repeatable order.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: habitPublicFields,
    });

    res.status(200).json({ status: 'success', data: { habits } });
  } catch {
    res.status(500).json({
      status: 'error',
      message: 'Unable to load habits.',
    });
  }
});

habitsRouter.post('/', requireAuth, async (req: Request, res: Response) => {
  const parsed = createHabitSchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    res.status(400).json({
      status: 'error',
      message: 'Validation failed.',
      errors: z.flattenError(parsed.error).fieldErrors,
    });
    return;
  }

  // requireAuth guarantees authUser before the handler runs. The client's body
  // is never read for ownership, so a supplied userId cannot select another user.
  const authenticatedUser = req.authUser;
  if (!authenticatedUser) {
    res.status(401).json(UNAUTHORIZED);
    return;
  }

  const { name, frequency, target } = parsed.data;

  // Zod already trimmed these; an empty string is stored as NULL rather than ""
  // so "no description"/"no preferred time" has a single representation.
  const description = parsed.data.description || null;
  const preferredTime = parsed.data.preferredTime || null;

  try {
    const habit = await prisma.habit.create({
      data: {
        userId: authenticatedUser.id,
        name,
        description,
        frequency,
        target,
        preferredTime,
        status: 'ACTIVE',
      },
      select: habitPublicFields,
    });

    res.status(201).json({ status: 'success', data: { habit } });
  } catch {
    res.status(500).json({
      status: 'error',
      message: 'Unable to create habit.',
    });
  }
});

/**
 * POST /api/habits/:habitId/completions
 *
 * Creates one daily completion/miss record for an owned habit.
 */
habitsRouter.post('/:habitId/completions', requireAuth, async (req: Request, res: Response) => {
  const authenticatedUser = req.authUser;
  if (!authenticatedUser) {
    res.status(401).json(UNAUTHORIZED);
    return;
  }

  const rawHabitId = req.params.habitId;
  const habitId = Array.isArray(rawHabitId) ? rawHabitId[0] : rawHabitId;

  if (!habitId) {
    res.status(404).json({
      status: 'error',
      message: 'Habit not found.',
    });
    return;
  }

  const parsed = createCompletionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      status: 'error',
      message: 'Validation failed.',
      errors: z.flattenError(parsed.error).fieldErrors,
    });
    return;
  }

  const normalizedDate = normalizeCalendarDate(parsed.data.date);
  if (!normalizedDate) {
    res.status(400).json({
      status: 'error',
      message: 'Validation failed.',
      errors: {
        date: ['Date must be a valid calendar date.'],
      },
    });
    return;
  }

  const missReason = parsed.data.status === 'MISSED'
    ? (parsed.data.missReason || null)
    : null;

  try {
    const ownedHabit = await prisma.habit.findFirst({
      where: {
        id: habitId,
        userId: authenticatedUser.id,
      },
      select: { id: true },
    });

    if (!ownedHabit) {
      res.status(404).json({
        status: 'error',
        message: 'Habit not found.',
      });
      return;
    }

    const completion = await prisma.habitCompletion.create({
      data: {
        habitId: ownedHabit.id,
        userId: authenticatedUser.id,
        date: normalizedDate,
        status: parsed.data.status,
        missReason,
      },
      select: completionPublicFields,
    });

    res.status(201).json({
      status: 'success',
      data: { completion },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      res.status(409).json({
        status: 'error',
        message: 'A completion already exists for this habit and date.',
      });
      return;
    }

    res.status(500).json({
      status: 'error',
      message: 'Unable to create completion.',
    });
  }
});
