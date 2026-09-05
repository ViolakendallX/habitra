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

export const habitsRouter: Router = Router();

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
      select: {
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
      },
    });

    res.status(201).json({ status: 'success', data: { habit } });
  } catch {
    res.status(500).json({
      status: 'error',
      message: 'Unable to create habit.',
    });
  }
});
