import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { api } from '../lib/http';
import {
  buildAgentNotification,
  buildNotifications,
  combineNotifications,
  pruneDismissedIds,
  todayUtcKey,
  type HabitraNotification,
} from '../lib/notifications';
import { playNotificationSound, primeNotificationSound } from '../lib/sound';
import type {
  AgentRecommendation,
  ChallengeListResponse,
  CompletionListResponse,
  CompletionStatus,
  HabitListResponse,
} from '../lib/types';

import { useAuth } from './AuthContext';

/**
 * In-app notifications, derived — never stored, sent or scheduled.
 *
 * The whole feature lives in the browser:
 *
 *   - The LIST is computed from endpoints the app already calls
 *     (GET /api/habits, /habits/:id/completions, /challenges). No new backend
 *     surface, no new table, no polling loop and no background job.
 *   - The only thing persisted is this device's PREFERENCES — two booleans and
 *     the ids the user dismissed — under `habitra.notifications.v1`. Nothing
 *     sensitive is ever written: no token, no email, no habit content beyond an
 *     internal id.
 *
 * Gemini is never called from here. The agent notification is registered by
 * whichever screen already fetched a recommendation (Agent / Dashboard).
 */

const STORAGE_KEY = 'habitra.notifications.v1';

interface NotificationPreferences {
  enabled: boolean;
  soundEnabled: boolean;
  /** Ids the user has dismissed. Un-dismissed == unread. */
  dismissedIds: string[];
}

const DEFAULT_PREFERENCES: NotificationPreferences = {
  enabled: true,
  // Off by default: no unrequested audio. Flip it on in Settings.
  soundEnabled: false,
  dismissedIds: [],
};

/** Used when browser storage is unavailable (private mode, quota, disabled). */
let memoryPreferences: NotificationPreferences | null = null;

function normalizePreferences(value: unknown): NotificationPreferences {
  const raw = (value ?? {}) as Partial<NotificationPreferences>;

  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_PREFERENCES.enabled,
    soundEnabled:
      typeof raw.soundEnabled === 'boolean'
        ? raw.soundEnabled
        : DEFAULT_PREFERENCES.soundEnabled,
    dismissedIds: Array.isArray(raw.dismissedIds)
      ? raw.dismissedIds.filter((id): id is string => typeof id === 'string')
      : [],
  };
}

function readPreferences(): NotificationPreferences {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) return normalizePreferences(JSON.parse(raw));
    }
  } catch {
    // Corrupt or unreadable storage: fall back rather than break the app.
  }

  return memoryPreferences ?? DEFAULT_PREFERENCES;
}

function writePreferences(next: NotificationPreferences): void {
  memoryPreferences = next;

  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    // Preferences are a convenience; a failed write just means "not remembered".
  }
}

export interface NotificationContextValue {
  /** Visible notifications, most severe first, capped at 5. */
  notifications: HabitraNotification[];
  /** Same as `notifications.length` — dismissing is how you mark one read. */
  unreadCount: number;
  enabled: boolean;
  soundEnabled: boolean;
  setEnabled: (next: boolean) => void;
  setSoundEnabled: (next: boolean) => void;
  /** Hides one notification for this device. */
  dismiss: (id: string) => void;
  /** Hides every currently visible notification. */
  dismissAll: () => void;
  /** Recomputes the list. Call after an action that changes habits/challenges. */
  refresh: () => Promise<void>;
  /**
   * Hands the context a recommendation the caller already fetched. Never
   * triggers a model call of its own.
   */
  registerAgentRecommendation: (recommendation: AgentRecommendation | null) => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();

  const [preferences, setPreferences] = useState<NotificationPreferences>(readPreferences);
  const [derived, setDerived] = useState<HabitraNotification[]>([]);
  const [agentNotification, setAgentNotification] = useState<HabitraNotification | null>(null);

  const dismissedIds = useMemo(
    () => new Set(preferences.dismissedIds),
    [preferences.dismissedIds],
  );

  const notifications = useMemo(() => {
    if (!preferences.enabled) return [];

    return combineNotifications([[agentNotification], derived]).filter(
      (item) => !dismissedIds.has(item.id),
    );
  }, [preferences.enabled, agentNotification, derived, dismissedIds]);

  const load = useCallback(async (): Promise<void> => {
    if (!isAuthenticated || !preferences.enabled) {
      setDerived([]);
      return;
    }

    const today = todayUtcKey();

    try {
      const habitData = await api.get<HabitListResponse>('/habits');
      const habits = habitData?.habits ?? [];

      const [statuses, challengeData] = await Promise.all([
        Promise.all(
          habits.map(async (habit) => {
            try {
              const data = await api.get<CompletionListResponse>(
                `/habits/${habit.id}/completions?from=${today}&to=${today}`,
              );
              return [habit.id, data?.completions?.[0]?.status] as const;
            } catch {
              return [habit.id, undefined] as const;
            }
          }),
        ),
        api.get<ChallengeListResponse>('/challenges').catch(() => null),
      ]);

      const todayStatus: Record<string, CompletionStatus | undefined> = {};
      for (const [habitId, status] of statuses) {
        if (status) todayStatus[habitId] = status;
      }

      setDerived(
        buildNotifications({
          today,
          habits,
          todayStatus,
          challenges: challengeData?.challenges ?? [],
        }),
      );
    } catch {
      // Notifications are a convenience: a failed read must never disturb the
      // page the user is on, so the list is simply left as it was.
    }
  }, [isAuthenticated, preferences.enabled]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    writePreferences(preferences);
  }, [preferences]);

  // Chime once per genuinely new id. The first batch is recorded silently —
  // otherwise every page load would announce notifications the user just saw.
  const announcedRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!preferences.enabled) {
      announcedRef.current = null;
      return;
    }

    const ids = notifications.map((item) => item.id);

    if (announcedRef.current === null) {
      announcedRef.current = new Set(ids);
      return;
    }

    const fresh = ids.filter((id) => !announcedRef.current?.has(id));
    for (const id of ids) announcedRef.current.add(id);

    if (fresh.length > 0 && preferences.soundEnabled) {
      playNotificationSound();
    }
  }, [notifications, preferences.enabled, preferences.soundEnabled]);

  const setEnabled = useCallback((next: boolean) => {
    primeNotificationSound();
    setPreferences((current) => ({ ...current, enabled: next }));
  }, []);

  const setSoundEnabled = useCallback((next: boolean) => {
    primeNotificationSound();
    setPreferences((current) => ({ ...current, soundEnabled: next }));
  }, []);

  const dismiss = useCallback((id: string) => {
    setPreferences((current) => ({
      ...current,
      dismissedIds: pruneDismissedIds([...current.dismissedIds, id], todayUtcKey()),
    }));
  }, []);

  const dismissAll = useCallback(() => {
    if (notifications.length === 0) return;

    const ids = notifications.map((item) => item.id);
    const today = todayUtcKey();

    setPreferences((current) => ({
      ...current,
      dismissedIds: pruneDismissedIds([...current.dismissedIds, ...ids], today),
    }));
  }, [notifications]);

  const registerAgentRecommendation = useCallback(
    (recommendation: AgentRecommendation | null) => {
      setAgentNotification(recommendation ? buildAgentNotification(recommendation) : null);
    },
    [],
  );

  const value = useMemo<NotificationContextValue>(
    () => ({
      notifications,
      unreadCount: notifications.length,
      enabled: preferences.enabled,
      soundEnabled: preferences.soundEnabled,
      setEnabled,
      setSoundEnabled,
      dismiss,
      dismissAll,
      refresh: load,
      registerAgentRecommendation,
    }),
    [
      notifications,
      preferences.enabled,
      preferences.soundEnabled,
      setEnabled,
      setSoundEnabled,
      dismiss,
      dismissAll,
      load,
      registerAgentRecommendation,
    ],
  );

  return (
    <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>
  );
}

export function useNotifications(): NotificationContextValue {
  const context = useContext(NotificationContext);

  if (!context) {
    throw new Error('useNotifications must be used inside a NotificationProvider.');
  }

  return context;
}
