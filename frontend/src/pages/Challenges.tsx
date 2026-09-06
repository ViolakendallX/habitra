import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { api, isApiError } from '../lib/http';
import { useAuth } from '../context/AuthContext';
import type {
  Challenge,
  ChallengeListResponse,
  ChallengeResponse,
  ChallengeStatus,
  CreateChallengeInput,
  Habit,
  HabitListResponse,
} from '../lib/types';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

interface ChallengeFormValues {
  title: string;
  description: string;
  startDate: string;
  endDate: string;
  maxMisses: string;
  habitId: string;
}

type FormErrors = Partial<Record<keyof ChallengeFormValues, string>>;

const EMPTY_VALUES: ChallengeFormValues = {
  title: '',
  description: '',
  startDate: '',
  endDate: '',
  maxMisses: '0',
  habitId: '',
};

function messageFor(error: unknown): string {
  if (isApiError(error)) return error.message;
  return 'Something went wrong. Please try again.';
}

function toIsoDay(value: string): Date | null {
  if (!datePattern.test(value)) return null;
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;

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

function formatDate(value: string): string {
  if (!value) return '-';
  return value.slice(0, 10);
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function statusBadgeClass(status: ChallengeStatus): string {
  if (status === 'COMPLETED') return 'badge badge--ok';
  if (status === 'FAILED' || status === 'ARCHIVED') return 'badge badge--miss';
  return 'badge';
}

function validateValues(values: ChallengeFormValues): FormErrors {
  const errors: FormErrors = {};

  const title = values.title.trim();
  if (!title) {
    errors.title = 'Title is required.';
  } else if (title.length > 120) {
    errors.title = 'Title must be 120 characters or fewer.';
  }

  if (values.description.trim().length > 500) {
    errors.description = 'Description must be 500 characters or fewer.';
  }

  const start = toIsoDay(values.startDate.trim());
  if (!values.startDate.trim()) {
    errors.startDate = 'Start date is required.';
  } else if (!start) {
    errors.startDate = 'Start date must be a valid YYYY-MM-DD date.';
  }

  const end = toIsoDay(values.endDate.trim());
  if (!values.endDate.trim()) {
    errors.endDate = 'End date is required.';
  } else if (!end) {
    errors.endDate = 'End date must be a valid YYYY-MM-DD date.';
  }

  if (start && end && start.getTime() > end.getTime()) {
    errors.startDate = 'Start date must be on or before end date.';
  }

  if (!values.habitId.trim()) {
    errors.habitId = 'Please choose a habit.';
  }

  const missesText = values.maxMisses.trim();
  if (!missesText) {
    errors.maxMisses = 'Max misses is required.';
  } else {
    const misses = Number(missesText);
    if (!Number.isInteger(misses) || misses < 0) {
      errors.maxMisses = 'Max misses must be a whole number 0 or greater.';
    }
  }

  return errors;
}

function toCreatePayload(values: ChallengeFormValues): CreateChallengeInput {
  return {
    title: values.title.trim(),
    description: values.description.trim() || null,
    startDate: values.startDate.trim(),
    endDate: values.endDate.trim(),
    maxMisses: Number(values.maxMisses.trim()),
    habitId: values.habitId,
  };
}

interface ChallengeFormProps {
  habits: Habit[];
  onSubmit: (values: ChallengeFormValues) => Promise<void>;
  onCancel: () => void;
}

function ChallengeForm({ habits, onSubmit, onCancel }: ChallengeFormProps) {
  const [values, setValues] = useState<ChallengeFormValues>({
    ...EMPTY_VALUES,
    habitId: habits[0]?.id ?? '',
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function update<K extends keyof ChallengeFormValues>(key: K, value: ChallengeFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const validation = validateValues(values);
    setErrors(validation);

    if (Object.keys(validation).length > 0) return;

    setSubmitting(true);
    setFormError('');

    try {
      await onSubmit(values);
      setValues({ ...EMPTY_VALUES, habitId: habits[0]?.id ?? '' });
      setErrors({});
    } catch (error) {
      if (isApiError(error)) {
        const mapped: FormErrors = {
          title: error.fieldErrors.title?.[0],
          description: error.fieldErrors.description?.[0],
          startDate: error.fieldErrors.startDate?.[0],
          endDate: error.fieldErrors.endDate?.[0],
          maxMisses: error.fieldErrors.maxMisses?.[0],
          habitId: error.fieldErrors.habitId?.[0],
        };
        setErrors(mapped);
        setFormError(error.message);
      } else {
        setFormError(messageFor(error));
      }
      throw error;
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="form" onSubmit={handleSubmit} noValidate>
      {formError && <div className="alert alert--error">{formError}</div>}

      <div className="form__group">
        <label className="form__label" htmlFor="challenge-title">Title</label>
        <input
          id="challenge-title"
          className="form__input"
          value={values.title}
          onChange={(e) => update('title', e.target.value)}
          maxLength={120}
          disabled={submitting}
          required
        />
        {errors.title && <span className="form__error-text">{errors.title}</span>}
      </div>

      <div className="form__group">
        <label className="form__label" htmlFor="challenge-description">
          Description <span className="form__hint">(optional)</span>
        </label>
        <input
          id="challenge-description"
          className="form__input"
          value={values.description}
          onChange={(e) => update('description', e.target.value)}
          maxLength={500}
          disabled={submitting}
        />
        {errors.description && <span className="form__error-text">{errors.description}</span>}
      </div>

      <div className="form__group">
        <label className="form__label" htmlFor="challenge-habit">Habit</label>
        <select
          id="challenge-habit"
          className="form__input"
          value={values.habitId}
          onChange={(e) => update('habitId', e.target.value)}
          disabled={submitting || habits.length === 0}
          required
        >
          {habits.length === 0 && <option value="">No habits available</option>}
          {habits.map((habit) => (
            <option key={habit.id} value={habit.id}>{habit.name}</option>
          ))}
        </select>
        {errors.habitId && <span className="form__error-text">{errors.habitId}</span>}
      </div>

      <div className="challenges__dates-row">
        <div className="form__group">
          <label className="form__label" htmlFor="challenge-start">Start date</label>
          <input
            id="challenge-start"
            className="form__input"
            type="date"
            value={values.startDate}
            onChange={(e) => update('startDate', e.target.value)}
            disabled={submitting}
            required
          />
          {errors.startDate && <span className="form__error-text">{errors.startDate}</span>}
        </div>

        <div className="form__group">
          <label className="form__label" htmlFor="challenge-end">End date</label>
          <input
            id="challenge-end"
            className="form__input"
            type="date"
            value={values.endDate}
            onChange={(e) => update('endDate', e.target.value)}
            disabled={submitting}
            required
          />
          {errors.endDate && <span className="form__error-text">{errors.endDate}</span>}
        </div>
      </div>

      <div className="form__group">
        <label className="form__label" htmlFor="challenge-max-misses">Max misses</label>
        <input
          id="challenge-max-misses"
          className="form__input"
          type="number"
          min={0}
          step={1}
          value={values.maxMisses}
          onChange={(e) => update('maxMisses', e.target.value)}
          disabled={submitting}
          required
        />
        {errors.maxMisses && <span className="form__error-text">{errors.maxMisses}</span>}
      </div>

      <div className="habits__form-actions">
        <button className="form__btn" type="submit" disabled={submitting || habits.length === 0}>
          {submitting ? 'Creating…' : 'Create challenge'}
        </button>
        <button className="btn btn--ghost" type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ChallengeSummary({ challenge }: { challenge: Challenge }) {
  const progress = challenge.progress;

  return (
    <div className="challenge-summary">
      <div className="challenge-summary__header">
        <h3 className="challenge-summary__title">{challenge.title}</h3>
        <span className={statusBadgeClass(challenge.status)}>{challenge.status}</span>
      </div>

      {challenge.description && <p className="challenge-summary__description">{challenge.description}</p>}

      <p className="challenge-summary__meta">
        {formatDate(challenge.startDate)} → {formatDate(challenge.endDate)} · {challenge.durationDays} day{challenge.durationDays === 1 ? '' : 's'}
      </p>

      {progress && (
        <div className="challenge-summary__stats">
          <span>Completed: {progress.daysCompleted}</span>
          <span>Missed: {progress.daysMissed}</span>
          <span>Pending: {progress.daysPending}</span>
          <span>Allowance: {progress.remainingMissAllowance}</span>
        </div>
      )}

      {challenge.failReason && (
        <p className="challenge-summary__reason">Failure reason: {challenge.failReason}</p>
      )}
    </div>
  );
}

function ChallengeDetails({ challenge }: { challenge: Challenge }) {
  const progress = challenge.progress;

  return (
    <section className="card challenge-details">
      <h2 className="card__title">Challenge details</h2>

      <div className="challenge-details__grid">
        <p><strong>Title:</strong> {challenge.title}</p>
        <p><strong>Status:</strong> {challenge.status}</p>
        <p><strong>Start date:</strong> {formatDate(challenge.startDate)}</p>
        <p><strong>End date:</strong> {formatDate(challenge.endDate)}</p>
        <p><strong>Duration:</strong> {challenge.durationDays} day{challenge.durationDays === 1 ? '' : 's'}</p>
        <p><strong>Max misses:</strong> {challenge.maxMisses}</p>
        <p><strong>Linked habit:</strong> {challenge.linkedHabit?.name ?? '-'}</p>
        <p><strong>Remaining miss allowance:</strong> {progress ? progress.remainingMissAllowance : '-'}</p>
      </div>

      {challenge.description && <p className="challenge-details__description">{challenge.description}</p>}

      {progress && (
        <div className="challenge-details__metrics">
          <p><strong>Days elapsed:</strong> {progress.daysElapsed}</p>
          <p><strong>Days completed:</strong> {progress.daysCompleted}</p>
          <p><strong>Days missed:</strong> {progress.daysMissed}</p>
          <p><strong>Days pending:</strong> {progress.daysPending}</p>
          <p><strong>Completion rate:</strong> {formatPercent(progress.completionRate)}</p>
        </div>
      )}

      {challenge.failReason && (
        <p className="challenge-details__reason"><strong>Failure reason:</strong> {challenge.failReason}</p>
      )}
    </section>
  );
}

export default function Challenges() {
  const { user } = useAuth();

  const [habits, setHabits] = useState<Habit[]>([]);
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedChallenge, setSelectedChallenge] = useState<Challenge | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const [busyActionId, setBusyActionId] = useState<string | null>(null);

  const selectedFromList = useMemo(
    () => challenges.find((item) => item.id === selectedId) ?? null,
    [challenges, selectedId],
  );

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError('');

    try {
      const [habitData, challengeData] = await Promise.all([
        api.get<HabitListResponse>('/habits'),
        api.get<ChallengeListResponse>('/challenges'),
      ]);

      setHabits(habitData?.habits ?? []);
      setChallenges(challengeData?.challenges ?? []);
    } catch (error) {
      setHabits([]);
      setChallenges([]);
      setLoadError(messageFor(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  async function openChallenge(challengeId: string) {
    setSelectedId(challengeId);
    setDetailLoading(true);
    setDetailError('');

    try {
      const data = await api.get<ChallengeResponse>(`/challenges/${challengeId}`);
      setSelectedChallenge(data?.challenge ?? null);
    } catch (error) {
      setSelectedChallenge(null);
      setDetailError(messageFor(error));
    } finally {
      setDetailLoading(false);
    }
  }

  async function createChallenge(values: ChallengeFormValues) {
    setCreating(true);
    setBanner(null);

    try {
      const created = await api.post<ChallengeResponse>('/challenges', toCreatePayload(values));
      setShowCreate(false);
      setBanner({ kind: 'success', text: `Challenge “${created?.challenge?.title ?? values.title.trim()}” created.` });
      await loadAll();
      if (created?.challenge?.id) {
        await openChallenge(created.challenge.id);
      }
    } catch (error) {
      setBanner({ kind: 'error', text: messageFor(error) });
      throw error;
    } finally {
      setCreating(false);
    }
  }

  async function runAction(challenge: Challenge, action: 'commit' | 'evaluate') {
    setBusyActionId(challenge.id);
    setBanner(null);

    try {
      const endpoint = action === 'commit'
        ? `/challenges/${challenge.id}/commit`
        : `/challenges/${challenge.id}/evaluate`;

      await api.post<ChallengeResponse>(endpoint);

      setBanner({
        kind: 'success',
        text: action === 'commit'
          ? `Challenge “${challenge.title}” committed.`
          : `Challenge “${challenge.title}” evaluated.`,
      });

      await loadAll();
      await openChallenge(challenge.id);
    } catch (error) {
      setBanner({ kind: 'error', text: messageFor(error) });
    } finally {
      setBusyActionId(null);
    }
  }

  return (
    <main className="shell">
      <header className="shell__header">
        <h1 className="shell__title">Habitra Challenges</h1>
        <p className="shell__tagline">Commit to a habit challenge and track progress over time.</p>
        {user && <p className="habits__user">Signed in as {user.name}</p>}
      </header>

      {banner && (
        <div className={banner.kind === 'success' ? 'alert alert--success' : 'alert alert--error'}>
          {banner.text}
        </div>
      )}

      <section className="card">
        <div className="habits__section-head">
          <h2 className="card__title">New challenge</h2>
          {!showCreate && (
            <button className="btn btn--primary" type="button" onClick={() => setShowCreate(true)}>
              Create challenge
            </button>
          )}
        </div>

        {showCreate ? (
          <ChallengeForm
            habits={habits}
            onSubmit={createChallenge}
            onCancel={() => {
              if (!creating) {
                setShowCreate(false);
              }
            }}
          />
        ) : (
          <p className="card__text">
            Create a challenge tied to one habit. Start/end dates and miss allowance determine pass/fail.
          </p>
        )}
      </section>

      <section className="card">
        <h2 className="card__title">Your challenges</h2>

        {loading && <p className="habits__muted">Loading challenges…</p>}

        {!loading && loadError && (
          <div className="habits__error">
            <div className="alert alert--error">{loadError}</div>
            <button className="btn btn--primary" type="button" onClick={() => void loadAll()}>
              Try again
            </button>
          </div>
        )}

        {!loading && !loadError && challenges.length === 0 && (
          <p className="habits__muted">You do not have any challenges yet. Create one above to get started.</p>
        )}

        {!loading && !loadError && challenges.length > 0 && (
          <ul className="habits__list">
            {challenges.map((challenge) => {
              const busy = busyActionId === challenge.id;

              return (
                <li className="habit" key={challenge.id}>
                  <ChallengeSummary challenge={challenge} />

                  <div className="challenge-summary__actions">
                    <button
                      className="btn btn--ghost"
                      type="button"
                      disabled={busy}
                      onClick={() => void openChallenge(challenge.id)}
                    >
                      {selectedId === challenge.id ? 'Refresh details' : 'View details'}
                    </button>

                    {challenge.status === 'DRAFT' && (
                      <button
                        className="btn btn--primary"
                        type="button"
                        disabled={busy}
                        onClick={() => void runAction(challenge, 'commit')}
                      >
                        {busy ? 'Committing…' : 'Commit'}
                      </button>
                    )}

                    {challenge.status === 'ACTIVE' && (
                      <button
                        className="btn btn--primary"
                        type="button"
                        disabled={busy}
                        onClick={() => void runAction(challenge, 'evaluate')}
                      >
                        {busy ? 'Evaluating…' : 'Evaluate'}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {selectedId && (
        <>
          {detailLoading && (
            <section className="card"><p className="habits__muted">Loading challenge details…</p></section>
          )}

          {!detailLoading && detailError && (
            <section className="card">
              <div className="alert alert--error">{detailError}</div>
            </section>
          )}

          {!detailLoading && !detailError && (selectedChallenge || selectedFromList) && (
            <ChallengeDetails challenge={selectedChallenge ?? selectedFromList!} />
          )}
        </>
      )}
    </main>
  );
}
