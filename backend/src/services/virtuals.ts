/**
 * virtuals.ts — Accountability intervention EXECUTOR.
 *
 * LAYERING (do not blur this):
 *   Gemini  = reasoning layer  — decides WHETHER an intervention is needed.
 *   Sibyl   = memory layer     — remembers what happened.
 *   This    = action layer     — executes an intervention it is told to run.
 *
 * This module NEVER decides whether an intervention should happen. It has no
 * access to habit analytics, no thresholds, no heuristics, and no model. The
 * request type deliberately has no `needed` field: by the time we are called,
 * the decision has already been made. If a caller wants "should I intervene?",
 * that belongs in `services/agent.ts`, not here.
 *
 * Today the only wired-up client is a FAKE one (`createFakeVirtualsClient`), so
 * the service can be exercised end-to-end with no Virtuals account, no wallet,
 * and no network. Swapping in a real ACP adapter later means writing one
 * `InterventionClient` — nothing else in this file changes.
 *
 * Safety properties (mirrors `lib/sibylBridge.ts`):
 *  - Never throws. Every failure path resolves with `ok: false`.
 *  - Hard timeout. A hung provider cannot wedge the caller.
 *  - Untrusted client output is normalised before it leaves this module.
 *  - Nothing is logged except the intervention id and a reason code.
 */

import { z } from 'zod';

import {
  saveRecommendationOutcome,
  type MemoryWriteResult,
  type RecommendationOutcome,
} from './memory.js';

import {
  acpJobBridge,
  buildHabitContext,
  getAcpBuyerAgent,
  getAcpInvalidCredentials,
  getAcpMissingCredentials,
  getAcpRuntimeConfig,
  type AcpAgentFactoryDeps,
  type AcpAgentLike,
  type AcpJobBridge,
  type AcpJobRecord,
  type AcpJobState,
  type AcpRuntimeConfig,
} from './virtualsAcp.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Distinguishes intervention memories from plain agent recommendations inside
 * the shared `recommendation` category. Retrieval needs no new code: the agent
 * already searches that category and will surface these automatically.
 */
export const INTERVENTION_OUTCOME_SOURCE = 'virtuals_intervention_v1';

/** Marks the timeout branch of `Promise.race` unambiguously. */
const TIMEOUT_SENTINEL = Symbol('intervention-timeout');

export const INTERVENTION_KINDS = ['nudge', 'commitment_check', 'escalate'] as const;
export type InterventionKind = (typeof INTERVENTION_KINDS)[number];

/** Statuses meaning "a job actually exists / reached the user". */
const ACTIONED_STATUSES = ['CREATED', 'DELIVERED', 'ACCEPTED', 'DECLINED', 'EXPIRED'] as const;
export type InterventionActionedStatus = (typeof ACTIONED_STATUSES)[number];

/** Statuses meaning "nothing happened". */
export type InterventionInactiveStatus = 'FAILED' | 'SKIPPED';

export type InterventionStatus = InterventionActionedStatus | InterventionInactiveStatus;

/** Which adapter produced the result. Lets a test prove it never hit real infra. */
export type InterventionProvider = 'mock' | 'virtuals';
export type InterventionBackend = 'mock' | 'virtuals_acp_v2';

/**
 * Everything the executor needs to act. Authored upstream by Gemini.
 *
 * `userId` is the Habitra tenant id. It is NOT a message field — treat it as
 * routing/ownership metadata, never as content to publish.
 */
export type InterventionRequest = {
  userId: string;
  /** Idempotency key. A provider must not bill/notify twice for the same id. */
  interventionId: string;
  kind: InterventionKind;
  habitId?: string | null;
  challengeId?: string | null;
  goal: string;
  message: string;
  reason: string;
  context: {
    habitName?: string;
    currentStreak?: number;
    completionRate?: number;
    missedLastDays?: number;
  };
  requestedAt: string;
};

const interventionRequestSchema = z.object({
  userId: z.string().min(1),
  interventionId: z.string().min(1),
  kind: z.enum(INTERVENTION_KINDS),
  habitId: z.string().min(1).nullish(),
  challengeId: z.string().min(1).nullish(),
  goal: z.string().min(1),
  message: z.string().min(1),
  reason: z.string().min(1),
  context: z.object({
    habitName: z.string().optional(),
    currentStreak: z.number().int().nonnegative().optional(),
    completionRate: z.number().min(0).max(100).optional(),
    missedLastDays: z.number().int().nonnegative().optional(),
  }),
  requestedAt: z.string().min(1),
});

export interface InterventionError {
  type: string;
  message: string;
}

export interface InterventionSuccess {
  ok: true;
  interventionId: string;
  status: InterventionActionedStatus;
  provider: InterventionProvider;
  /** Provider-side job id / on-chain reference, once one exists. */
  providerRef?: string;
  deliveredAt?: string;
  response?: string | null;
}

export interface InterventionFailure {
  ok: false;
  interventionId: string;
  status: InterventionInactiveStatus;
  provider: InterventionProvider;
  /** Short machine-readable reason, e.g. `TIMEOUT`. */
  reason: string;
  error?: InterventionError;
}

export type InterventionResult = InterventionSuccess | InterventionFailure;

/**
 * The memory-side record for one executed intervention.
 *
 * This is what gets handed to `saveInterventionOutcome` (DI), which by default
 * funnels it into the existing `saveRecommendationOutcome()` mechanism. It
 * deliberately carries no decision logic — just what happened, so a future
 * Gemini run can read it back.
 */
export interface InterventionOutcome {
  interventionId: string;
  habitId?: string | null;
  challengeId?: string | null;
  kind: InterventionKind;
  goal: string;
  message: string;
  reason: string;
  status: InterventionStatus;
  provider: InterventionProvider;
  /** true when the provider actioned something. */
  ok: boolean;
  /** Short reason code when `ok` is false. */
  failureReason?: string | null;
  /** Set by the action layer so the memory system can separate these from agent recs. */
  source: string;
  /** Human-readable, FTS-searchable record of what was asked and what happened. */
  text: string;
  /** Mechanical mapping of provider state (ACCEPTED/DECLINED/null). Not a decision. */
  accepted: boolean | null;
  /** User-reported usefulness, when known. Carried through to memory, usually null. */
  helpful?: boolean | null;
  recordedAt: string;
}

/** What the action layer needs to persist an outcome. Injected for testing. */
export type SaveInterventionOutcome = (
  userId: string,
  outcome: InterventionOutcome,
) => Promise<MemoryWriteResult>;

/**
 * The single seam between Habitra and any intervention provider.
 *
 * A real ACP adapter implements this and nothing else. It must resolve rather
 * than reject — but the service defends against rejection anyway.
 */
export interface InterventionClient {
  readonly provider: InterventionProvider;
  submit(request: InterventionRequest): Promise<InterventionResult>;
}

export interface VirtualsAcpV2Config {
  enabled: boolean;
  walletAddress: string;
  walletId: string;
  signerPrivateKey: string;
  chain: 'base' | 'baseSepolia';
  builderCode?: string;
  timeoutMs: number;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
}

function parseTimeoutMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function nonEmpty(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * Reads ACP v2 config from env without throwing. Missing required credentials
 * simply mean "not ready" and should keep the runtime on the mock backend.
 */
export function getVirtualsAcpV2Config(): VirtualsAcpV2Config {
  const enabled = parseBoolean(process.env.VIRTUALS_ACP_ENABLED, false);
  const chainRaw = nonEmpty(process.env.VIRTUALS_ACP_CHAIN).toLowerCase();
  const chain: 'base' | 'baseSepolia' = chainRaw === 'base' ? 'base' : 'baseSepolia';

  return {
    enabled,
    walletAddress: nonEmpty(process.env.VIRTUALS_EVM_WALLET_ADDRESS),
    walletId: nonEmpty(process.env.VIRTUALS_EVM_WALLET_ID),
    signerPrivateKey: nonEmpty(process.env.VIRTUALS_EVM_SIGNER_PRIVATE_KEY),
    chain,
    builderCode: nonEmpty(process.env.VIRTUALS_ACP_BUILDER_CODE) || undefined,
    timeoutMs: parseTimeoutMs(process.env.VIRTUALS_ACP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

/** Human-readable list of missing ACP v2 prerequisites (no secret values). */
export function getVirtualsAcpV2MissingConfig(config: VirtualsAcpV2Config): string[] {
  const missing: string[] = [];
  if (!config.walletAddress) missing.push('VIRTUALS_EVM_WALLET_ADDRESS');
  if (!config.walletId) missing.push('VIRTUALS_EVM_WALLET_ID');
  if (!config.signerPrivateKey) missing.push('VIRTUALS_EVM_SIGNER_PRIVATE_KEY');
  return missing;
}

/**
 * The single ACP call that costs money. Split out so offline tests can prove
 * the arguments are correct without ever touching the network.
 *
 * Returns the ACP job id as a string (the SDK returns a `bigint`).
 */
export type AcpCreateJob = (
  agent: AcpAgentLike,
  config: AcpRuntimeConfig,
  requirement: Record<string, unknown>,
) => Promise<string>;

export const defaultCreateJob: AcpCreateJob = async (agent, config, requirement) => {
  const jobId = await agent.createJobByOfferingName(
    config.chainId,
    config.offeringName,
    config.seller.walletAddress,
    requirement,
    // NO evaluatorAddress: this puts the job in SKIP-EVALUATION mode, so the
    // seller's submit() auto-completes it and releases funds. An explicit
    // evaluator would add a manual quality gate we do not want here.
    {},
  );
  return jobId.toString();
};

export interface AcpClientDependencies {
  getConfig?: () => AcpRuntimeConfig;
  getBuyerAgent?: (
    config: AcpRuntimeConfig,
    deps: AcpAgentFactoryDeps,
  ) => Promise<AcpAgentLike>;
  createJob?: AcpCreateJob;
  bridge?: AcpJobBridge;
  now?: () => Date;
}

/**
 * Real ACP v2 buyer client.
 *
 * Creates ONE paid job per `interventionId` against the registered Habitra
 * offering, then returns immediately. It deliberately does NOT wait for the
 * 30-minute SLA: completion arrives later as an event and is recorded then.
 *
 * Every refusal path below fails fast and offline — no SDK load, no RPC, no
 * transaction — so a misconfiguration can never turn into a spend.
 */
export function createVirtualsAcpV2Client(
  config: VirtualsAcpV2Config,
  deps: AcpClientDependencies = {},
): InterventionClient {
  const bridge = deps.bridge ?? acpJobBridge;

  return {
    provider: 'virtuals',
    async submit(request: InterventionRequest): Promise<InterventionResult> {
      if (!config.enabled) {
        return failure('virtuals', request.interventionId, 'SKIPPED', 'VIRTUALS_ACP_DISABLED');
      }

      const sellerMissing = getVirtualsAcpV2MissingConfig(config);
      if (sellerMissing.length > 0) {
        return failure('virtuals', request.interventionId, 'FAILED', 'VIRTUALS_ACP_CONFIG_MISSING', {
          type: 'ConfigurationError',
          message: `Missing ACP v2 config: ${sellerMissing.join(', ')}`,
        });
      }

      // Read the runtime config lazily so env changes after module load apply.
      const acp = deps.getConfig ? deps.getConfig() : getAcpRuntimeConfig();

      const missing = getAcpMissingCredentials(acp);
      if (missing.length > 0) {
        return failure(
          'virtuals',
          request.interventionId,
          'FAILED',
          'VIRTUALS_ACP_BUYER_CONFIG_MISSING',
          {
            type: 'ConfigurationError',
            message: `Missing ACP v2 participant config: ${missing.join(', ')}`,
          },
        );
      }

      // Refuse to send structurally wrong credentials to the registry — e.g. a
      // wallet-address field that actually holds the signer key.
      const invalid = getAcpInvalidCredentials(acp);
      if (invalid.length > 0) {
        return failure(
          'virtuals',
          request.interventionId,
          'FAILED',
          'VIRTUALS_ACP_CONFIG_INVALID',
          {
            type: 'ConfigurationError',
            message: `Invalid ACP v2 credentials: ${invalid.join(', ')}`,
          },
        );
      }

      // IDEMPOTENCY: interventionId is the key. A retry never bills twice — it
      // gets the existing job id back instead.
      const reservation = bridge.reserve(request, deps.now ? deps.now() : new Date());
      if (!reservation.allowed) {
        const success: InterventionSuccess = {
          ok: true,
          interventionId: request.interventionId,
          status: 'CREATED',
          provider: 'virtuals',
          response: null,
        };
        if (reservation.record.jobId) success.providerRef = reservation.record.jobId;
        return success;
      }

      try {
        const habitContext = buildHabitContext(request);
        const agent = deps.getBuyerAgent
          ? await deps.getBuyerAgent(acp, {})
          : await getAcpBuyerAgent(acp, {});

        const createJob = deps.createJob ?? defaultCreateJob;
        const jobId = await createJob(agent, acp, { habitContext });

        bridge.markCreated(request.interventionId, jobId, acp.chainId, deps.now ? deps.now() : new Date());

        return {
          ok: true,
          interventionId: request.interventionId,
          // The job EXISTS on chain. Delivery happens later, out of band.
          status: 'CREATED',
          provider: 'virtuals',
          providerRef: jobId,
          deliveredAt: (deps.now ? deps.now() : new Date()).toISOString(),
          response: null,
        };
      } catch (err) {
        bridge.markFailed(
          request.interventionId,
          'ACP_JOB_CREATE_FAILED',
          deps.now ? deps.now() : new Date(),
        );

        return failure(
          'virtuals',
          request.interventionId,
          'FAILED',
          'VIRTUALS_ACP_JOB_FAILED',
          {
            type: 'AcpJobError',
            message: (err as Error)?.message ?? String(err),
          },
        );
      }
    },
  };
}

export interface InterventionRuntimeSelection {
  backend: InterventionBackend;
  reason: string;
  config: VirtualsAcpV2Config;
}

export function selectInterventionBackend(): InterventionRuntimeSelection {
  const config = getVirtualsAcpV2Config();
  const providerHint = nonEmpty(process.env.VIRTUALS_ACP_PROVIDER).toLowerCase();

  if (!config.enabled) {
    return {
      backend: 'mock',
      reason: 'VIRTUALS_ACP_ENABLED is not true; using mock client.',
      config,
    };
  }

  if (providerHint && providerHint !== 'virtuals_acp_v2') {
    return {
      backend: 'mock',
      reason: `VIRTUALS_ACP_PROVIDER=${providerHint} is unsupported; expected virtuals_acp_v2. Using mock client.`,
      config,
    };
  }

  const missing = getVirtualsAcpV2MissingConfig(config);
  if (missing.length > 0) {
    return {
      backend: 'mock',
      reason: `ACP v2 selected but missing config (${missing.join(', ')}); using mock client.`,
      config,
    };
  }

  // ACP v2 needs TWO participants: the registered seller AND a separate buyer
  // wallet. Half a topology cannot execute, so degrade to mock rather than
  // accepting interventions that would fail (or worse, half-run).
  const acp = getAcpRuntimeConfig();
  const participantsMissing = getAcpMissingCredentials(acp);
  if (participantsMissing.length > 0) {
    return {
      backend: 'mock',
      reason: `ACP v2 selected but missing participant credentials (${participantsMissing.join(', ')}); using mock client.`,
      config,
    };
  }

  // Never hand structurally wrong credentials to the Virtuals registry. A
  // wallet-address field containing a signer key would leak a secret; anything
  // else wrong would just fail. Either way: degrade, do not send.
  const invalid = getAcpInvalidCredentials(acp);
  if (invalid.length > 0) {
    return {
      backend: 'mock',
      reason: `ACP v2 selected but invalid credentials (${invalid.join(', ')}); using mock client.`,
      config,
    };
  }

  return {
    backend: 'virtuals_acp_v2',
    reason: 'ACP v2 selected with seller + buyer credentials present and structurally valid.',
    config,
  };
}

function failure(
  provider: InterventionProvider,
  interventionId: string,
  status: InterventionInactiveStatus,
  reason: string,
  error?: InterventionError,
): InterventionFailure {
  const result: InterventionFailure = { ok: false, interventionId, status, provider, reason };
  if (error) result.error = error;
  return result;
}

function isActionedStatus(value: unknown): value is InterventionActionedStatus {
  return typeof value === 'string' && (ACTIONED_STATUSES as readonly string[]).includes(value);
}

function isInactiveStatus(value: unknown): value is InterventionInactiveStatus {
  return value === 'FAILED' || value === 'SKIPPED';
}

/**
 * Normalise whatever a client handed back.
 *
 * A provider adapter is untrusted code as far as Habitra is concerned: a bad
 * status string or a missing `ok` must not leak into callers as a half-built
 * object, so anything unexpected becomes an explicit failure.
 */
function normalizeResult(
  raw: unknown,
  request: InterventionRequest,
  provider: InterventionProvider,
): InterventionResult {
  if (!raw || typeof raw !== 'object') {
    return failure(provider, request.interventionId, 'FAILED', 'MALFORMED_CLIENT_RESULT', {
      type: 'MalformedResult',
      message: 'Client did not return an object.',
    });
  }

  const candidate = raw as Record<string, unknown>;

  if (candidate.ok === true) {
    if (!isActionedStatus(candidate.status)) {
      return failure(provider, request.interventionId, 'FAILED', 'MALFORMED_CLIENT_RESULT', {
        type: 'MalformedResult',
        message: `Unknown success status: ${String(candidate.status)}`,
      });
    }

    const success: InterventionSuccess = {
      ok: true,
      interventionId:
        typeof candidate.interventionId === 'string' && candidate.interventionId
          ? candidate.interventionId
          : request.interventionId,
      status: candidate.status,
      provider: candidate.provider === 'virtuals' || candidate.provider === 'mock'
        ? candidate.provider
        : provider,
    };

    if (typeof candidate.providerRef === 'string') success.providerRef = candidate.providerRef;
    if (typeof candidate.deliveredAt === 'string') success.deliveredAt = candidate.deliveredAt;
    if (candidate.response === null || typeof candidate.response === 'string') {
      success.response = candidate.response as string | null;
    }

    return success;
  }

  const status = isInactiveStatus(candidate.status) ? candidate.status : 'FAILED';
  const result = failure(
    provider,
    request.interventionId,
    status,
    typeof candidate.reason === 'string' && candidate.reason ? candidate.reason : 'UNKNOWN',
  );

  const rawError = candidate.error;
  if (rawError && typeof rawError === 'object') {
    const err = rawError as Record<string, unknown>;
    result.error = {
      type: typeof err.type === 'string' ? err.type : 'UnknownError',
      message: typeof err.message === 'string' ? err.message : 'No error message supplied.',
    };
  }

  return result;
}

/**
 * Fake provider used until real Virtuals ACP is wired up.
 *
 * Performs no network I/O and needs no credentials. Keeps a record of every
 * request so tests can assert on what *would* have been sent.
 */
export interface FakeVirtualsClientOptions {
  /** Custom responder. Omit to get a default `CREATED` success. */
  respond?: (request: InterventionRequest) => InterventionResult | Promise<InterventionResult>;
  /** Simulate a transport-level rejection. */
  failWith?: string;
  /** Simulate latency (useful for exercising the timeout). */
  delayMs?: number;
}

export interface FakeVirtualsClient extends InterventionClient {
  /** Every request received, in order. */
  readonly calls: InterventionRequest[];
  reset(): void;
}

export function createFakeVirtualsClient(
  options: FakeVirtualsClientOptions = {},
): FakeVirtualsClient {
  const calls: InterventionRequest[] = [];

  return {
    provider: 'mock',
    calls,
    reset(): void {
      calls.length = 0;
    },
    async submit(request: InterventionRequest): Promise<InterventionResult> {
      calls.push(request);

      if (options.delayMs && options.delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, options.delayMs));
      }

      if (options.failWith) {
        throw new Error(options.failWith);
      }

      if (options.respond) {
        return options.respond(request);
      }

      return {
        ok: true,
        interventionId: request.interventionId,
        status: 'CREATED',
        provider: 'mock',
        providerRef: `mock:${request.interventionId}`,
        response: null,
      };
    },
  };
}

/**
 * Persist an executed intervention's outcome to Sibyl, fire-and-forget.
 *
 * Mirrors the agent's `saveRecommendationOutcome` call: a memory outage must
 * never break the intervention response, so the write is swallowed either way.
 */
function recordOutcome(
  deps: InterventionServiceDependencies,
  request: InterventionRequest,
  result: InterventionResult,
): void {
  const outcome: InterventionOutcome = {
    interventionId: request.interventionId,
    habitId: request.habitId ?? null,
    challengeId: request.challengeId ?? null,
    kind: request.kind,
    goal: request.goal,
    message: request.message,
    reason: request.reason,
    status: result.status,
    provider: result.provider,
    ok: result.ok,
    failureReason: result.ok ? null : result.reason,
    source: INTERVENTION_OUTCOME_SOURCE,
    text: [
      `[intervention:${request.kind}] ${request.message}`,
      `Reason: ${request.reason}`,
      `Outcome: ${result.status} (${result.provider})`,
    ].join('\n'),
    // Mechanical mapping of provider state into a memory flag; not a decision.
    accepted: result.status === 'ACCEPTED' ? true : result.status === 'DECLINED' ? false : null,
    helpful: null,
    recordedAt: deps.now().toISOString(),
  };

  void deps.saveInterventionOutcome(request.userId, outcome)
    .then((write) => {
      if (!write.ok) {
        console.warn('[virtuals] intervention outcome memory write failed');
      }
    })
    .catch(() => {
      console.warn('[virtuals] intervention outcome memory write threw unexpectedly');
    });
}

export interface InterventionServiceDependencies {
  client: InterventionClient;
  /** When false, everything is SKIPPED without touching the client. */
  enabled: boolean;
  timeoutMs: number;
  now: () => Date;
  /**
   * Persists the outcome. Defaults to the existing Sibyl recommendation-outcome
   * channel (`saveRecommendationOutcome`) with a distinct `source`. The action
   * layer only ever CALLS this — it never decides what to write.
   */
  saveInterventionOutcome: SaveInterventionOutcome;
}

/**
 * Default outcome persistence: a thin adapter that forwards the already-shaped
 * `InterventionOutcome` into the existing recommendation-outcome mechanism, so
 * the agent's context builder (which already searches that category) can later
 * surface it. No new Sibyl category, no new table. The record itself is built
 * in `recordOutcome`, not here — this is a dumb pass-through.
 */
const defaultSaveInterventionOutcome: SaveInterventionOutcome = async (userId, outcome) =>
  saveRecommendationOutcome(userId, {
    recommendationId: outcome.interventionId,
    habitId: outcome.habitId ?? null,
    accepted: outcome.accepted,
    helpful: outcome.helpful ?? null,
    text: outcome.text,
    source: outcome.source,
  } satisfies RecommendationOutcome);

/** Mechanical mapping of ACP terminal state → the intervention status vocabulary. */
export function acpStateToInterventionStatus(state: AcpJobState): InterventionStatus {
  switch (state) {
    case 'COMPLETED':
      return 'ACCEPTED';
    case 'REJECTED':
      return 'DECLINED';
    case 'EXPIRED':
      return 'EXPIRED';
    default:
      return 'FAILED';
  }
}

/**
 * Builds the memory record for a job that has reached a terminal ACP state.
 *
 * Sibyl's `set_entity` upserts by name, and the name here is the
 * `interventionId` — so this UPDATES the memory written when the job was
 * created rather than adding a second one. That is the "Learn" half of the
 * loop: the record goes from `CREATED` to whatever actually happened.
 */
export function buildTerminalOutcome(
  record: AcpJobRecord,
  now: Date = new Date(),
): InterventionOutcome {
  const request = record.request;
  const status = acpStateToInterventionStatus(record.state);

  return {
    interventionId: request.interventionId,
    habitId: request.habitId ?? null,
    challengeId: request.challengeId ?? null,
    kind: request.kind,
    goal: request.goal,
    message: request.message,
    reason: request.reason,
    status,
    provider: 'virtuals',
    ok: status !== 'FAILED',
    failureReason: record.failureReason,
    source: INTERVENTION_OUTCOME_SOURCE,
    text: [
      `[intervention:${request.kind}] ${request.message}`,
      `Reason: ${request.reason}`,
      `Outcome: ${status} (virtuals, ACP job ${record.jobId ?? 'unknown'})`,
      record.failureReason ? `Failure: ${record.failureReason}` : '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
    accepted: status === 'ACCEPTED' ? true : status === 'DECLINED' ? false : null,
    helpful: null,
    recordedAt: now.toISOString(),
  };
}

/**
 * Closes the loop: ACP terminal state → Sibyl.
 *
 * The buyer returns as soon as the job exists; minutes later the seller's
 * listener observes `job.completed` / `job.rejected` / `job.expired` and
 * relays it into the shared in-memory bridge. This listener is what turns that
 * into a memory. Fire-and-forget by design: a Sibyl outage must never break
 * the transport.
 */
acpJobBridge.onTerminal((record) => {
  void defaultSaveInterventionOutcome(record.request.userId, buildTerminalOutcome(record))
    .then((write) => {
      if (!write.ok) {
        console.warn('[virtuals] terminal intervention outcome memory write failed');
      }
    })
    .catch(() => {
      console.warn('[virtuals] terminal intervention outcome memory write threw unexpectedly');
    });
});

const runtimeSelection = selectInterventionBackend();

if (runtimeSelection.backend === 'mock') {
  console.info(`[virtuals] using mock intervention backend: ${runtimeSelection.reason}`);
} else {
  console.info('[virtuals] using virtuals ACP v2 intervention backend (boundary mode).');
}

const defaultClient: InterventionClient =
  runtimeSelection.backend === 'virtuals_acp_v2'
    ? createVirtualsAcpV2Client(runtimeSelection.config)
    : createFakeVirtualsClient();

/**
 * Creating a real ACP job is an on-chain transaction through a sponsored RPC,
 * not a 10-second API call. The service-level timeout therefore switches to the
 * dedicated job-creation budget when ACP is live, so a legitimate job is not
 * killed by the short mock-era timeout.
 */
const acpRuntime = getAcpRuntimeConfig();

const defaultDependencies: InterventionServiceDependencies = {
  // Mock remains the default unless ACP v2 is explicitly enabled + configured.
  client: defaultClient,
  enabled: true,
  timeoutMs:
    runtimeSelection.backend === 'virtuals_acp_v2'
      ? acpRuntime.jobCreateTimeoutMs
      : runtimeSelection.config.timeoutMs,
  now: () => new Date(),
  saveInterventionOutcome: defaultSaveInterventionOutcome,
};

/**
 * Dispatches one already-decided intervention.
 *
 * Never throws and never decides. Returns `ok: true` only when the provider
 * actually accepted/created a job.
 */
export function createInterventionService(
  overrides: Partial<InterventionServiceDependencies> = {},
) {
  const deps: InterventionServiceDependencies = { ...defaultDependencies, ...overrides };

  return {
    async requestIntervention(request: InterventionRequest): Promise<InterventionResult> {
      let result: InterventionResult;
      // Non-null only when we actually dispatched to the client. Invalid input
      // and disabled mode never reach the client, so must never be remembered.
      let dispatchedRequest: InterventionRequest | null = null;

      try {
        const parsed = interventionRequestSchema.safeParse(request);

        if (!parsed.success) {
          const id =
            request && typeof request.interventionId === 'string' && request.interventionId
              ? request.interventionId
              : 'unknown';
          result = failure(deps.client.provider, id, 'FAILED', 'INVALID_REQUEST', {
            type: 'ValidationError',
            message: parsed.error.issues
              .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
              .join('; '),
          });
        } else if (!deps.enabled) {
          result = failure(
            deps.client.provider,
            parsed.data.interventionId,
            'SKIPPED',
            'INTERVENTIONS_DISABLED',
          );
        } else {
          dispatchedRequest = parsed.data;
          result = await dispatch(dispatchedRequest, deps);
        }
      } catch (err) {
        // Belt and braces: no caller should ever have to try/catch us.
        result = failure(deps.client.provider, request?.interventionId ?? 'unknown', 'FAILED', 'UNEXPECTED', {
          type: 'UnexpectedError',
          message: (err as Error)?.message ?? String(err),
        });
      }

      if (dispatchedRequest) {
        recordOutcome(deps, dispatchedRequest, result);
      }

      if (!result.ok) {
        // Deliberately minimal: never log message/reason content.
        console.warn(
          `[virtuals] intervention ${result.interventionId} ${result.status}: ${result.reason}`,
        );
      }

      return result;
    },
  };
}

async function dispatch(
  request: InterventionRequest,
  deps: InterventionServiceDependencies,
): Promise<InterventionResult> {
  let timer: NodeJS.Timeout | undefined;

  try {
    const timeout = new Promise<symbol>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), deps.timeoutMs);
    });

    const settled = await Promise.race([deps.client.submit(request), timeout]);

    if (settled === TIMEOUT_SENTINEL) {
      return failure(deps.client.provider, request.interventionId, 'FAILED', 'TIMEOUT', {
        type: 'TimeoutError',
        message: `Intervention client did not respond within ${deps.timeoutMs}ms.`,
      });
    }

    return normalizeResult(settled, request, deps.client.provider);
  } catch (err) {
    return failure(deps.client.provider, request.interventionId, 'FAILED', 'TRANSPORT_ERROR', {
      type: 'ClientError',
      message: (err as Error)?.message ?? String(err),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Default instance. Backed by the fake client until a real adapter is added. */
export const interventionService = createInterventionService();
