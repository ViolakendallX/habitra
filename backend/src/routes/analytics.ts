import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { prisma } from '../db/prisma.js';
import { UNAUTHORIZED, requireAuth } from '../middleware/auth.js';

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

type StreakMetrics = {
  currentStreak: number;
  bestStreak: number;
};

type HabitAnalytics = {
  habitId: string;
  name: string;
  completionRate: number;
  currentStreak: number;
  bestStreak: number;
  totalCompleted: number;
  totalMissed: number;
  totalTracked: number;
};

type DailyStatus = {
  date: Date;
  status: 'COMPLETED' | 'MISSED';
};

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

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateDiffInDays(previous: Date, next: Date): number {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.round((next.getTime() - previous.getTime()) / millisecondsPerDay);
}

function computeCompletionRate(completed: number, tracked: number): number {
  if (tracked === 0) return 0;
  return Number(((completed / tracked) * 100).toFixed(2));
}

function computeStreaksByDailyStatus(entries: DailyStatus[]): StreakMetrics {
  if (entries.length === 0) {
    return { currentStreak: 0, bestStreak: 0 };
  }

  const sorted = [...entries].sort((a, b) => a.date.getTime() - b.date.getTime());

  let best = 0;
  let running = 0;

  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index];

    if (entry.status !== 'COMPLETED') {
      running = 0;
      continue;
    }

    if (index === 0) {
      running = 1;
    } else {
      const previous = sorted[index - 1];
      const consecutive = dateDiffInDays(previous.date, entry.date) === 1;
      running = previous.status === 'COMPLETED' && consecutive ? running + 1 : 1;
    }

    if (running > best) {
      best = running;
    }
  }

  let current = 0;
  let cursor = sorted.length - 1;
  while (cursor >= 0 && sorted[cursor].status === 'COMPLETED') {
    if (cursor === sorted.length - 1) {
      current = 1;
      cursor -= 1;
      continue;
    }

    const nextEntry = sorted[cursor + 1];
    const entry = sorted[cursor];
    const consecutive = dateDiffInDays(entry.date, nextEntry.date) === 1;

    if (!consecutive) {
      break;
    }

    current += 1;
    cursor -= 1;
  }

  return { currentStreak: current, bestStreak: best };
}

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
    const habits = await prisma.habit.findMany({
      where: { userId: authenticatedUser.id },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });

    const dateFilter = {
      ...(normalizedFrom ? { gte: normalizedFrom } : {}),
      ...(normalizedTo ? { lte: normalizedTo } : {}),
    };

    const completions = await prisma.habitCompletion.findMany({
      where: {
        userId: authenticatedUser.id,
        ...(Object.keys(dateFilter).length > 0 ? { date: dateFilter } : {}),
      },
      select: {
        id: true,
        habitId: true,
        userId: true,
        date: true,
        status: true,
        missReason: true,
        createdAt: true,
      },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
    });

    const totalCompleted = completions.filter((entry) => entry.status === 'COMPLETED').length;
    const totalMissed = completions.filter((entry) => entry.status === 'MISSED').length;
    const totalTracked = completions.length;

    const dailyAggregation = new Map<string, { date: Date; completed: number; missed: number }>();

    for (const completion of completions) {
      const key = dayKey(completion.date);
      const existing = dailyAggregation.get(key) ?? {
        date: new Date(completion.date.getTime()),
        completed: 0,
        missed: 0,
      };

      if (completion.status === 'COMPLETED') {
        existing.completed += 1;
      } else {
        existing.missed += 1;
      }

      dailyAggregation.set(key, existing);
    }

    const overallDailyStatus: DailyStatus[] = [...dailyAggregation.values()].map((value) => ({
      date: value.date,
      status: value.missed === 0 && value.completed > 0 ? 'COMPLETED' : 'MISSED',
    }));

    const overallStreaks = computeStreaksByDailyStatus(overallDailyStatus);

    const completionsByHabit = new Map<string, typeof completions>();
    for (const completion of completions) {
      const entries = completionsByHabit.get(completion.habitId) ?? [];
      entries.push(completion);
      completionsByHabit.set(completion.habitId, entries);
    }

    const habitsAnalytics: HabitAnalytics[] = habits.map((habit) => {
      const entries = completionsByHabit.get(habit.id) ?? [];
      const completed = entries.filter((entry) => entry.status === 'COMPLETED').length;
      const missed = entries.filter((entry) => entry.status === 'MISSED').length;
      const tracked = entries.length;

      const dailyEntries: DailyStatus[] = entries.map((entry) => ({
        date: entry.date,
        status: entry.status === 'COMPLETED' ? 'COMPLETED' : 'MISSED',
      }));

      const streaks = computeStreaksByDailyStatus(dailyEntries);

      return {
        habitId: habit.id,
        name: habit.name,
        completionRate: computeCompletionRate(completed, tracked),
        currentStreak: streaks.currentStreak,
        bestStreak: streaks.bestStreak,
        totalCompleted: completed,
        totalMissed: missed,
        totalTracked: tracked,
      };
    });

    const sortedForMost = [...habitsAnalytics].sort((a, b) => {
      if (b.completionRate !== a.completionRate) return b.completionRate - a.completionRate;
      if (b.totalTracked !== a.totalTracked) return b.totalTracked - a.totalTracked;
      return a.habitId.localeCompare(b.habitId);
    });

    const sortedForLeast = [...habitsAnalytics].sort((a, b) => {
      if (a.completionRate !== b.completionRate) return a.completionRate - b.completionRate;
      if (a.totalTracked !== b.totalTracked) return a.totalTracked - b.totalTracked;
      return a.habitId.localeCompare(b.habitId);
    });

    const missReasonCounts = new Map<string, number>();
    for (const completion of completions) {
      if (completion.status !== 'MISSED') continue;
      const reason = completion.missReason?.trim();
      if (!reason) continue;
      missReasonCounts.set(reason, (missReasonCounts.get(reason) ?? 0) + 1);
    }

    const commonMissReasons = [...missReasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.reason.localeCompare(b.reason);
      });

    res.status(200).json({
      status: 'success',
      data: {
        analytics: {
          dateRange: {
            from: parsedQuery.data.from ?? null,
            to: parsedQuery.data.to ?? null,
          },
          overall: {
            completionRate: computeCompletionRate(totalCompleted, totalTracked),
            currentStreak: overallStreaks.currentStreak,
            bestStreak: overallStreaks.bestStreak,
            totalCompleted,
            totalMissed,
            totalTracked,
          },
          habits: habitsAnalytics,
          mostConsistentHabit: sortedForMost[0] ?? null,
          leastConsistentHabit: sortedForLeast[0] ?? null,
          commonMissReasons,
        },
      },
    });
  } catch {
    res.status(500).json({
      status: 'error',
      message: 'Unable to load analytics.',
    });
  }
});
