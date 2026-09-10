import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Address } from 'viem';

import { api, isApiError } from '../lib/http';
import { useAuth } from '../context/AuthContext';
import type {
  BlockchainStatus,
  Challenge,
  ChallengeEscrowResponse,
  ChallengeEscrowState,
  ChallengeListResponse,
  ChallengeResponse,
  ChallengeStatus,
  CreateChallengeInput,
  Habit,
  HabitListResponse,
  StakeEscrowResponse,
  WalletResponse,
} from '../lib/types';
import { formatBeesAmount, readBeesBalance } from '../lib/wallet/bees';
import {
  getInjectedProvider,
  getWalletChainId,
  isBaseSepolia,
  isInjectedWalletAvailable,
  readAuthorizedAccounts,
  requestWalletAccounts,
} from '../lib/wallet/injectedWallet';
import {
  DEFAULT_STAKE_BASE_UNITS,
  DEFAULT_STAKE_BASE_UNITS_TEXT,
  DEFAULT_STAKE_LABEL,
  approveBees,
  lockStake,
  readBeesAllowance,
} from '../lib/wallet/stake';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

/** EIP-1193 "user rejected the request". */
const USER_REJECTED_CODE = 4001;

/** Base Sepolia — the only chain Habitra stakes on. */
const BASE_SEPOLIA_CHAIN_ID = 84532;

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

/** `0x1234abcd…5678` — enough to recognise an address or hash, short enough to fit. */
function shortHex(value: string): string {
  if (value.length <= 14) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** Case-insensitive address comparison: EIP-55 checksums differ in case only. */
function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

/** Unix seconds of an ISO date string, or null when it cannot be parsed. */
function toUnixSeconds(value: string): number | null {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

/**
 * Turn any thrown value into something a user can act on.
 *
 * A rejected wallet prompt (4001) is the common case and must not read like a
 * crash; viem's `shortMessage` carries the decoded revert reason.
 */
function stakeErrorMessage(error: unknown): string {
  if (isApiError(error)) return error.message;

  const code = (error as { code?: number } | null)?.code;
  if (code === USER_REJECTED_CODE) {
    return 'You rejected the transaction in your wallet. Nothing was sent and no BEES moved.';
  }

  const short = (error as { shortMessage?: string } | null)?.shortMessage;
  if (short) return short;

  if (error instanceof Error && error.message) return error.message;

  return 'Something went wrong while staking BEES. Please try again.';
}

type StakePhase =
  | 'idle'
  | 'preparing'
  | 'approving'
  | 'locking'
  | 'confirming'
  | 'confirmed'
  | 'failed';

interface StakeProgress {
  phase: StakePhase;
  approvalTxHash: string | null;
  lockTxHash: string | null;
  /** True once the lock transaction was actually handed to the wallet. */
  lockAttempted: boolean;
  message: string;
}

const IDLE_PROGRESS: StakeProgress = {
  phase: 'idle',
  approvalTxHash: null,
  lockTxHash: null,
  lockAttempted: false,
  message: '',
};

type StepState = 'pending' | 'active' | 'done' | 'failed';

function stepStateClass(state: StepState): string {
  return `stake-step stake-step--${state}`;
}

function stepStateLabel(state: StepState): string {
  if (state === 'done') return 'Done';
  if (state === 'active') return 'In progress';
  if (state === 'failed') return 'Failed';
  return 'Not started';
}

interface StakeBeesPanelProps {
  challenge: Challenge;
  escrow: ChallengeEscrowState | null;
  account: Address | null;
  busy: boolean;
  progress: StakeProgress;
  error: string | null;
  onStake: () => void;
}

/**
 * The real BEES staking panel.
 *
 * It only renders what actually happened: each step's state comes from the
 * progress object the page fills in as transactions are signed, so an approval
 * that succeeded while the lock failed is shown as exactly that — never as a
 * completed stake.
 */
function StakeBeesPanel({
  challenge,
  escrow,
  account,
  busy,
  progress,
  error,
  onStake,
}: StakeBeesPanelProps) {
  const closed = challenge.status === 'COMPLETED'
    || challenge.status === 'FAILED'
    || challenge.status === 'ARCHIVED';

  const alreadyStaked = Boolean(escrow?.stake);
  const confirmed = progress.phase === 'confirmed';

  // Only steps that were actually attempted are allowed to read as failed —
  // a pre-flight rejection (wrong network, insufficient BEES) must not paint
  // the lock red when nothing was ever sent.
  const approvalState: StepState = progress.approvalTxHash
    ? 'done'
    : progress.phase === 'approving'
      ? 'active'
      : progress.phase === 'failed' && progress.lockAttempted
        ? 'failed'
        : 'pending';

  const lockState: StepState = progress.lockTxHash
    ? 'done'
    : progress.phase === 'locking'
      ? 'active'
      : progress.phase === 'failed' && progress.lockAttempted
        ? 'failed'
        : 'pending';

  const confirmState: StepState = confirmed
    ? 'done'
    : progress.phase === 'confirming'
      ? 'active'
      : progress.phase === 'failed' && progress.lockTxHash
        ? 'failed'
        : 'pending';

  return (
    <section className="card stake-panel">
      <h2 className="card__title">Stake BEES</h2>

      <p className="card__text">
        Lock {DEFAULT_STAKE_LABEL} in the Habitra escrow for the length of this challenge. You sign
        two transactions in your own wallet — an approval and the lock. Habitra never sees your
        private key.
      </p>

      <dl className="stake-panel__facts">
        <div>
          <dt>Wallet</dt>
          <dd>{account ? shortHex(account) : 'Not connected'}</dd>
        </div>
        <div>
          <dt>Stake</dt>
          <dd>{DEFAULT_STAKE_LABEL}</dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>Base Sepolia ({BASE_SEPOLIA_CHAIN_ID})</dd>
        </div>
        <div>
          <dt>Lock until</dt>
          <dd>{formatDate(challenge.endDate)}</dd>
        </div>
      </dl>

      <ol className="stake-steps">
        <li className={stepStateClass(approvalState)}>
          <span className="stake-step__label">Approve BEES</span>
          <span className="stake-step__state">{stepStateLabel(approvalState)}</span>
          {progress.approvalTxHash && (
            <span className="stake-panel__hash">{shortHex(progress.approvalTxHash)}</span>
          )}
        </li>
        <li className={stepStateClass(lockState)}>
          <span className="stake-step__label">Lock in escrow</span>
          <span className="stake-step__state">{stepStateLabel(lockState)}</span>
          {progress.lockTxHash && (
            <span className="stake-panel__hash">{shortHex(progress.lockTxHash)}</span>
          )}
        </li>
        <li className={stepStateClass(confirmState)}>
          <span className="stake-step__label">Confirmed on-chain</span>
          <span className="stake-step__state">{stepStateLabel(confirmState)}</span>
        </li>
      </ol>

      {confirmed && (
        <div className="alert alert--success">
          {DEFAULT_STAKE_LABEL} staked and confirmed on Base Sepolia.
        </div>
      )}

      {alreadyStaked && !confirmed && (
        <p className="habits__muted">
          A stake is already recorded for this challenge
          {escrow?.stake?.status ? ` (${escrow.stake.status})` : ''}.
        </p>
      )}

      {progress.message && !error && (
        <p className="habits__muted">{progress.message}</p>
      )}

      {error && <div className="alert alert--error">{error}</div>}

      <div className="challenge-summary__actions">
        <button
          className="btn btn--primary"
          type="button"
          disabled={busy || closed || alreadyStaked}
          onClick={onStake}
        >
          {busy ? 'Staking…' : `Stake ${DEFAULT_STAKE_LABEL}`}
        </button>
      </div>

      {closed && (
        <p className="habits__muted">This challenge is closed, so no further stake can be locked.</p>
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

  // --- Phase 3: real BEES staking -----------------------------------------
  const [browserAccount, setBrowserAccount] = useState<Address | null>(null);
  const [escrowState, setEscrowState] = useState<ChallengeEscrowState | null>(null);
  const [staking, setStaking] = useState(false);
  const [stakeProgress, setStakeProgress] = useState<StakeProgress>(IDLE_PROGRESS);
  const [stakeError, setStakeError] = useState<string | null>(null);

  /** Guards against a second click landing while transactions are pending. */
  const stakeInFlight = useRef(false);

  const selectedFromList = useMemo(
    () => challenges.find((item) => item.id === selectedId) ?? null,
    [challenges, selectedId],
  );

  // Reflect an already-authorised wallet on load, and follow account switches.
  useEffect(() => {
    let cancelled = false;

    void readAuthorizedAccounts().then((accounts) => {
      if (!cancelled) setBrowserAccount(accounts[0] ?? null);
    });

    const provider = getInjectedProvider();
    const onAccountsChanged = (...args: unknown[]) => {
      const next = Array.isArray(args[0]) ? args[0][0] : undefined;
      setBrowserAccount(typeof next === 'string' ? (next as Address) : null);
    };

    provider?.on?.('accountsChanged', onAccountsChanged);

    return () => {
      cancelled = true;
      provider?.removeListener?.('accountsChanged', onAccountsChanged);
    };
  }, []);

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

  const refreshEscrow = useCallback(async (challengeId: string) => {
    try {
      const data = await api.get<ChallengeEscrowResponse>(`/challenges/${challengeId}/escrow`);
      setEscrowState(data?.escrow ?? null);
    } catch {
      setEscrowState(null);
    }
  }, []);

  async function openChallenge(challengeId: string) {
    setSelectedId(challengeId);
    setDetailLoading(true);
    setDetailError('');
    setStakeProgress(IDLE_PROGRESS);
    setStakeError(null);

    try {
      const data = await api.get<ChallengeResponse>(`/challenges/${challengeId}`);
      setSelectedChallenge(data?.challenge ?? null);
    } catch (error) {
      setSelectedChallenge(null);
      setDetailError(messageFor(error));
    } finally {
      setDetailLoading(false);
    }

    await refreshEscrow(challengeId);
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

  /**
   * The real BEES staking flow: approve -> lock -> backend confirmation.
   *
   * Every on-chain write is signed by the user's own wallet; the backend only
   * supplies the call descriptor and then re-verifies the resulting hash
   * on-chain. `approvalTxHash` / `lockTxHash` are tracked locally so a partial
   * failure can be reported honestly instead of as a completed stake.
   */
  async function stakeBees(challenge: Challenge) {
    if (stakeInFlight.current) return;
    stakeInFlight.current = true;

    setStaking(true);
    setStakeError(null);
    setBanner(null);

    let approvalTxHash: string | null = null;
    let lockTxHash: string | null = null;
    let lockAttempted = false;

    const fail = (message: string) => {
      setStakeProgress({ phase: 'failed', approvalTxHash, lockTxHash, lockAttempted, message });
      setStakeError(message);
      setBanner({ kind: 'error', text: message });
    };

    try {
      setStakeProgress({
        phase: 'preparing',
        approvalTxHash: null,
        lockTxHash: null,
        lockAttempted: false,
        message: 'Checking your wallet…',
      });

      // --- 1. Wallet, network and ownership -------------------------------
      if (!isInjectedWalletAvailable()) {
        fail('No browser wallet detected. Install a wallet such as MetaMask to stake BEES.');
        return;
      }

      const accounts = await requestWalletAccounts();
      const account = accounts[0];
      if (!account) {
        fail('No account was selected. Choose an account in your wallet and try again.');
        return;
      }
      setBrowserAccount(account);

      const chainId = await getWalletChainId();
      if (!isBaseSepolia(chainId)) {
        fail(
          `Your wallet is on chain ${chainId ?? 'unknown'}. Switch it to Base Sepolia `
          + `(${BASE_SEPOLIA_CHAIN_ID}) in your wallet, then try again.`,
        );
        return;
      }

      const [walletData, status] = await Promise.all([
        api.get<WalletResponse>('/wallet'),
        api.get<BlockchainStatus>('/blockchain/status'),
      ]);

      const linked = walletData?.wallet ?? null;
      if (!linked) {
        fail('No wallet is linked to this Habitra account. Link your wallet on the Wallet page first.');
        return;
      }

      if (!sameAddress(linked.address, account)) {
        fail(
          `Your browser wallet ${shortHex(account)} is not the wallet linked to this account `
          + `(${shortHex(linked.address)}). Switch accounts in your wallet, or update the linked `
          + 'address on the Wallet page.',
        );
        return;
      }

      // --- 2. Configuration and balance ------------------------------------
      const tokenAddress = status?.beesTokenAddress ?? null;
      const escrowAddress = status?.challengeContractAddress ?? null;

      if (!tokenAddress || !escrowAddress) {
        fail('The BEES token or escrow contract is not configured on the server, so BEES cannot be staked.');
        return;
      }

      if (status?.mode !== 'live') {
        fail(
          `On-chain staking is unavailable: the backend is running in "${status?.mode ?? 'unknown'}" mode.`,
        );
        return;
      }

      const balance = await readBeesBalance(tokenAddress, account);
      if (balance < DEFAULT_STAKE_BASE_UNITS) {
        fail(
          `Insufficient BEES: your balance is ${formatBeesAmount(balance)} BEES and this challenge `
          + `requires ${DEFAULT_STAKE_LABEL}.`,
        );
        return;
      }

      const endsAt = toUnixSeconds(challenge.endDate);
      if (endsAt === null) {
        fail('This challenge has no valid end date, so the stake cannot be locked.');
        return;
      }

      // --- 3. Ask the backend for the lock to sign -------------------------
      setStakeProgress({
        phase: 'preparing',
        approvalTxHash: null,
        lockTxHash: null,
        lockAttempted: false,
        message: 'Requesting the stake lock from Habitra…',
      });

      const stakeResponse = await api.post<StakeEscrowResponse>(
        `/challenges/${challenge.id}/stake`,
        { amount: DEFAULT_STAKE_BASE_UNITS_TEXT },
      );

      const result = stakeResponse?.escrow ?? null;
      if (!result) {
        fail('The server did not return a stake lock to sign.');
        return;
      }

      const descriptor = result.contractCall;
      if (!descriptor) {
        // Nothing to sign: a stake already exists for this challenge.
        setStakeProgress({
          phase: 'confirmed',
          approvalTxHash: null,
          lockTxHash: result.txHash,
          lockAttempted: false,
          message: result.message || 'A stake is already recorded for this challenge.',
        });
        setBanner({ kind: 'success', text: result.message || 'A stake is already recorded.' });
        await refreshEscrow(challenge.id);
        return;
      }

      if (descriptor.functionName !== 'lock') {
        fail('The server asked for an unexpected contract call. Nothing was sent.');
        return;
      }

      if (!sameAddress(descriptor.address, escrowAddress)) {
        fail(
          'The escrow address from the server does not match the deployed escrow. '
          + 'Nothing was sent, so no BEES moved.',
        );
        return;
      }

      // --- 4. Approve ------------------------------------------------------
      const allowance = await readBeesAllowance(tokenAddress, account, escrowAddress);

      if (allowance >= DEFAULT_STAKE_BASE_UNITS) {
        setStakeProgress({
          phase: 'approving',
          approvalTxHash: null,
          lockTxHash: null,
          lockAttempted: false,
          message: 'An existing BEES approval covers this stake, so no approval is needed.',
        });
      } else {
        setStakeProgress({
          phase: 'approving',
          approvalTxHash: null,
          lockTxHash: null,
          lockAttempted: false,
          message: `Approve ${DEFAULT_STAKE_LABEL} in your wallet…`,
        });

        approvalTxHash = await approveBees({
          tokenAddress,
          spender: escrowAddress,
          account,
          amount: DEFAULT_STAKE_BASE_UNITS,
        });

        setStakeProgress({
          phase: 'approving',
          approvalTxHash,
          lockTxHash: null,
          lockAttempted: false,
          message: 'BEES approval confirmed. Locking your stake…',
        });
      }

      // --- 5. Lock ---------------------------------------------------------
      lockAttempted = true;

      setStakeProgress({
        phase: 'locking',
        approvalTxHash,
        lockTxHash: null,
        lockAttempted: true,
        message: 'Confirm the stake lock in your wallet…',
      });

      lockTxHash = await lockStake({
        escrowAddress,
        account,
        challengeId: challenge.id,
        amount: DEFAULT_STAKE_BASE_UNITS,
        endsAt,
      });

      // --- 6. Backend verification ----------------------------------------
      setStakeProgress({
        phase: 'confirming',
        approvalTxHash,
        lockTxHash,
        lockAttempted: true,
        message: 'Lock sent. Habitra is verifying the transaction on-chain…',
      });

      const confirmation = await api.post<StakeEscrowResponse>(
        `/challenges/${challenge.id}/escrow/confirm`,
        { txHash: lockTxHash },
      );

      const finalHash = confirmation?.escrow?.txHash ?? lockTxHash;

      setStakeProgress({
        phase: 'confirmed',
        approvalTxHash,
        lockTxHash: finalHash,
        lockAttempted: true,
        message: 'Stake locked and confirmed on-chain.',
      });
      setBanner({
        kind: 'success',
        text: `${DEFAULT_STAKE_LABEL} staked and confirmed on Base Sepolia.`,
      });

      await refreshEscrow(challenge.id);
    } catch (error) {
      const detail = stakeErrorMessage(error);

      if (lockTxHash) {
        // The lock really happened; only the reconciliation failed.
        fail(
          `Your lock transaction was sent (${shortHex(lockTxHash)}) but Habitra could not confirm `
          + `it. ${detail} Your BEES may already be locked on-chain — do not send a second lock. `
          + 'Reload this challenge to retry the confirmation.',
        );
      } else if (approvalTxHash) {
        // Requirement 10: approval succeeded, lock did not. Never claim success.
        fail(
          `Your BEES approval succeeded (${shortHex(approvalTxHash)}) but the stake was NOT `
          + `locked. ${detail} No BEES left your wallet — try again and the approval will be reused.`,
        );
      } else {
        fail(detail);
      }
    } finally {
      stakeInFlight.current = false;
      setStaking(false);
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

                    {challenge.status !== 'COMPLETED'
                      && challenge.status !== 'FAILED'
                      && challenge.status !== 'ARCHIVED' && (
                      <button
                        className="btn btn--ghost"
                        type="button"
                        disabled={busy || staking}
                        onClick={() => void openChallenge(challenge.id)}
                      >
                        Stake BEES
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
            <>
              <ChallengeDetails challenge={selectedChallenge ?? selectedFromList!} />
              <StakeBeesPanel
                challenge={selectedChallenge ?? selectedFromList!}
                escrow={escrowState}
                account={browserAccount}
                busy={staking}
                progress={stakeProgress}
                error={stakeError}
                onStake={() => void stakeBees(selectedChallenge ?? selectedFromList!)}
              />
            </>
          )}
        </>
      )}
    </main>
  );
}
