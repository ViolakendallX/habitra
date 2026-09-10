/**
 * Shared API types for the Habitra frontend.
 *
 * These mirror the public payloads the backend actually returns (its Prisma
 * `select` allowlists), so the two stay in step. Two rules apply throughout:
 *
 * 1. Dates are `string`. Express serialises Prisma's `DateTime` values as JSON
 *    strings, so a `Date` here would be a lie — call `new Date(value)` where a
 *    real Date is needed.
 * 2. Only fields the backend exposes appear here. `passwordHash`, reset tokens
 *    and JWTs are never part of any response and so have no type.
 */

/** Prisma's `Habit.frequency`, which is a plain String column. */
export type HabitFrequency = 'DAILY' | 'WEEKLY';

/**
 * Prisma's `Habit.status`. ARCHIVED is a soft delete: the row and its whole
 * completion history are kept, it is just hidden from `GET /api/habits`.
 */
export type HabitStatus = 'ACTIVE' | 'ARCHIVED';

/** Prisma's `HabitCompletion.status`. */
export type CompletionStatus = 'COMPLETED' | 'MISSED';

/** The safe User shape returned by /api/auth (register, login, me). */
export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

/** A habit as returned by every /api/habits route. */
export interface Habit {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  frequency: HabitFrequency;
  target: number;
  /** 24-hour `HH:mm`, or null. */
  preferredTime: string | null;
  status: HabitStatus;
  createdAt: string;
  updatedAt: string;
}

/** One completion/miss record. `date` is an ISO string at UTC midnight. */
export interface HabitCompletion {
  id: string;
  habitId: string;
  userId: string;
  date: string;
  status: CompletionStatus;
  missReason: string | null;
  createdAt: string;
}

/** Body for POST /api/habits. */
export interface CreateHabitInput {
  name: string;
  description?: string | null;
  frequency: HabitFrequency;
  target: number;
  preferredTime?: string | null;
}

/**
 * Body for PATCH /api/habits/:habitId. Every field is optional; sending `null`
 * for `description` or `preferredTime` clears it, and omitting a field leaves it
 * alone. At least one field must be supplied.
 */
export interface UpdateHabitInput {
  name?: string;
  description?: string | null;
  frequency?: HabitFrequency;
  target?: number;
  preferredTime?: string | null;
  status?: HabitStatus;
}

/** Body for POST /api/habits/:habitId/completions. */
export interface CreateCompletionInput {
  /** `YYYY-MM-DD`. */
  date: string;
  status: CompletionStatus;
  /** Only allowed when status is MISSED. */
  missReason?: string;
}

export interface HabitAnalytics {
  habitId: string;
  name: string;
  completionRate: number;
  currentStreak: number;
  bestStreak: number;
  totalCompleted: number;
  totalMissed: number;
  totalTracked: number;
}

export interface AnalyticsDateRange {
  from: string | null;
  to: string | null;
}

/** Payload of GET /api/analytics. */
export interface UserAnalytics {
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
}

export type ChallengeStatus = 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'ARCHIVED';

export interface ChallengeLinkedHabit {
  habitId: string;
  name: string;
  status: HabitStatus;
}

export interface ChallengeProgress {
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

export interface Challenge {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  status: ChallengeStatus;
  startDate: string;
  endDate: string;
  durationDays: number;
  maxMisses: number;
  committedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  failReason: string | null;
  createdAt: string;
  updatedAt: string;
  linkedHabit: ChallengeLinkedHabit | null;
  progress: ChallengeProgress | null;
}

export interface CreateChallengeInput {
  title: string;
  description?: string | null;
  startDate: string;
  endDate: string;
  maxMisses?: number;
  habitId: string;
}

/** Success envelope used by the data-returning routes. */
export interface ApiEnvelope<TData> {
  status: 'success';
  data: TData;
  message?: string;
}

/**
 * Success envelope used by routes that only report a message (logout,
 * forgot-password, reset-password).
 */
export interface ApiMessageEnvelope {
  status: 'success';
  message: string;
}

/** Error envelope, returned with a 4xx/5xx status. */
export interface ApiErrorBody {
  status: 'error';
  message: string;
  /** Present on 400s: Zod's `fieldErrors`, field name -> list of messages. */
  errors?: Record<string, string[]>;
}

export interface UserResponse {
  user: User;
}

export interface HabitResponse {
  habit: Habit;
}

export interface HabitListResponse {
  habits: Habit[];
}

export interface CompletionResponse {
  completion: HabitCompletion;
}

export interface CompletionListResponse {
  completions: HabitCompletion[];
}

export interface AnalyticsResponse {
  analytics: UserAnalytics;
}

export interface ChallengeResponse {
  challenge: Challenge;
}

export interface ChallengeListResponse {
  challenges: Challenge[];
}

/** The kinds of accountability action the agent may ask for. */
export type AgentInterventionKind = 'nudge' | 'commitment_check' | 'escalate';

/** The agent's intervention decision, mirroring the backend's zod schema. */
export interface AgentIntervention {
  needed: boolean;
  kind: AgentInterventionKind;
  reason: string;
}

/**
 * Structured recommendation payload returned by GET /api/agent/recommendation.
 *
 * `intervention` is always present and is `null` when the agent decided no
 * outreach was warranted. `recommendationId` identifies the stored
 * recommendation memory so an outcome can be recorded later.
 */
export interface AgentRecommendation {
  message: string;
  recommendation: string;
  reason: string;
  memoryUsed: boolean;
  generatedAt: string;
  recommendationId: string;
  intervention: AgentIntervention | null;
}

export interface AgentRecommendationResponse {
  recommendation: AgentRecommendation;
}

/**
 * Backend `blockchainPersistence` WalletRecord.
 *
 * Only a *public* address is ever stored or returned — the Prisma Wallet model
 * has no private-key/seed/secret field, and neither does this type.
 */
export interface Wallet {
  id: string;
  userId: string;
  address: string;
  chainId: number;
  createdAt: string;
  updatedAt: string;
}

/** Payload of GET /api/wallet. `wallet` is null when nothing is connected. */
export interface WalletResponse {
  wallet: Wallet | null;
}

/** Body for POST /api/wallet. chainId defaults to Base Sepolia (84532). */
export interface ConnectWalletInput {
  address: string;
  chainId?: number;
}

/**
 * Data of GET /api/blockchain/status — public configuration only, never
 * secrets. `defaultChainId`/`supportedChainIds` come from the route; the rest
 * from the backend's getBlockchainStatus().
 */
/**
 * Payload of GET /api/challenges/:challengeId/escrow.
 *
 * Mirrors the backend's ChallengeEscrowState. Amounts are BEES base units
 * (18 decimals) kept as strings because they can exceed Number's safe range.
 * A stake with `simulated: true` was never broadcast — no transaction exists.
 */
export interface EscrowStakeTransaction {
  transactionId: string;
  amount: string | null;
  status: string;
  simulated: boolean;
  createdAt: string;
}

export interface EscrowSettlementTransaction {
  transactionId: string;
  type: 'CLAIM' | 'PENALTY';
  status: string;
  simulated: boolean;
  txHash: string | null;
  createdAt: string;
}

export interface ChallengeEscrowState {
  challengeId: string;
  status: string;
  mode: 'demo' | 'live' | 'unconfigured';
  wallet: { id: string; address: string; chainId: number } | null;
  stake: EscrowStakeTransaction | null;
  settlement: EscrowSettlementTransaction | null;
  settled: boolean;
  simulated: boolean;
}

export interface ChallengeEscrowResponse {
  escrow: ChallengeEscrowState;
}

export interface BlockchainStatus {
  mode: 'demo' | 'live' | 'unconfigured';
  chainId: number;
  rpcUrl: string | null;
  beesTokenAddress: string | null;
  challengeContractAddress: string | null;
  faucetAddress: string | null;
  note: string;
  defaultChainId: number;
  supportedChainIds: number[];
}

/**
 * The call descriptor the backend hands back when the user — not the backend —
 * must sign an escrow write. Mirrors the backend's `EscrowContractCall`.
 */
export interface EscrowContractCall {
  address: string;
  functionName: 'lock' | 'settle';
  args: Array<string | number | boolean>;
  note: string;
}

/**
 * Payload of POST /api/challenges/:challengeId/stake and
 * POST /api/challenges/:challengeId/escrow/confirm.
 *
 * Mirrors the backend's `EscrowResult`. The frontend never interprets this to
 * decide a verdict — it only reads `contractCall` to build the user-signed
 * transaction and `txHash` to display what was confirmed on-chain.
 */
export interface StakeEscrowResult {
  ok: boolean;
  mode: string;
  simulated: boolean;
  challengeId: string;
  duplicate: boolean;
  txHash: string | null;
  commitmentId: string | null;
  contractCall: EscrowContractCall | null;
  code: string;
  message: string;
}

export interface StakeEscrowResponse {
  escrow: StakeEscrowResult;
}
