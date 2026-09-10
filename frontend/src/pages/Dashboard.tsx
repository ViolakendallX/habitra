import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';

import { NETWORK_ERROR_STATUS, api, isApiError } from '../lib/http';
import { useAuth } from '../context/AuthContext';
import { useNotifications } from '../context/NotificationContext';
import StatTile from '../components/StatTile';
import WeekHeatmap from '../components/WeekHeatmap';
import type {
  AgentRecommendation,
  AgentRecommendationResponse,
  AnalyticsResponse,
  BlockchainStatus,
  Challenge,
  ChallengeEscrowResponse,
  ChallengeEscrowState,
  ChallengeListResponse,
  CompletionListResponse,
  CompletionStatus,
  Habit,
  HabitAnalytics,
  HabitListResponse,
  UserAnalytics,
  Wallet,
  WalletResponse,
} from '../lib/types';

/**
 * Dashboard — the at-a-glance home screen.
 *
 * It is strictly a READ-ONLY view over endpoints that already exist:
 *   GET /api/habits                                -> My Habits + week status
 *   GET /api/habits/:id/completions?from&to        -> per-day completion state
 *   GET /api/analytics                             -> streaks / completion rate
 *   GET /api/challenges                            -> active challenge
 *   GET /api/challenges/:id/escrow                 -> staked BEES for it
 *   GET /api/wallet, GET /api/blockchain/status    -> BEES / wallet section
 *   GET /api/agent/recommendation                  -> AI accountability insight
 *
 * No new backend surface, no writes, and no session handling here: lib/http.ts
 * attaches the cookie and useAuth() supplies the public profile. The agent
 * endpoint is only called on demand (it generates a recommendation), so simply
 * opening the dashboard never triggers a model call.
 *
 * Calendar days are UTC-normalised, exactly like the backend and the Habits
 * page, so "today" here always matches what the API stores and returns.
 */

/** Base Sepolia. Mirrors the backend's DEFAULT_CHAIN_ID. */
const DEFAULT_CHAIN_ID = 84532;

/** BEES is an 18-decimal ERC-20; amounts arrive as base-unit strings. */
const BEES_BASE_UNITS = 10n ** 18n;

/** habitId -> (YYYY-MM-DD -> status) for the current week. */
type WeekStatus = Record<string, Record<string, CompletionStatus>>;

function todayUtcKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Monday-to-Sunday keys of the week containing `dayKey` (ISO week). */
function weekDaysFor(dayKey: string): string[] {
  const today = new Date(`${dayKey}T00:00:00.000Z`);
  const daysSinceMonday = (today.getUTCDay() + 6) % 7;
  const monday = new Date(today);
  monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);

  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(monday);
    day.setUTCDate(monday.getUTCDate() + index);
    return day.toISOString().slice(0, 10);
  });
}

function dayParts(dayKey: string): { weekday: string; day: number; month: string } {
  const parsed = new Date(`${dayKey}T00:00:00.000Z`);
  return {
    weekday: parsed.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
    day: parsed.getUTCDate(),
    month: parsed.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
  };
}

function formatLongDate(dayKey: string): string {
  const parsed = new Date(dayKey);
  if (Number.isNaN(parsed.getTime())) return dayKey;
  return parsed.toLocaleDateString('en-US', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatWhen(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function formatShortDate(value: string): string {
  return value.slice(0, 10);
}

function formatPercent(value: number): string {
  return `${value.toFixed(0)}%`;
}

function greetingFor(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function chainName(chainId: number): string {
  if (chainId === DEFAULT_CHAIN_ID) return 'Base Sepolia';
  return `Chain ${chainId}`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Base units -> BEES, exactly (BigInt, so no float drift) and trimmed to at
 * most 4 decimals. Returns null when the backend has no amount yet.
 */
function formatBees(baseUnits: string | null): string | null {
  if (!baseUnits || !/^\d+$/.test(baseUnits)) return null;

  const value = BigInt(baseUnits);
  const whole = value / BEES_BASE_UNITS;
  const fraction = value % BEES_BASE_UNITS;

  if (fraction === 0n) return whole.toString();

  const trimmed = fraction.toString().padStart(18, '0').replace(/0+$/, '').slice(0, 4);
  return `${whole}.${trimmed}`;
}

function messageFor(error: unknown): string {
  if (!isApiError(error)) return 'Something went wrong. Please try again.';

  if (error.status === NETWORK_ERROR_STATUS) {
    return 'Unable to reach the server. Check your connection and try again.';
  }

  if (error.status === 401) {
    return 'Your session has expired. Please sign in again.';
  }

  return error.message || 'Something went wrong. Please try again.';
}

/** Never let one optional section take the whole dashboard down. */
async function optional<T>(path: string): Promise<T | null> {
  try {
    return await api.get<T>(path);
  } catch {
    return null;
  }
}

function frequencyLabel(habit: Habit): string {
  return habit.frequency === 'DAILY' ? 'Daily' : 'Weekly';
}

function statusBadgeClass(status: Challenge['status']): string {
  if (status === 'COMPLETED') return 'badge badge--ok';
  if (status === 'FAILED' || status === 'ARCHIVED') return 'badge badge--miss';
  return 'badge';
}

function pickFocusChallenge(challenges: Challenge[]): Challenge | null {
  const active = challenges.find((item) => item.status === 'ACTIVE');
  if (active) return active;

  return (
    [...challenges].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
  );
}

function analyticsFor(analytics: UserAnalytics | null, habitId: string): HabitAnalytics | null {
  return analytics?.habits?.find((item) => item.habitId === habitId) ?? null;
}

type ProgressProps = { value: number };

/** Linear bar, clamped to 0–100 so a stale/odd rate can never overflow. */
function ProgressBar({ value }: ProgressProps) {
  const clamped = Math.min(100, Math.max(0, value));

  return (
    <div
      className="progress-bar"
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="progress-bar__fill" style={{ width: `${clamped}%` }} />
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const { registerAgentRecommendation } = useNotifications();

  const today = useMemo(todayUtcKey, []);
  const week = useMemo(() => weekDaysFor(today), [today]);
  const [selectedDay, setSelectedDay] = useState(today);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [habits, setHabits] = useState<Habit[]>([]);
  const [analytics, setAnalytics] = useState<UserAnalytics | null>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [escrow, setEscrow] = useState<ChallengeEscrowState | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [chain, setChain] = useState<BlockchainStatus | null>(null);
  const [weekStatus, setWeekStatus] = useState<WeekStatus>({});

  const [insight, setInsight] = useState<AgentRecommendation | null>(null);
  const [insightLoading, setInsightLoading] = useState(false);
  const [insightError, setInsightError] = useState('');

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setLoadError('');

    try {
      const from = week[0];
      const to = week[week.length - 1];

      // One round trip: nothing here depends on the others, so the week's
      // completion history is fetched alongside the summary endpoints.
      const [habitData, analyticsData, challengeData, walletData, chainData] =
        await Promise.all([
          api.get<HabitListResponse>('/habits'),
          optional<AnalyticsResponse>('/analytics'),
          optional<ChallengeListResponse>('/challenges'),
          optional<WalletResponse>('/wallet'),
          optional<BlockchainStatus>('/blockchain/status'),
        ]);

      const list = habitData?.habits ?? [];
      setHabits(list);
      setAnalytics(analyticsData?.analytics ?? null);
      setWallet(walletData?.wallet ?? null);
      setChain(chainData ?? null);

      const focus = pickFocusChallenge(challengeData?.challenges ?? []);
      setChallenge(focus);

      const [weekEntries, escrowData] = await Promise.all([
        Promise.all(
          list.map(async (habit) => {
            const data = await optional<CompletionListResponse>(
              `/habits/${habit.id}/completions?from=${from}&to=${to}`,
            );

            const byDay: Record<string, CompletionStatus> = {};
            for (const completion of data?.completions ?? []) {
              byDay[completion.date.slice(0, 10)] = completion.status;
            }

            return [habit.id, byDay] as const;
          }),
        ),
        focus ? optional<ChallengeEscrowResponse>(`/challenges/${focus.id}/escrow`) : null,
      ]);

      setWeekStatus(Object.fromEntries(weekEntries));
      setEscrow(escrowData?.escrow ?? null);
    } catch (error) {
      setHabits([]);
      setWeekStatus({});
      setLoadError(messageFor(error));
    } finally {
      setLoading(false);
    }
  }, [week]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  async function loadInsight() {
    setInsightLoading(true);
    setInsightError('');

    try {
      const data = await api.get<AgentRecommendationResponse>('/agent/recommendation');
      const next = data?.recommendation ?? null;

      if (!next) {
        setInsightError('Habitra returned an incomplete recommendation. Please try again.');
        return;
      }

      setInsight(next);
      // Reuses the response already in hand; does not trigger another call.
      registerAgentRecommendation(next);
    } catch (error) {
      if (isApiError(error) && error.status === 503) {
        setInsightError('The agent is not configured yet.');
        return;
      }
      setInsightError(messageFor(error));
    } finally {
      setInsightLoading(false);
    }
  }

  /** Today's tally — always today, independent of the week selector. */
  const todayCompleted = habits.filter((habit) => weekStatus[habit.id]?.[today] === 'COMPLETED');
  const todayTotal = habits.length;
  const todayPercent = todayTotal === 0 ? 0 : (todayCompleted.length / todayTotal) * 100;

  /** Per-day tally for the week strip. */
  const dayTally = useMemo(
    () =>
      week.map((day) => {
        const completed = habits.filter(
          (habit) => weekStatus[habit.id]?.[day] === 'COMPLETED',
        ).length;
        const missed = habits.filter(
          (habit) => weekStatus[habit.id]?.[day] === 'MISSED',
        ).length;
        return { day, completed, missed, total: habits.length };
      }),
    [week, habits, weekStatus],
  );

  const selectedIsToday = selectedDay === today;
  const challengeProgress = challenge?.progress ?? null;
  const stakeAmount = formatBees(escrow?.stake?.amount ?? null);

  return (
    <main className="shell shell--dashboard">
      <header className="dashboard__header">
        <div>
          <h1 className="shell__title">
            {greetingFor(new Date().getHours())}
            {user ? `, ${user.name}` : ''}
          </h1>
          <p className="shell__tagline">
            {formatLongDate(today)} · {todayCompleted.length} of {todayTotal} habit
            {todayTotal === 1 ? '' : 's'} done
          </p>
        </div>

        <div className="dashboard__actions">
          <Link className="btn" to="/habits">
            Habits
          </Link>
          <Link className="btn" to="/challenges">
            Challenges
          </Link>
          <Link className="btn" to="/agent">
            Agent
          </Link>
          <Link className="btn" to="/wallet">
            Wallet
          </Link>
        </div>
      </header>

      {loadError && (
        <div className="habits__error">
          <div className="alert alert--error">{loadError}</div>
          <button className="btn btn--primary" type="button" onClick={() => void loadDashboard()}>
            Try again
          </button>
        </div>
      )}

      <div className="dashboard__stack">
        {/* At-a-glance stats. Consistency = the backend's completion rate
            (PRD "consistency score"); no fabricated metric is shown. */}
        <section className="stat-grid" aria-label="Your progress at a glance">
          <StatTile
            label="Consistency"
            value={analytics ? formatPercent(analytics.overall.completionRate) : '—'}
            sub="from your habit data"
            accent
          />
          <StatTile
            label="Current streak"
            value={analytics ? String(analytics.overall.currentStreak) : '—'}
            sub="days"
          />
          <StatTile
            label="Today"
            value={`${todayCompleted.length}/${todayTotal}`}
            sub="habits done"
          />
          <StatTile
            label="Best streak"
            value={analytics ? String(analytics.overall.bestStreak) : '—'}
            sub="days"
          />
        </section>

        <div className="dashboard__main">
          <div className="dashboard__col">
            <section className="card">
              <h2 className="card__title">Today&apos;s progress</h2>

              {loading && <p className="habits__muted">Loading your day…</p>}

              {!loading && (
                <div className="today">
                  <div
                    className="progress-ring"
                    style={{ '--progress': todayPercent } as CSSProperties}
                    role="progressbar"
                    aria-valuenow={Math.round(todayPercent)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Habits completed today"
                  >
                    <span className="progress-ring__inner">{formatPercent(todayPercent)}</span>
                  </div>

                  <div className="today__detail">
                    <p className="today__count">
                      <strong>{todayCompleted.length}</strong> of {todayTotal} completed
                    </p>
                    <p className="habits__muted">
                      {todayTotal === 0
                        ? 'No active habits yet — add one from the Habits page to start a streak.'
                        : todayCompleted.length === todayTotal
                          ? 'Everything is done for today. Nice.'
                          : `${todayTotal - todayCompleted.length} still open today.`}
                    </p>

                    {analytics && (
                      <p className="habits__muted">
                        Current streak {analytics.overall.currentStreak} day
                        {analytics.overall.currentStreak === 1 ? '' : 's'} · best{' '}
                        {analytics.overall.bestStreak} · {formatPercent(analytics.overall.completionRate)}{' '}
                        completion rate
                      </p>
                    )}

                    <Link className="btn btn--primary" to="/habits">
                      Review today&apos;s habits
                    </Link>
                  </div>
                </div>
              )}
            </section>

            <section className="card">
              <div className="habits__section-head">
                <h2 className="card__title">This week</h2>
                <span className="habits__muted">
                  {formatShortDate(week[0])} – {formatShortDate(week[week.length - 1])}
                </span>
              </div>

              <WeekHeatmap
                week={week}
                dayTally={dayTally}
                selectedDay={selectedDay}
                today={today}
                dayParts={dayParts}
                onSelectDay={setSelectedDay}
              />

              <p className="habits__muted">
                {selectedIsToday
                  ? 'Showing today.'
                  : `Showing ${formatLongDate(selectedDay)}. Today stays highlighted.`}
              </p>
            </section>

            <section className="card">
              <div className="habits__section-head">
                <h2 className="card__title">My habits</h2>
                <Link className="btn btn--ghost" to="/habits">
                  Manage habits
                </Link>
              </div>

              {loading && <p className="habits__muted">Loading your habits…</p>}

              {!loading && habits.length === 0 && (
                <p className="habits__muted">
                  You have no active habits yet. Add your first one on the Habits page.
                </p>
              )}

              {!loading && habits.length > 0 && (
                <div className="habit-grid">
                  {habits.map((habit) => {
                    const status = weekStatus[habit.id]?.[selectedDay] ?? null;
                    const stats = analyticsFor(analytics, habit.id);

                    return (
                      <article className="habit-card" key={habit.id}>
                        <div className="habit-card__head">
                          <h3 className="habit__name">{habit.name}</h3>
                          <span className="habit__frequency">
                            {frequencyLabel(habit)} · target {habit.target}
                          </span>
                        </div>

                        {habit.description && (
                          <p className="habit-card__description">{habit.description}</p>
                        )}

                        <p className="habit-card__state">
                          {status === 'COMPLETED' && (
                            <span className="badge badge--ok">
                              Completed {selectedIsToday ? 'today' : formatShortDate(selectedDay)}
                            </span>
                          )}
                          {status === 'MISSED' && (
                            <span className="badge badge--miss">
                              Missed {selectedIsToday ? 'today' : formatShortDate(selectedDay)}
                            </span>
                          )}
                          {!status && <span className="badge">Not recorded yet</span>}
                        </p>

                        <div className="habit-card__stats">
                          <span>
                            Streak: {stats ? `${stats.currentStreak} day${stats.currentStreak === 1 ? '' : 's'}` : '—'}
                          </span>
                          <span>Best: {stats ? `${stats.bestStreak} day${stats.bestStreak === 1 ? '' : 's'}` : '—'}</span>
                          <span>Rate: {stats ? formatPercent(stats.completionRate) : '—'}</span>
                          {habit.preferredTime && <span>Usual time: {habit.preferredTime}</span>}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          </div>

          <div className="dashboard__col">
            <section className="card">
              <h2 className="card__title">Active challenge</h2>

              {loading && <p className="habits__muted">Loading your challenge…</p>}

              {!loading && !challenge && (
                <>
                  <p className="habits__muted">
                    No challenge yet. Commit to one habit and let Habitra keep score.
                  </p>
                  <Link className="btn btn--primary" to="/challenges">
                    Open challenges
                  </Link>
                </>
              )}

              {!loading && challenge && (
                <div className="challenge-summary">
                  <div className="challenge-summary__header">
                    <h3 className="challenge-summary__title">{challenge.title}</h3>
                    <span className={statusBadgeClass(challenge.status)}>{challenge.status}</span>
                  </div>

                  <ProgressBar value={challengeProgress?.completionRate ?? 0} />

                  <p className="challenge-summary__meta">
                    {formatShortDate(challenge.startDate)} → {formatShortDate(challenge.endDate)} ·{' '}
                    {challenge.durationDays} day{challenge.durationDays === 1 ? '' : 's'}
                  </p>

                  {challengeProgress ? (
                    <div className="challenge-summary__stats">
                      <span>Completed: {challengeProgress.daysCompleted}</span>
                      <span>Missed: {challengeProgress.daysMissed}</span>
                      <span>Pending: {challengeProgress.daysPending}</span>
                      <span>Allowance: {challengeProgress.remainingMissAllowance}</span>
                      <span>Elapsed: {challengeProgress.daysElapsed}/{challengeProgress.daysTotal}</span>
                    </div>
                  ) : (
                    <p className="habits__muted">Progress is not available for this challenge yet.</p>
                  )}

                  {challengeProgress?.linkedHabit && (
                    <p className="habits__muted">Habit: {challengeProgress.linkedHabit.name}</p>
                  )}

                  {challenge.failReason && (
                    <p className="challenge-summary__reason">Failure reason: {challenge.failReason}</p>
                  )}

                  <Link className="btn btn--ghost" to="/challenges">
                    Open challenge details
                  </Link>
                </div>
              )}
            </section>

            <section className="card">
              <h2 className="card__title">BEES</h2>

              {loading && <p className="habits__muted">Loading stake information…</p>}

              {!loading && !challenge && (
                <p className="habits__muted">
                  Stake appears here once you commit to a challenge.
                </p>
              )}

              {!loading && challenge && (
                <div className="bees">
                  <p className="bees__amount">
                    {stakeAmount ? `${stakeAmount} BEES staked` : 'No stake locked yet'}
                  </p>

                  {escrow?.stake && (
                    <p className="bees__status">
                      <span
                        className={
                          escrow.stake.status === 'CONFIRMED' ? 'badge badge--ok' : 'badge'
                        }
                      >
                        {escrow.stake.status}
                      </span>
                      <span className="habits__muted">
                        {escrow.stake.simulated ? 'Simulated' : 'On-chain'} ·{' '}
                        {escrow.settled ? 'settled' : 'not settled'}
                      </span>
                    </p>
                  )}

                  <div className="bees__rows">
                    <p>
                      <strong>Wallet:</strong>{' '}
                      {wallet ? shortAddress(wallet.address) : 'not linked'}
                    </p>
                    <p>
                      <strong>Chain:</strong>{' '}
                      {chainName(wallet?.chainId ?? chain?.defaultChainId ?? DEFAULT_CHAIN_ID)}
                    </p>
                    {chain && (
                      <p>
                        <strong>Mode:</strong> {chain.mode}
                      </p>
                    )}
                  </div>

                  <p className="habits__muted">
                    BEES balances are not exposed by the backend yet — only staked
                    amounts recorded for your challenges are shown here.
                  </p>

                  <Link className="btn btn--ghost" to="/wallet">
                    Open wallet
                  </Link>
                </div>
              )}
            </section>

            <section className="card">
              <div className="habits__section-head">
                <h2 className="card__title">AI accountability</h2>
                <Link className="btn btn--ghost" to="/agent">
                  Open agent
                </Link>
              </div>

              {!insight && (
                <p className="card__text">
                  Habitra can read your recent habit data and what it remembers about
                  you, then suggest the next best action.
                </p>
              )}

              <button
                className="btn btn--primary"
                type="button"
                onClick={() => void loadInsight()}
                disabled={insightLoading}
              >
                {insightLoading ? 'Habitra is thinking…' : 'Get latest insight'}
              </button>

              {insightError && <div className="alert alert--error">{insightError}</div>}

              {insight && (
                <article className="insight">
                  <p className="insight__text">{insight.message}</p>

                  <div className="insight__row">
                    <h3 className="agent-result__label">Recommendation</h3>
                    <p className="agent-result__text">{insight.recommendation}</p>
                  </div>

                  <div className="insight__row">
                    <h3 className="agent-result__label">Reason</h3>
                    <p className="agent-result__text">{insight.reason}</p>
                  </div>

                  <div className="agent-result__meta">
                    <span className={`badge ${insight.memoryUsed ? 'badge--ok' : 'badge--miss'}`}>
                      {insight.memoryUsed ? 'Memory used' : 'Memory not used'}
                    </span>
                    <span className="agent-result__memory-note">
                      {insight.memoryUsed
                        ? 'Informed by what Habitra remembers about your recent behavior.'
                        : 'Based on your current habit data only — no remembered context this time.'}
                    </span>
                  </div>

                  <p className="agent-result__time">Generated: {formatWhen(insight.generatedAt)}</p>
                </article>
              )}
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
