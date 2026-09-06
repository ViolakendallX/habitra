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

/** Structured recommendation payload returned by GET /api/agent/recommendation. */
export interface AgentRecommendation {
  message: string;
  recommendation: string;
  reason: string;
  memoryUsed: boolean;
  generatedAt: string;
}

export interface AgentRecommendationResponse {
  recommendation: AgentRecommendation;
}
