import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { prisma } from '../db/prisma.js';
import { UNAUTHORIZED, requireAuth } from '../middleware/auth.js';
import { recordCompletionEvent, saveHabitBehaviorProfile } from '../services/memory.js';

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

/**
 * Update schema for PATCH /api/habits/:habitId.
 *
 * Every field is optional so the route accepts partial updates. The two
 * nullable columns use `.nullish()` (optional *and* nullable) so a client can
 * send an explicit `null` to clear the stored value; that is then told apart
 * from "field omitted" by testing the parsed value against `undefined` (a JSON
 * body cannot express `undefined`, so a present key always has a real value).
 *
 * The same validation rules as creation apply to any field that is supplied.
 * `id`, `userId`, `createdAt` and `updatedAt` are deliberately absent, and Zod
 * strips unknown keys, so a body can never target a protected column.
 */
const updateHabitSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required.')
    .max(100, 'Name must be 100 characters or fewer.')
    .optional(),
  description: z
    .string()
    .trim()
    .max(500, 'Description must be 500 characters or fewer.')
    .nullish(),
  frequency: z
    .enum(['DAILY', 'WEEKLY'], {
      error: 'Frequency must be DAILY or WEEKLY.',
    })
    .optional(),
  target: z
    .number()
    .int('Target must be an integer.')
    .positive('Target must be greater than 0.')
    .optional(),
  preferredTime: z
    .string()
    .regex(timePattern, 'Preferred time must be a valid 24-hour HH:mm time.')
    .nullish(),
  status: z
    .enum(['ACTIVE', 'ARCHIVED'], {
      error: 'Status must be ACTIVE or ARCHIVED.',
    })
    .optional(),
});

/**
 * The writable columns of a habit, with the exact types Prisma accepts. The
 * update payload is built field-by-field into this shape instead of spreading
 * the request body, so a protected column cannot reach Prisma even if the
 * schema ever changes.
 */
type HabitUpdatePayload = {
  name?: string;
  description?: string | null;
  frequency?: 'DAILY' | 'WEEKLY';
  target?: number;
  preferredTime?: string | null;
  status?: 'ACTIVE' | 'ARCHIVED';
};

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

const completionHistoryQuerySchema = z.object({
  from: z
    .string()
    .regex(completionDatePattern, 'From must be in YYYY-MM-DD format.')
    .optional(),
  to: z
    .string()
    .regex(completionDatePattern, 'To must be in YYYY-MM-DD format.')
    .optional(),
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

function resolveHabitId(req: Request): string | undefined {
  const rawHabitId = req.params.habitId;
  return Array.isArray(rawHabitId) ? rawHabitId[0] : rawHabitId;
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
 * Lists the authenticated user's ACTIVE habits, newest first. Archived habits
 * are only hidden from this response — they stay in the database with their full
 * completion history, and remain reachable through the completion-history and
 * analytics routes.
 *
 * The filter is always the id that requireAuth resolved from the session cookie;
 * no query parameter, body field, or header is read, so a client cannot request
 * another user's rows or flip the status filter.
 */
habitsRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  const authenticatedUser = req.authUser;
  if (!authenticatedUser) {
    res.status(401).json(UNAUTHORIZED);
    return;
  }

  try {
    const habits = await prisma.habit.findMany({
      // Archiving is a soft delete, so it is filtered out here for the UI while
      // the row and its history are left untouched in the database.
      where: { userId: authenticatedUser.id, status: 'ACTIVE' },
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
 * PATCH /api/habits/:habitId
 *
 * Partially updates one of the authenticated user's habits. Only the columns in
 * updateHabitSchema are writable, and the Prisma payload is assembled key by
 * key, so `id`, `userId`, `createdAt` and `updatedAt` can never be reassigned
 * from a request body.
 *
 * Ownership is enforced by scoping the lookup to the session user, and an
 * unowned or nonexistent habit returns the same generic 404 as the other habit
 * routes so the response cannot be used to probe which ids exist.
 */
habitsRouter.patch('/:habitId', requireAuth, async (req: Request, res: Response) => {
  const authenticatedUser = req.authUser;
  if (!authenticatedUser) {
    res.status(401).json(UNAUTHORIZED);
    return;
  }

  const habitId = resolveHabitId(req);
  if (!habitId) {
    res.status(404).json({
      status: 'error',
      message: 'Habit not found.',
    });
    return;
  }

  const parsed = updateHabitSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      status: 'error',
      message: 'Validation failed.',
      errors: z.flattenError(parsed.error).fieldErrors,
    });
    return;
  }

  // Unknown keys are stripped by Zod, so this catches both `{}` and a body made
  // up only of fields that are not updatable (e.g. a client-supplied userId).
  if (Object.keys(parsed.data).length === 0) {
    res.status(400).json({
      status: 'error',
      message: 'At least one updatable field must be provided.',
    });
    return;
  }

  const updateData: HabitUpdatePayload = {};

  // `!== undefined` distinguishes "supplied" from "omitted"; an explicit null
  // clears a nullable column, matching how create collapses "" to NULL.
  if (parsed.data.name !== undefined) {
    updateData.name = parsed.data.name;
  }

  if (parsed.data.description !== undefined) {
    updateData.description = parsed.data.description ?? null;
  }

  if (parsed.data.frequency !== undefined) {
    updateData.frequency = parsed.data.frequency;
  }

  if (parsed.data.target !== undefined) {
    updateData.target = parsed.data.target;
  }

  if (parsed.data.preferredTime !== undefined) {
    updateData.preferredTime = parsed.data.preferredTime ?? null;
  }

  if (parsed.data.status !== undefined) {
    updateData.status = parsed.data.status;
  }

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

    const habit = await prisma.habit.update({
      where: { id: ownedHabit.id },
      data: updateData,
      select: habitPublicFields,
    });

    res.status(200).json({ status: 'success', data: { habit } });
  } catch {
    res.status(500).json({
      status: 'error',
      message: 'Unable to update habit.',
    });
  }
});

/**
 * DELETE /api/habits/:habitId
 *
 * Soft-deactivates one of the authenticated user's habits by setting its
 * status to ARCHIVED. Nothing is physically removed: the Habit row, its
 * HabitCompletion history, and therefore all analytics and future memory
 * lookups stay intact.
 *
 * The request body is never read, so no ownership field can be supplied by the
 * client — the update is filtered by `id` AND the session user's id, and a
 * nonexistent or unowned habit returns the same generic 404 as every other
 * habit route.
 *
 * Archiving is idempotent: re-running it on an already-ARCHIVED habit simply
 * writes the same value and still succeeds.
 */
habitsRouter.delete('/:habitId', requireAuth, async (req: Request, res: Response) => {
  const authenticatedUser = req.authUser;
  if (!authenticatedUser) {
    res.status(401).json(UNAUTHORIZED);
    return;
  }

  const habitId = resolveHabitId(req);
  if (!habitId) {
    res.status(404).json({
      status: 'error',
      message: 'Habit not found.',
    });
    return;
  }

  try {
    // updateMany (rather than update) so a non-matching id/user yields a count
    // of 0 instead of throwing P2025; the where clause is the whole ownership
    // check, and it makes the call safe to repeat.
    const archived = await prisma.habit.updateMany({
      where: {
        id: habitId,
        userId: authenticatedUser.id,
      },
      data: { status: 'ARCHIVED' },
    });

    if (archived.count === 0) {
      res.status(404).json({
        status: 'error',
        message: 'Habit not found.',
      });
      return;
    }

    const habit = await prisma.habit.findFirst({
      where: {
        id: habitId,
        userId: authenticatedUser.id,
      },
      select: habitPublicFields,
    });

    res.status(200).json({ status: 'success', data: { habit } });
  } catch {
    res.status(500).json({
      status: 'error',
      message: 'Unable to archive habit.',
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

  const habitId = resolveHabitId(req);

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
      select: { id: true, name: true, frequency: true, preferredTime: true },
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

    // STEP 10 — mirror the behavioral signal into Sibyl Memory.
    //
    // PostgreSQL remains the source of truth for completions. Sibyl is an
    // augmentation: we record a COLD event for every COMPLETED/MISSED outcome
    // (including the miss reason) and refresh the habit's WARM behavior profile.
    // A Sibyl failure must NEVER cause this completion request to fail, so the
    // writes are isolated in their own try/catch and the 201 is always sent.
    // The duplicate (409) path returns earlier in the outer catch, so no memory
    // is written for a rejected duplicate.
    try {
      const outcome = parsed.data.status === 'COMPLETED' ? 'completed' : 'missed';
      const dateStr = normalizedDate.toISOString().slice(0, 10);

      await recordCompletionEvent(authenticatedUser.id, {
        habitId: ownedHabit.id,
        habitName: ownedHabit.name,
        outcome,
        date: dateStr,
        missReason,
        source: 'completion_route',
      });

      await saveHabitBehaviorProfile(authenticatedUser.id, ownedHabit.id, {
        habitId: ownedHabit.id,
        habitName: ownedHabit.name,
        cadence: ownedHabit.frequency === 'WEEKLY' ? 'weekly' : 'daily',
        bestTimeOfDay: ownedHabit.preferredTime ?? null,
        // Latest miss reason only, as a single derived item — never raw
        // completion rows. COLD events are not searchable (the SDK's
        // search_entities only covers WARM entities), so this is the only way a
        // miss reason can be recalled by the Agent. Cleared on a completion.
        commonMissReasons: missReason ? [missReason] : [],
        notes: `Last outcome: ${outcome} on ${dateStr}`,
      });
    } catch (memoryErr) {
      // Defense in depth: recordCompletionEvent / saveHabitBehaviorProfile
      // already swallow and warn internally; this guards against any unexpected
      // throw so the completion response is never affected.
      console.warn('[completions] Sibyl memory write skipped:', memoryErr);
    }

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

/**
 * GET /api/habits/:habitId/completions
 *
 * Returns completion history for an owned habit, optionally filtered by an
 * inclusive date range.
 */
habitsRouter.get('/:habitId/completions', requireAuth, async (req: Request, res: Response) => {
  const authenticatedUser = req.authUser;
  if (!authenticatedUser) {
    res.status(401).json(UNAUTHORIZED);
    return;
  }

  const habitId = resolveHabitId(req);
  if (!habitId) {
    res.status(404).json({
      status: 'error',
      message: 'Habit not found.',
    });
    return;
  }

  const parsedQuery = completionHistoryQuerySchema.safeParse(req.query ?? {});
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

    const dateFilter = {
      ...(normalizedFrom ? { gte: normalizedFrom } : {}),
      ...(normalizedTo ? { lte: normalizedTo } : {}),
    };

    const completions = await prisma.habitCompletion.findMany({
      where: {
        habitId: ownedHabit.id,
        ...(Object.keys(dateFilter).length > 0 ? { date: dateFilter } : {}),
      },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      select: completionPublicFields,
    });

    res.status(200).json({
      status: 'success',
      data: { completions },
    });
  } catch {
    res.status(500).json({
      status: 'error',
      message: 'Unable to load completion history.',
    });
  }
});
