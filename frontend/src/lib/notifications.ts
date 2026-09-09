import type { AgentRecommendation, Challenge, CompletionStatus, Habit } from './types';

/**
 * Notification rules for Habitra's in-app bell.
 *
 * Everything here is PURE and derived: notifications are never stored, never
 * sent, and never scheduled. They are computed from data the app already
 * fetches, which is why this feature needs no backend surface at all.
 *
 * Two rules keep the feature quiet:
 *
 * 1. IDs are deterministic (`kind:ref:utcDay`). The same situation always
 *    produces the same id, so a refetch can never create a duplicate, and
 *    "dismissed" is just a set of ids the user has already seen.
 * 2. Challenge notifications only READ the progress fields the backend already
 *    computes. Pass/fail is never re-derived here — `services/challenges.ts`
 *    stays the single source of truth on the server.
 */

export type NotificationSeverity = 'normal' | 'warning' | 'urgent';

export type NotificationKind =
  | 'habit-incomplete'
  | 'challenge-risk'
  | 'agent-intervention';

export interface HabitraNotification {
  /** Deterministic: `kind:ref:utcDay` (or `agent-intervention:recommendationId`). */
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  message: string;
  /** In-app destination for the notification's "Open" link. */
  to: string;
}

/** The panel stays small; anything beyond this is simply not listed. */
export const MAX_VISIBLE_NOTIFICATIONS = 5;

const SEVERITY_RANK: Record<NotificationSeverity, number> = {
  urgent: 0,
  warning: 1,
  normal: 2,
};

/** The app's calendar convention: days are UTC-normalised, like the backend. */
export function todayUtcKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** `HH:mm` -> minutes since midnight, or null when unset/unparseable. */
function parsePreferredMinutes(value: string | null): number | null {
  if (!value) return null;

  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * True when it is still too early to nag about this habit today.
 *
 * `preferredTime` is a wall-clock preference ("08:00" means 8am to the person,
 * not 08:00 UTC), so it is compared against the viewer's local clock.
 */
function isBeforePreferredTime(habit: Habit, now: Date): boolean {
  const preferred = parsePreferredMinutes(habit.preferredTime);
  if (preferred === null) return false;
  return now.getHours() * 60 + now.getMinutes() < preferred;
}

export interface BuildNotificationsInput {
  /** `YYYY-MM-DD`, the UTC day the notifications are for. */
  today: string;
  habits: Habit[];
  /** habitId -> today's recorded status. Absent means "nothing recorded". */
  todayStatus: Record<string, CompletionStatus | undefined>;
  challenges: Challenge[];
  /** Injectable for tests; defaults to now. */
  now?: Date;
}

/** One normal notification per habit with no record for today. */
export function buildNotifications(input: BuildNotificationsInput): HabitraNotification[] {
  const now = input.now ?? new Date();
  const list: HabitraNotification[] = [];

  for (const habit of input.habits) {
    // Anything already recorded for today is settled for the day — including a
    // deliberate "missed" — so it must not raise an "incomplete" nudge.
    if (input.todayStatus[habit.id]) continue;
    if (isBeforePreferredTime(habit, now)) continue;

    list.push({
      id: `habit-incomplete:${habit.id}:${input.today}`,
      kind: 'habit-incomplete',
      severity: 'normal',
      title: `${habit.name} is still open`,
      message: 'Not marked complete yet today.',
      to: '/habits',
    });
  }

  for (const challenge of input.challenges) {
    const progress = challenge.progress;
    if (!progress || challenge.status !== 'ACTIVE') continue;

    const misses = progress.daysMissed;
    const allowance = progress.remainingMissAllowance;

    // At most one notification per challenge: urgent wins over warning.
    // "Low" allowance only escalates once the user has actually spent some of
    // it — a fresh challenge with a small allowance stays quiet.
    if (allowance <= 0 || (misses > 0 && allowance <= 1)) {
      list.push({
        id: `challenge-allowance:${challenge.id}:${input.today}`,
        kind: 'challenge-risk',
        severity: 'urgent',
        title: `${challenge.title} is at risk`,
        message:
          allowance > 0
            ? `Only ${allowance} miss${allowance === 1 ? '' : 'es'} left before this challenge fails.`
            : 'No miss allowance left — one more miss fails this challenge.',
        to: '/challenges',
      });
    } else if (misses > 0) {
      list.push({
        id: `challenge-missed:${challenge.id}:${input.today}`,
        kind: 'challenge-risk',
        severity: 'warning',
        title: `${challenge.title} has missed days`,
        message: `${progress.daysMissed} day${progress.daysMissed === 1 ? '' : 's'} missed so far.`,
        to: '/challenges',
      });
    }
  }

  return list;
}

/**
 * Turns an already-fetched agent recommendation into a notification.
 *
 * This NEVER triggers a model call — the caller passes a recommendation it
 * obtained for its own reasons (the Agent page / Dashboard insight button).
 */
export function buildAgentNotification(
  recommendation: AgentRecommendation,
): HabitraNotification | null {
  if (!recommendation.intervention?.needed) return null;

  const suffix = recommendation.recommendationId || recommendation.generatedAt;

  return {
    id: `agent-intervention:${suffix}`,
    kind: 'agent-intervention',
    severity: 'warning',
    title: 'Habitra has an accountability nudge',
    message: recommendation.intervention.reason,
    to: '/agent',
  };
}

/**
 * Merges every source, de-dupes by id, ranks urgent first and caps the list.
 */
export function combineNotifications(
  groups: Array<Array<HabitraNotification | null | undefined>>,
): HabitraNotification[] {
  const byId = new Map<string, HabitraNotification>();

  for (const group of groups) {
    for (const item of group) {
      if (item) byId.set(item.id, item);
    }
  }

  return [...byId.values()]
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, MAX_VISIBLE_NOTIFICATIONS);
}

/** Drops day-stamped ids older than `keepDays`, and hard-caps the set. */
export function pruneDismissedIds(ids: string[], today: string, keepDays = 7): string[] {
  const cutoff = new Date(`${today}T00:00:00.000Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - keepDays);
  const cutoffKey = cutoff.toISOString().slice(0, 10);

  const kept = ids.filter((id) => {
    const parts = id.split(':');
    const day = parts[parts.length - 1];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return true;
    return day >= cutoffKey;
  });

  return kept.slice(-100);
}
