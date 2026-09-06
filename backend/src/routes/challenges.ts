import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { prisma } from '../db/prisma.js';
import { UNAUTHORIZED, requireAuth } from '../middleware/auth.js';
import {
  evaluateChallengeProgress,
  evaluateChallengeProgressForUser,
  type ChallengeLinkedHabit,
  type ChallengeStatus,
  type CompletionStatus,
} from '../services/challenges.js';
import { normalizeCalendarDate } from '../services/analytics.js';

const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/;

const createChallengeSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Title is required.')
    .max(120, 'Title must be 120 characters or fewer.'),
  description: z
    .string()
    .trim()
    .max(500, 'Description must be 500 characters or fewer.')
    .nullable()
    .optional(),
  startDate: z
    .string()
    .regex(calendarDatePattern, 'Start date must be in YYYY-MM-DD format.'),
  endDate: z
    .string()
    .regex(calendarDatePattern, 'End date must be in YYYY-MM-DD format.'),
  maxMisses: z
    .number()
    .int('Max misses must be an integer.')
    .min(0, 'Max misses must be greater than or equal to 0.')
    .optional(),
  habitId: z
    .string()
    .trim()
    .min(1, 'Habit is required.'),
});

const challengePublicFields = {
  id: true,
  userId: true,
  title: true,
  description: true,
  status: true,
  startDate: true,
  endDate: true,
  durationDays: true,
  maxMisses: true,
  committedAt: true,
  completedAt: true,
  failedAt: true,
  failReason: true,
  createdAt: true,
  updatedAt: true,
} as const;

type ChallengeDbClient = {
  challenge: typeof prisma.challenge;
  habitCompletion: typeof prisma.habitCompletion;
};

function computeInclusiveDurationDays(startDate: Date, endDate: Date): number {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.round((endDate.getTime() - startDate.getTime()) / millisecondsPerDay) + 1;
}

function resolveChallengeId(req: Request): string | undefined {
  const rawChallengeId = req.params.challengeId;
  return Array.isArray(rawChallengeId) ? rawChallengeId[0] : rawChallengeId;
}

function badStateTransition(res: Response, message: string): void {
  res.status(409).json({
    status: 'error',
    message,
  });
}

function toLinkedHabitSummary(habit: { id: string; name: string; status: string } | null) {
  if (!habit) return null;
  return {
    habitId: habit.id,
    name: habit.name,
    status: habit.status,
  };
}

async function buildChallengeResponseForUser(userId: string, challengeId: string) {
  const challenge = await prisma.challenge.findFirst({
    where: { id: challengeId, userId },
    select: {
      ...challengePublicFields,
      habitLinks: {
        select: {
          habit: {
            select: {
              id: true,
              name: true,
              status: true,
            },
          },
        },
        orderBy: { id: 'asc' },
        take: 1,
      },
    },
  });

  if (!challenge) return null;

  const linked = challenge.habitLinks[0]?.habit ?? null;
  const progress = await evaluateChallengeProgressForUser(userId, challenge.id);

  return {
    id: challenge.id,
    userId: challenge.userId,
    title: challenge.title,
    description: challenge.description,
    status: challenge.status,
    startDate: challenge.startDate,
    endDate: challenge.endDate,
    durationDays: challenge.durationDays,
    maxMisses: challenge.maxMisses,
    committedAt: challenge.committedAt,
    completedAt: challenge.completedAt,
    failedAt: challenge.failedAt,
    failReason: challenge.failReason,
    createdAt: challenge.createdAt,
    updatedAt: challenge.updatedAt,
    linkedHabit: toLinkedHabitSummary(linked),
    progress,
  };
}

async function loadChallengeEvaluationSnapshot(
  client: ChallengeDbClient,
  userId: string,
  challengeId: string,
  now: Date,
) {
  const challenge = await client.challenge.findFirst({
    where: {
      id: challengeId,
      userId,
    },
    select: {
      id: true,
      userId: true,
      status: true,
      startDate: true,
      endDate: true,
      durationDays: true,
      maxMisses: true,
      habitLinks: {
        select: {
          habit: {
            select: {
              id: true,
              name: true,
              status: true,
              userId: true,
            },
          },
        },
        orderBy: { id: 'asc' },
      },
    },
  });

  if (!challenge) {
    return null;
  }

  const linkedHabits: ChallengeLinkedHabit[] = challenge.habitLinks.map((link) => ({
    habitId: link.habit.id,
    name: link.habit.name,
    status: link.habit.status,
  }));

  const firstLinkedHabit = challenge.habitLinks[0]?.habit;
  const completions = firstLinkedHabit
    ? await client.habitCompletion.findMany({
      where: {
        userId,
        habitId: firstLinkedHabit.id,
        date: {
          gte: challenge.startDate,
          lte: challenge.endDate,
        },
      },
      select: {
        date: true,
        status: true,
      },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    })
    : [];

  const progress = evaluateChallengeProgress({
    challengeId: challenge.id,
    currentStatus: challenge.status as ChallengeStatus,
    startDate: challenge.startDate,
    endDate: challenge.endDate,
    durationDays: challenge.durationDays,
    maxMisses: challenge.maxMisses,
    linkedHabits,
    completions: completions.map((entry) => ({
      date: entry.date,
      status: entry.status as CompletionStatus,
    })),
    now,
  });

  return {
    challenge,
    progress,
  };
}

function activationValidationError(
  challenge: {
    startDate: Date;
    endDate: Date;
    durationDays: number;
    maxMisses: number;
    habitLinks: Array<{ habit: { userId: string } }>;
  },
  userId: string,
): string | null {
  if (challenge.habitLinks.length !== 1) {
    return 'Challenge must have exactly one linked habit before commit.';
  }

  if (challenge.habitLinks[0].habit.userId !== userId) {
    return 'Challenge linked habit is invalid for this user.';
  }

  if (challenge.startDate.getTime() > challenge.endDate.getTime()) {
    return 'Challenge has an invalid date range.';
  }

  const expectedDuration = computeInclusiveDurationDays(challenge.startDate, challenge.endDate);
  if (challenge.durationDays !== expectedDuration) {
    return 'Challenge duration does not match its inclusive date range.';
  }

  if (!Number.isInteger(challenge.maxMisses) || challenge.maxMisses < 0) {
    return 'Challenge max misses is invalid.';
  }

  return null;
}

export const challengesRouter: Router = Router();

challengesRouter.post('/', requireAuth, async (req: Request, res: Response) => {
  const authenticatedUser = req.authUser;
  if (!authenticatedUser) {
    res.status(401).json(UNAUTHORIZED);
    return;
  }

  const parsed = createChallengeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      status: 'error',
      message: 'Validation failed.',
      errors: z.flattenError(parsed.error).fieldErrors,
    });
    return;
  }

  const normalizedStartDate = normalizeCalendarDate(parsed.data.startDate);
  const normalizedEndDate = normalizeCalendarDate(parsed.data.endDate);

  const dateErrors: Record<string, string[]> = {};

  if (!normalizedStartDate) {
    dateErrors.startDate = ['Start date must be a valid calendar date.'];
  }

  if (!normalizedEndDate) {
    dateErrors.endDate = ['End date must be a valid calendar date.'];
  }

  if (Object.keys(dateErrors).length > 0) {
    res.status(400).json({
      status: 'error',
      message: 'Validation failed.',
      errors: dateErrors,
    });
    return;
  }

  if (!normalizedStartDate || !normalizedEndDate) {
    res.status(400).json({
      status: 'error',
      message: 'Validation failed.',
    });
    return;
  }

  if (normalizedStartDate.getTime() > normalizedEndDate.getTime()) {
    res.status(400).json({
      status: 'error',
      message: 'Validation failed.',
      errors: {
        startDate: ['Start date must be on or before end date.'],
      },
    });
    return;
  }

  const durationDays = computeInclusiveDurationDays(normalizedStartDate, normalizedEndDate);
  const description = parsed.data.description || null;
  const maxMisses = parsed.data.maxMisses ?? 0;

  try {
    const created = await prisma.$transaction(async (tx) => {
      const ownedHabit = await tx.habit.findFirst({
        where: {
          id: parsed.data.habitId,
          userId: authenticatedUser.id,
        },
        select: {
          id: true,
          name: true,
          status: true,
        },
      });

      if (!ownedHabit) {
        return null;
      }

      const challenge = await tx.challenge.create({
        data: {
          userId: authenticatedUser.id,
          title: parsed.data.title,
          description,
          status: 'DRAFT',
          startDate: normalizedStartDate,
          endDate: normalizedEndDate,
          durationDays,
          maxMisses,
        },
        select: challengePublicFields,
      });

      await tx.challengeHabit.create({
        data: {
          challengeId: challenge.id,
          habitId: ownedHabit.id,
        },
      });

      return {
        challenge,
        linkedHabit: {
          habitId: ownedHabit.id,
          name: ownedHabit.name,
          status: ownedHabit.status,
        },
      };
    });

    if (!created) {
      res.status(404).json({
        status: 'error',
        message: 'Habit not found.',
      });
      return;
    }

    const progress = await evaluateChallengeProgressForUser(authenticatedUser.id, created.challenge.id);

    res.status(201).json({
      status: 'success',
      data: {
        challenge: {
          ...created.challenge,
          linkedHabit: created.linkedHabit,
          progress,
        },
      },
    });
  } catch {
    res.status(500).json({
      status: 'error',
      message: 'Unable to create challenge.',
    });
  }
});

challengesRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  const authenticatedUser = req.authUser;
  if (!authenticatedUser) {
    res.status(401).json(UNAUTHORIZED);
    return;
  }

  try {
    const challenges = await prisma.challenge.findMany({
      where: { userId: authenticatedUser.id },
      select: {
        ...challengePublicFields,
        habitLinks: {
          select: {
            habit: {
              select: {
                id: true,
                name: true,
                status: true,
              },
            },
          },
          orderBy: { id: 'asc' },
          take: 1,
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const enriched = await Promise.all(
      challenges.map(async (challenge) => {
        const linked = challenge.habitLinks[0]?.habit;
        const progress = await evaluateChallengeProgressForUser(authenticatedUser.id, challenge.id);

        return {
          id: challenge.id,
          userId: challenge.userId,
          title: challenge.title,
          description: challenge.description,
          status: challenge.status,
          startDate: challenge.startDate,
          endDate: challenge.endDate,
          durationDays: challenge.durationDays,
          maxMisses: challenge.maxMisses,
          committedAt: challenge.committedAt,
          completedAt: challenge.completedAt,
          failedAt: challenge.failedAt,
          failReason: challenge.failReason,
          createdAt: challenge.createdAt,
          updatedAt: challenge.updatedAt,
          linkedHabit: toLinkedHabitSummary(linked ?? null),
          progress,
        };
      }),
    );

    res.status(200).json({
      status: 'success',
      data: { challenges: enriched },
    });
  } catch {
    res.status(500).json({
      status: 'error',
      message: 'Unable to load challenges.',
    });
  }
});

challengesRouter.get('/:challengeId', requireAuth, async (req: Request, res: Response) => {
  const authenticatedUser = req.authUser;
  if (!authenticatedUser) {
    res.status(401).json(UNAUTHORIZED);
    return;
  }

  const challengeId = resolveChallengeId(req);

  if (!challengeId) {
    res.status(404).json({
      status: 'error',
      message: 'Challenge not found.',
    });
    return;
  }

  try {
    const challenge = await buildChallengeResponseForUser(authenticatedUser.id, challengeId);

    if (!challenge) {
      res.status(404).json({
        status: 'error',
        message: 'Challenge not found.',
      });
      return;
    }

    res.status(200).json({
      status: 'success',
      data: { challenge },
    });
  } catch {
    res.status(500).json({
      status: 'error',
      message: 'Unable to load challenge.',
    });
  }
});

challengesRouter.post('/:challengeId/commit', requireAuth, async (req: Request, res: Response) => {
  const authenticatedUser = req.authUser;
  if (!authenticatedUser) {
    res.status(401).json(UNAUTHORIZED);
    return;
  }

  const challengeId = resolveChallengeId(req);
  if (!challengeId) {
    res.status(404).json({
      status: 'error',
      message: 'Challenge not found.',
    });
    return;
  }

  try {
    const commitResult = await prisma.$transaction(async (tx) => {
      const challenge = await tx.challenge.findFirst({
        where: {
          id: challengeId,
          userId: authenticatedUser.id,
        },
        select: {
          id: true,
          userId: true,
          status: true,
          startDate: true,
          endDate: true,
          durationDays: true,
          maxMisses: true,
          habitLinks: {
            select: {
              habit: {
                select: {
                  userId: true,
                },
              },
            },
            orderBy: { id: 'asc' },
          },
        },
      });

      if (!challenge) {
        return { kind: 'NOT_FOUND' } as const;
      }

      if (challenge.status !== 'DRAFT') {
        return { kind: 'INVALID_STATE', status: challenge.status } as const;
      }

      const validationError = activationValidationError(challenge, authenticatedUser.id);
      if (validationError) {
        return { kind: 'INVALID_CHALLENGE', message: validationError } as const;
      }

      const updated = await tx.challenge.updateMany({
        where: {
          id: challenge.id,
          userId: authenticatedUser.id,
          status: 'DRAFT',
        },
        data: {
          status: 'ACTIVE',
          committedAt: new Date(),
        },
      });

      if (updated.count === 0) {
        return { kind: 'INVALID_STATE', status: 'UNKNOWN' } as const;
      }

      return { kind: 'COMMITTED' } as const;
    });

    if (commitResult.kind === 'NOT_FOUND') {
      res.status(404).json({
        status: 'error',
        message: 'Challenge not found.',
      });
      return;
    }

    if (commitResult.kind === 'INVALID_STATE') {
      badStateTransition(res, 'Challenge cannot be committed from its current status.');
      return;
    }

    if (commitResult.kind === 'INVALID_CHALLENGE') {
      badStateTransition(res, commitResult.message);
      return;
    }

    const challenge = await buildChallengeResponseForUser(authenticatedUser.id, challengeId);

    if (!challenge) {
      res.status(404).json({
        status: 'error',
        message: 'Challenge not found.',
      });
      return;
    }

    res.status(200).json({
      status: 'success',
      data: { challenge },
    });
  } catch {
    res.status(500).json({
      status: 'error',
      message: 'Unable to commit challenge.',
    });
  }
});

challengesRouter.post('/:challengeId/evaluate', requireAuth, async (req: Request, res: Response) => {
  const authenticatedUser = req.authUser;
  if (!authenticatedUser) {
    res.status(401).json(UNAUTHORIZED);
    return;
  }

  const challengeId = resolveChallengeId(req);
  if (!challengeId) {
    res.status(404).json({
      status: 'error',
      message: 'Challenge not found.',
    });
    return;
  }

  try {
    const now = new Date();

    const evaluation = await prisma.$transaction(async (tx) => {
      const snapshot = await loadChallengeEvaluationSnapshot(tx, authenticatedUser.id, challengeId, now);

      if (!snapshot) {
        return { kind: 'NOT_FOUND' } as const;
      }

      const currentStatus = snapshot.challenge.status as ChallengeStatus;
      const targetStatus = snapshot.progress.status;

      if (currentStatus === 'DRAFT') {
        return { kind: 'NOOP' } as const;
      }

      if (currentStatus === 'COMPLETED' || currentStatus === 'FAILED' || currentStatus === 'ARCHIVED') {
        return { kind: 'NOOP' } as const;
      }

      if (currentStatus !== 'ACTIVE') {
        return { kind: 'NOOP' } as const;
      }

      if (targetStatus === 'FAILED') {
        await tx.challenge.updateMany({
          where: {
            id: challengeId,
            userId: authenticatedUser.id,
            status: 'ACTIVE',
          },
          data: {
            status: 'FAILED',
            failedAt: now,
            failReason: snapshot.progress.failureReason,
          },
        });

        return { kind: 'UPDATED' } as const;
      }

      if (targetStatus === 'COMPLETED') {
        await tx.challenge.updateMany({
          where: {
            id: challengeId,
            userId: authenticatedUser.id,
            status: 'ACTIVE',
          },
          data: {
            status: 'COMPLETED',
            completedAt: now,
          },
        });

        return { kind: 'UPDATED' } as const;
      }

      return { kind: 'NOOP' } as const;
    });

    if (evaluation.kind === 'NOT_FOUND') {
      res.status(404).json({
        status: 'error',
        message: 'Challenge not found.',
      });
      return;
    }

    const challenge = await buildChallengeResponseForUser(authenticatedUser.id, challengeId);

    if (!challenge) {
      res.status(404).json({
        status: 'error',
        message: 'Challenge not found.',
      });
      return;
    }

    res.status(200).json({
      status: 'success',
      data: { challenge },
    });
  } catch {
    res.status(500).json({
      status: 'error',
      message: 'Unable to evaluate challenge.',
    });
  }
});
