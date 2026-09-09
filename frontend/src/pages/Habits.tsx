import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { api, isApiError } from '../lib/http';
import { useAuth } from '../context/AuthContext';
import { useNotifications } from '../context/NotificationContext';
import type {
  CompletionListResponse,
  CompletionResponse,
  CompletionStatus,
  Habit,
  HabitCompletion,
  HabitFrequency,
  HabitListResponse,
  HabitResponse,
} from '../lib/types';

/**
 * Habits page — the real habit workflow against the live API (no mock data).
 *
 * Everything here goes through lib/http.ts, so the session cookie is attached
 * by the browser and never read by this code. Ownership is entirely server-side:
 * no request ever sends a userId, and every endpoint is already scoped to the
 * session user, so a habit from another account is simply not in the response.
 *
 * Archiving is a soft delete: DELETE /api/habits/:habitId sets status to
 * ARCHIVED. The row and every completion record are kept — they just stop
 * appearing in GET /api/habits — which is why the confirm dialog says so.
 */

/** Backend rule: 24-hour HH:mm. */
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** Calendar days are UTC-normalised by the backend, so match it exactly. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** `2026-01-01T00:00:00.000Z` -> `2026-01-01` (the stored calendar day). */
function calendarDay(isoDate: string): string {
  return isoDate.slice(0, 10);
}

function describeFrequency(frequency: HabitFrequency): string {
  return frequency === 'DAILY' ? 'Daily' : 'Weekly';
}

function statusLabel(status: CompletionStatus): string {
  return status === 'COMPLETED' ? 'Completed' : 'Missed';
}

function messageFor(error: unknown): string {
  if (isApiError(error)) {
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}

/** A 409 means this habit already has a record for that day, not a crash. */
function isDuplicateCompletion(error: unknown): boolean {
  return isApiError(error) && error.status === 409;
}

interface HabitFormValues {
  name: string;
  description: string;
  frequency: HabitFrequency;
  /** Kept as text so the input can be empty while typing; parsed on submit. */
  target: string;
  preferredTime: string;
}

type FormErrors = Partial<Record<keyof HabitFormValues, string>>;

const EMPTY_VALUES: HabitFormValues = {
  name: '',
  description: '',
  frequency: 'DAILY',
  target: '1',
  preferredTime: '',
};

function toValues(habit: Habit): HabitFormValues {
  return {
    name: habit.name,
    description: habit.description ?? '',
    frequency: habit.frequency,
    target: String(habit.target),
    preferredTime: habit.preferredTime ?? '',
  };
}

/** Mirrors the backend's rules; empty optional text is sent as null (cleared). */
function toPayload(values: HabitFormValues) {
  return {
    name: values.name.trim(),
    description: values.description.trim() || null,
    frequency: values.frequency,
    target: Number(values.target),
    preferredTime: values.preferredTime.trim() || null,
  };
}

function validateValues(values: HabitFormValues): FormErrors {
  const errors: FormErrors = {};
  const name = values.name.trim();

  if (!name) {
    errors.name = 'Name is required.';
  } else if (name.length > 100) {
    errors.name = 'Name must be 100 characters or fewer.';
  }

  if (values.description.trim().length > 500) {
    errors.description = 'Description must be 500 characters or fewer.';
  }

  const target = Number(values.target);

  if (!values.target.trim()) {
    errors.target = 'Target is required.';
  } else if (!Number.isInteger(target) || target <= 0) {
    errors.target = 'Target must be a whole number greater than 0.';
  }

  const time = values.preferredTime.trim();

  if (time && !TIME_PATTERN.test(time)) {
    errors.preferredTime = 'Use a 24-hour time, like 07:30.';
  }

  return errors;
}

interface HabitFormProps {
  initialValues: HabitFormValues;
  submitLabel: string;
  /** Rejects on failure; the form renders the resulting error. */
  onSubmit: (values: HabitFormValues) => Promise<void>;
  onCancel: () => void;
}

function HabitForm({ initialValues, submitLabel, onSubmit, onCancel }: HabitFormProps) {
  const [values, setValues] = useState<HabitFormValues>(initialValues);
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function update<K extends keyof HabitFormValues>(key: K, value: HabitFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const validation = validateValues(values);
    setErrors(validation);

    if (Object.keys(validation).length > 0) {
      return;
    }

    setSubmitting(true);
    setFormError('');

    try {
      await onSubmit(values);
    } catch (error) {
      if (isApiError(error)) {
        // Prefer the server's per-field messages; fall back to its summary.
        const fieldErrors = error.fieldErrors;
        const mapped: FormErrors = {};

        for (const field of ['name', 'description', 'frequency', 'target', 'preferredTime'] as const) {
          const message = fieldErrors[field]?.[0];
          if (message) {
            mapped[field] = message;
          }
        }

        setErrors(mapped);
        setFormError(error.message);
      } else {
        setFormError(messageFor(error));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="form" onSubmit={handleSubmit} noValidate>
      {formError && <div className="alert alert--error">{formError}</div>}

      <div className="form__group">
        <label className="form__label" htmlFor="habit-name">
          Name
        </label>
        <input
          id="habit-name"
          className="form__input"
          value={values.name}
          onChange={(e) => update('name', e.target.value)}
          maxLength={100}
          disabled={submitting}
          required
        />
        {errors.name && <span className="form__error-text">{errors.name}</span>}
      </div>

      <div className="form__group">
        <label className="form__label" htmlFor="habit-description">
          Description <span className="form__hint">(optional)</span>
        </label>
        <input
          id="habit-description"
          className="form__input"
          value={values.description}
          onChange={(e) => update('description', e.target.value)}
          maxLength={500}
          disabled={submitting}
        />
        {errors.description && (
          <span className="form__error-text">{errors.description}</span>
        )}
      </div>

      <div className="form__group">
        <label className="form__label" htmlFor="habit-frequency">
          Frequency
        </label>
        <select
          id="habit-frequency"
          className="form__input"
          value={values.frequency}
          onChange={(e) => update('frequency', e.target.value as HabitFrequency)}
          disabled={submitting}
        >
          <option value="DAILY">Daily</option>
          <option value="WEEKLY">Weekly</option>
        </select>
        {errors.frequency && (
          <span className="form__error-text">{errors.frequency}</span>
        )}
      </div>

      <div className="form__group">
        <label className="form__label" htmlFor="habit-target">
          Target
        </label>
        <input
          id="habit-target"
          className="form__input"
          type="number"
          min={1}
          step={1}
          value={values.target}
          onChange={(e) => update('target', e.target.value)}
          disabled={submitting}
          required
        />
        <span className="form__hint">How many times per day/week.</span>
        {errors.target && <span className="form__error-text">{errors.target}</span>}
      </div>

      <div className="form__group">
        <label className="form__label" htmlFor="habit-time">
          Preferred time <span className="form__hint">(optional)</span>
        </label>
        <input
          id="habit-time"
          className="form__input"
          value={values.preferredTime}
          onChange={(e) => update('preferredTime', e.target.value)}
          placeholder="07:30"
          disabled={submitting}
        />
        <span className="form__hint">24-hour HH:mm. Leave blank for none.</span>
        {errors.preferredTime && (
          <span className="form__error-text">{errors.preferredTime}</span>
        )}
      </div>

      <div className="habits__form-actions">
        <button className="form__btn" type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : submitLabel}
        </button>
        <button
          className="btn btn--ghost"
          type="button"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function Habits() {
  const { user } = useAuth();
  const { refresh: refreshNotifications } = useNotifications();

  const [today] = useState(todayIso);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  /** habitId -> what is already recorded for today, so we can disable buttons. */
  const [todayStatus, setTodayStatus] = useState<Record<string, CompletionStatus>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [missFor, setMissFor] = useState<string | null>(null);
  const [missReason, setMissReason] = useState('');

  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<HabitCompletion[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');

  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; text: string } | null>(
    null,
  );

  const readTodayStatus = useCallback(
    async (habitId: string): Promise<CompletionStatus | null> => {
      try {
        const data = await api.get<CompletionListResponse>(
          `/habits/${habitId}/completions?from=${today}&to=${today}`,
        );
        return data?.completions?.[0]?.status ?? null;
      } catch {
        // A failure here must not block loading the habits themselves.
        return null;
      }
    },
    [today],
  );

  const loadHabits = useCallback(async () => {
    setLoading(true);
    setLoadError('');

    try {
      const data = await api.get<HabitListResponse>('/habits');
      const list = data?.habits ?? [];
      setHabits(list);

      const statuses = await Promise.all(
        list.map(async (habit) => [habit.id, await readTodayStatus(habit.id)] as const),
      );

      setTodayStatus(
        statuses.reduce<Record<string, CompletionStatus>>((acc, [id, status]) => {
          if (status) {
            acc[id] = status;
          }
          return acc;
        }, {}),
      );
    } catch (error) {
      setHabits([]);
      setLoadError(messageFor(error));
    } finally {
      setLoading(false);
    }
  }, [readTodayStatus]);

  useEffect(() => {
    void loadHabits();
  }, [loadHabits]);

  const loadHistory = useCallback(async (habitId: string) => {
    setHistoryLoading(true);
    setHistoryError('');

    try {
      const data = await api.get<CompletionListResponse>(`/habits/${habitId}/completions`);
      setHistory(data?.completions ?? []);
    } catch (error) {
      setHistory([]);
      setHistoryError(messageFor(error));
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  function toggleHistory(habitId: string) {
    if (historyFor === habitId) {
      setHistoryFor(null);
      setHistory([]);
      return;
    }

    setHistoryFor(habitId);
    setHistory([]);
    void loadHistory(habitId);
  }

  async function recordCompletion(habit: Habit, status: CompletionStatus, reason?: string) {
    setBusyId(habit.id);
    setBanner(null);

    try {
      await api.post<CompletionResponse>(`/habits/${habit.id}/completions`, {
        date: today,
        status,
        ...(status === 'MISSED' && reason?.trim() ? { missReason: reason.trim() } : {}),
      });

      setTodayStatus((current) => ({ ...current, [habit.id]: status }));
      // The bell is derived from this same data, so drop the now-stale nudge.
      void refreshNotifications();
      setMissFor(null);
      setMissReason('');
      setBanner({
        kind: 'success',
        text: `“${habit.name}” marked ${statusLabel(status).toLowerCase()} for today.`,
      });

      if (historyFor === habit.id) {
        await loadHistory(habit.id);
      }
    } catch (error) {
      if (isDuplicateCompletion(error)) {
        const existing = await readTodayStatus(habit.id);

        if (existing) {
          setTodayStatus((current) => ({ ...current, [habit.id]: existing }));
        }

        setBanner({
          kind: 'error',
          text: existing
            ? `“${habit.name}” is already marked ${statusLabel(existing).toLowerCase()} for today.`
            : `“${habit.name}” already has a record for today.`,
        });
      } else {
        setBanner({ kind: 'error', text: messageFor(error) });
      }
    } finally {
      setBusyId(null);
    }
  }

  async function archiveHabit(habit: Habit) {
    const confirmed = window.confirm(
      `Archive “${habit.name}”?\n\nIt will disappear from your active list, but nothing is erased: its completion history is kept and still counts toward your analytics. You can restore it later.`,
    );

    if (!confirmed) {
      return;
    }

    setBusyId(habit.id);
    setBanner(null);

    try {
      await api.remove<HabitResponse>(`/habits/${habit.id}`);
      setHabits((current) => current.filter((item) => item.id !== habit.id));
      setBanner({
        kind: 'success',
        text: `“${habit.name}” archived. Its history has been kept.`,
      });

      if (historyFor === habit.id) {
        setHistoryFor(null);
        setHistory([]);
      }

      if (editingId === habit.id) {
        setEditingId(null);
      }
    } catch (error) {
      setBanner({ kind: 'error', text: messageFor(error) });
    } finally {
      setBusyId(null);
    }
  }

  async function createHabit(values: HabitFormValues) {
    const created = await api.post<HabitResponse>('/habits', toPayload(values));
    setShowCreate(false);
    setBanner({
      kind: 'success',
      text: `Habit “${created?.habit?.name ?? values.name.trim()}” created.`,
    });
    await loadHabits();
  }

  async function saveEdit(habit: Habit, values: HabitFormValues) {
    const updated = await api.patch<HabitResponse>(`/habits/${habit.id}`, toPayload(values));
    setEditingId(null);
    setBanner({
      kind: 'success',
      text: `“${updated?.habit?.name ?? values.name.trim()}” updated.`,
    });
    await loadHabits();
  }

  return (
    <main className="shell">
      <header className="shell__header">
        <h1 className="shell__title">Habitra</h1>
        <p className="shell__tagline">Autonomous accountability that remembers.</p>
        {user && <p className="habits__user">Signed in as {user.name}</p>}
      </header>

      {banner && (
        <div className={banner.kind === 'success' ? 'alert alert--success' : 'alert alert--error'}>
          {banner.text}
        </div>
      )}

      <section className="card">
        <div className="habits__section-head">
          <h2 className="card__title">New habit</h2>
          {!showCreate && (
            <button className="btn btn--primary" type="button" onClick={() => setShowCreate(true)}>
              Add habit
            </button>
          )}
        </div>

        {showCreate ? (
          <HabitForm
            initialValues={EMPTY_VALUES}
            submitLabel="Create habit"
            onSubmit={createHabit}
            onCancel={() => setShowCreate(false)}
          />
        ) : (
          <p className="card__text">
            Track something you want to do consistently. You can record a result
            for today once a habit exists.
          </p>
        )}
      </section>

      <section className="card">
        <h2 className="card__title">Your habits</h2>

        {loading && <p className="habits__muted">Loading your habits…</p>}

        {!loading && loadError && (
          <div className="habits__error">
            <div className="alert alert--error">{loadError}</div>
            <button className="btn btn--primary" type="button" onClick={() => void loadHabits()}>
              Try again
            </button>
          </div>
        )}

        {!loading && !loadError && habits.length === 0 && (
          <p className="habits__muted">
            You have no active habits yet. Add your first one above to start
            building a streak.
          </p>
        )}

        {!loading && !loadError && habits.length > 0 && (
          <ul className="habits__list">
            {habits.map((habit) => {
              const recorded = todayStatus[habit.id];
              const busy = busyId === habit.id;

              return (
                <li className="habit" key={habit.id}>
                  {editingId === habit.id ? (
                    <HabitForm
                      initialValues={toValues(habit)}
                      submitLabel="Save changes"
                      onSubmit={(values) => saveEdit(habit, values)}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <>
                      <div className="habit__head">
                        <h3 className="habit__name">{habit.name}</h3>
                        <span className="habit__frequency">
                          {describeFrequency(habit.frequency)} · target {habit.target}
                        </span>
                      </div>

                      {habit.description && (
                        <p className="habit__description">{habit.description}</p>
                      )}

                      <p className="habit__meta">
                        {habit.preferredTime
                          ? `Preferred time ${habit.preferredTime}`
                          : 'No preferred time'}
                      </p>

                      {recorded && (
                        <p className="habits__muted">
                          <span
                            className={
                              recorded === 'COMPLETED' ? 'badge badge--ok' : 'badge badge--miss'
                            }
                          >
                            {statusLabel(recorded)} today
                          </span>
                        </p>
                      )}

                      <div className="habit__actions">
                        <button
                          className="btn btn--primary"
                          type="button"
                          disabled={busy || Boolean(recorded)}
                          onClick={() => void recordCompletion(habit, 'COMPLETED')}
                        >
                          Completed
                        </button>

                        <button
                          className="btn btn--danger"
                          type="button"
                          disabled={busy || Boolean(recorded)}
                          onClick={() => {
                            setMissFor(habit.id);
                            setMissReason('');
                          }}
                        >
                          Missed
                        </button>

                        <button
                          className="btn btn--ghost"
                          type="button"
                          disabled={busy}
                          onClick={() => setEditingId(habit.id)}
                        >
                          Edit
                        </button>

                        <button
                          className="btn btn--ghost"
                          type="button"
                          disabled={busy}
                          onClick={() => toggleHistory(habit.id)}
                        >
                          {historyFor === habit.id ? 'Hide history' : 'History'}
                        </button>

                        <button
                          className="btn btn--ghost"
                          type="button"
                          disabled={busy}
                          onClick={() => void archiveHabit(habit)}
                        >
                          Archive
                        </button>
                      </div>

                      {missFor === habit.id && (
                        <div className="habit__miss">
                          <label className="form__label" htmlFor={`miss-${habit.id}`}>
                            What got in the way? <span className="form__hint">(optional)</span>
                          </label>
                          <div className="habit__miss-row">
                            <input
                              id={`miss-${habit.id}`}
                              className="form__input"
                              value={missReason}
                              onChange={(e) => setMissReason(e.target.value)}
                              maxLength={500}
                              disabled={busy}
                            />
                            <button
                              className="btn btn--danger"
                              type="button"
                              disabled={busy}
                              onClick={() => void recordCompletion(habit, 'MISSED', missReason)}
                            >
                              {busy ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              className="btn btn--ghost"
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setMissFor(null);
                                setMissReason('');
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}

                      {historyFor === habit.id && (
                        <div className="habit__history">
                          {historyLoading && <p className="habits__muted">Loading history…</p>}

                          {!historyLoading && historyError && (
                            <div className="alert alert--error">{historyError}</div>
                          )}

                          {!historyLoading && !historyError && history.length === 0 && (
                            <p className="habits__muted">No results recorded yet.</p>
                          )}

                          {!historyLoading && !historyError && history.length > 0 && (
                            <>
                              <ul className="history__list">
                                {history.slice(0, 10).map((entry) => (
                                  <li className="history__item" key={entry.id}>
                                    <span className="history__date">
                                      {calendarDay(entry.date)}
                                    </span>
                                    <span
                                      className={
                                        entry.status === 'COMPLETED'
                                          ? 'badge badge--ok'
                                          : 'badge badge--miss'
                                      }
                                    >
                                      {statusLabel(entry.status)}
                                    </span>
                                    {entry.missReason && (
                                      <span className="history__reason">{entry.missReason}</span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                              {history.length > 10 && (
                                <p className="habits__muted">
                                  Showing the 10 most recent of {history.length}.
                                </p>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
