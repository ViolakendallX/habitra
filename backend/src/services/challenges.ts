import { prisma } from '../db/prisma.js';

export type ChallengeStatus = 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'ARCHIVED';
export type CompletionStatus = 'COMPLETED' | 'MISSED';

export interface ChallengeLinkedHabit {
  habitId: string;
  name: string;
  status: string;
}

export interface ChallengeCompletionEntry {
  date: Date;
  status: CompletionStatus;
}

export interface EvaluateChallengeInput {
  challengeId: string;
  currentStatus: ChallengeStatus;
  startDate: Date;
  endDate: Date;
  durationDays: number;
  maxMisses: number;
  linkedHabits: ChallengeLinkedHabit[];
  completions: ChallengeCompletionEntry[];
  now: Date;
}

export interface ChallengeProgressSnapshot {
  challengeId: string;
  status: ChallengeStatus;
  currentStatus: ChallengeStatus;
  startDate: string;
  endDate: string;
  durationDays: number;
  daysTotal: number;
  daysElapsed: number;
  daysCompleted: number;
  daysMissed: number;
  daysPending: number;
  maxMisses: number;
  remainingMissAllowance: number;
  completionRate: number;
  linkedHabit: ChallengeLinkedHabit | null;
  failureReason: string | null;
}

function toUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dayKey(date: Date): string {
  return toUtcDay(date).toISOString().slice(0, 10);
}

function addUtcDays(date: Date, days: number): Date {
  const d = toUtcDay(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function diffUtcDays(start: Date, end: Date): number {
  const startDay = toUtcDay(start);
  const endDay = toUtcDay(end);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((endDay.getTime() - startDay.getTime()) / msPerDay);
}

function computeDaysTotal(startDate: Date, endDate: Date): number {
  return diffUtcDays(startDate, endDate) + 1;
}

function computeCompletionRate(completed: number, total: number): number {
  if (total <= 0) return 0;
  return Number(((completed / total) * 100).toFixed(2));
}

function toCompletionMap(entries: ChallengeCompletionEntry[]): Map<string, CompletionStatus> {
  const map = new Map<string, CompletionStatus>();

  for (const entry of entries) {
    const key = dayKey(entry.date);
    const current = map.get(key);

    if (!current) {
      map.set(key, entry.status);
      continue;
    }

    // Deterministic tie-breaker: MISSED outranks COMPLETED if duplicates ever appear.
    if (current === 'COMPLETED' && entry.status === 'MISSED') {
      map.set(key, 'MISSED');
    }
  }

  return map;
}

function computeDaysElapsed(startDate: Date, endDate: Date, today: Date): number {
  const todayDay = toUtcDay(today);
  const startDay = toUtcDay(startDate);
  const endDay = toUtcDay(endDate);

  if (todayDay.getTime() < startDay.getTime()) {
    return 0;
  }

  if (todayDay.getTime() > endDay.getTime()) {
    return computeDaysTotal(startDay, endDay);
  }

  return computeDaysTotal(startDay, todayDay);
}

function evaluateStatus(
  currentStatus: ChallengeStatus,
  hasExactlyOneLinkedHabit: boolean,
  today: Date,
  endDate: Date,
  daysMissed: number,
  maxMisses: number,
): { status: ChallengeStatus; failureReason: string | null } {
  if (currentStatus === 'ARCHIVED' || currentStatus === 'COMPLETED' || currentStatus === 'FAILED') {
    return { status: currentStatus, failureReason: null };
  }

  if (currentStatus === 'DRAFT') {
    return { status: 'DRAFT', failureReason: null };
  }

  if (!hasExactlyOneLinkedHabit) {
    return {
      status: 'FAILED',
      failureReason: 'INVALID_LINKED_HABIT_COUNT',
    };
  }

  if (daysMissed > maxMisses) {
    return {
      status: 'FAILED',
      failureReason: `MISSES_EXCEEDED:${daysMissed}>${maxMisses}`,
    };
  }

  if (toUtcDay(today).getTime() > toUtcDay(endDate).getTime()) {
    return { status: 'COMPLETED', failureReason: null };
  }

  return { status: 'ACTIVE', failureReason: null };
}

export function evaluateChallengeProgress(input: EvaluateChallengeInput): ChallengeProgressSnapshot {
  const startDay = toUtcDay(input.startDate);
  const endDay = toUtcDay(input.endDate);
  const todayDay = toUtcDay(input.now);

  const daysTotal = computeDaysTotal(startDay, endDay);
  const daysElapsed = computeDaysElapsed(startDay, endDay, todayDay);

  const completionMap = toCompletionMap(input.completions);

  let daysCompleted = 0;
  let daysMissed = 0;
  let daysPending = 0;

  for (let offset = 0; offset < daysTotal; offset += 1) {
    const day = addUtcDays(startDay, offset);
    const key = dayKey(day);
    const status = completionMap.get(key);

    if (status === 'COMPLETED') {
      daysCompleted += 1;
      continue;
    }

    if (status === 'MISSED') {
      daysMissed += 1;
      continue;
    }

    if (day.getTime() < todayDay.getTime()) {
      // Closed UTC days with no row count as missed.
      daysMissed += 1;
      continue;
    }

    // Today (until UTC day close) and future days remain pending when no row exists.
    daysPending += 1;
  }

  const linkedHabit = input.linkedHabits[0] ?? null;
  const hasExactlyOneLinkedHabit = input.linkedHabits.length === 1;

  const evaluated = evaluateStatus(
    input.currentStatus,
    hasExactlyOneLinkedHabit,
    todayDay,
    endDay,
    daysMissed,
    input.maxMisses,
  );

  return {
    challengeId: input.challengeId,
    status: evaluated.status,
    currentStatus: input.currentStatus,
    startDate: startDay.toISOString().slice(0, 10),
    endDate: endDay.toISOString().slice(0, 10),
    durationDays: input.durationDays,
    daysTotal,
    daysElapsed,
    daysCompleted,
    daysMissed,
    daysPending,
    maxMisses: input.maxMisses,
    remainingMissAllowance: input.maxMisses - daysMissed,
    completionRate: computeCompletionRate(daysCompleted, daysTotal),
    linkedHabit,
    failureReason: evaluated.failureReason,
  };
}

export async function evaluateChallengeProgressForUser(
  userId: string,
  challengeId: string,
  now: Date = new Date(),
): Promise<ChallengeProgressSnapshot | null> {
  const challenge = await prisma.challenge.findFirst({
    where: {
      id: challengeId,
      userId,
    },
    select: {
      id: true,
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

  const linkedHabits = challenge.habitLinks.map((link) => ({
    habitId: link.habit.id,
    name: link.habit.name,
    status: link.habit.status,
  }));

  const habitId = linkedHabits[0]?.habitId;

  const completions = habitId
    ? await prisma.habitCompletion.findMany({
      where: {
        userId,
        habitId,
        date: {
          gte: toUtcDay(challenge.startDate),
          lte: toUtcDay(challenge.endDate),
        },
      },
      select: {
        date: true,
        status: true,
      },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    })
    : [];

  return evaluateChallengeProgress({
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
}
