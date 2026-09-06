/**
 * Analytics service.
 *
 * Pure, user-scoped analytics computation. This module was extracted from the
 * original `GET /api/analytics` route so the same deterministic calculations can
 * be reused by the API route and (later) by the AI agent without duplicating
 * logic. It performs its own database access through the shared Prisma client
 * and is the ONLY place the streak / rate / ranking math lives.
 *
 * Behavior is preserved exactly from the original route:
 * - UTC-midnight calendar-date convention
 * - `completionRate = completed / tracked * 100` (0 when tracked is 0)
 * - overall streak is computed on day-aggregated status (a day with any miss is
 *   MISSED), per-habit streak on raw rows
 * - deterministic tie-breaking by `completionRate`, then `totalTracked`, then `habitId`
 *
 * The service is strictly user-scoped: the caller supplies the authenticated
 * user's id. It never reads a userId from a request body/query, so it cannot be
 * pivoted to another user.
 */

import { prisma } from '../db/prisma.js';

export type StreakMetrics = {
  currentStreak: number;
  bestStreak: number;
};

export type HabitAnalytics = {
  habitId: string;
  name: string;
  completionRate: number;
  currentStreak: number;
  bestStreak: number;
  totalCompleted: number;
  totalMissed: number;
  totalTracked: number;
};

export type DailyStatus = {
  date: Date;
  status: 'COMPLETED' | 'MISSED';
};

export type AnalyticsDateRange = {
  from: string | null;
  to: string | null;
};

export type UserAnalytics = {
  dateRange: AnalyticsDateRange;
  overall: {
    completionRate: number;
    currentStreak: number;
    bestStreak: number;
    totalCompleted: number;
    totalMissed: number;
    totalTracked: number;
  };
  habits: HabitAnalytics[];
  mostConsistentHabit: HabitAnalytics | null;
  leastConsistentHabit: HabitAnalytics | null;
  commonMissReasons: { reason: string; count: number }[];
};

/** Parses `YYYY-MM-DD` into a UTC-midnight Date, or null if invalid. */
export function normalizeCalendarDate(dateString: string): Date | null {
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

export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function dateDiffInDays(previous: Date, next: Date): number {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.round((next.getTime() - previous.getTime()) / millisecondsPerDay);
}

export function computeCompletionRate(completed: number, tracked: number): number {
  if (tracked === 0) return 0;
  return Number(((completed / tracked) * 100).toFixed(2));
}

export function computeStreaksByDailyStatus(entries: DailyStatus[]): StreakMetrics {
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

/**
 * Computes analytics for a single user. `range.from` / `range.to` are
 * `YYYY-MM-DD` strings (already validated by the caller) or null for "no bound".
 * Returns the exact `analytics` payload consumed by the API route; the HTTP
 * envelope (`{ status, data }`) is added by the route.
 */
export async function computeUserAnalytics(
  userId: string,
  range: AnalyticsDateRange,
): Promise<UserAnalytics> {
  const normalizedFrom = range.from ? normalizeCalendarDate(range.from) : null;
  const normalizedTo = range.to ? normalizeCalendarDate(range.to) : null;

  const dateFilter = {
    ...(normalizedFrom ? { gte: normalizedFrom } : {}),
    ...(normalizedTo ? { lte: normalizedTo } : {}),
  };

  const habits = await prisma.habit.findMany({
    where: { userId },
    select: { id: true, name: true },
    orderBy: { id: 'asc' },
  });

  const completions = await prisma.habitCompletion.findMany({
    where: {
      userId,
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

  return {
    dateRange: { from: range.from ?? null, to: range.to ?? null },
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
  };
}
