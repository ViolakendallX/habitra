/**
 * virtualsProvider.ts — long-lived ACP v2 SELLER (provider) listener.
 *
 * LAYERING: this is the fulfilment half of the action layer. It does not
 * decide anything, does not read habits, and does not talk to Gemini or Sibyl.
 * It waits for ACP jobs to arrive, prices them, and hands back the deliverable
 * that was already written upstream.
 *
 * WHY A SINGLETON
 * `AcpAgent.start()` opens a Server-Sent-Events stream and `AcpAgent.on()`
 * stores exactly ONE handler (`this.entryHandler = handler` in the SDK — a
 * second `on()` call silently overwrites the first). So the seller agent must
 * be created once, started once, and reused. Creating one per HTTP request
 * would leak SSE connections and lose every event between requests.
 *
 * JOB FLOW (seller side, offering `accountabilityIntervention`)
 *   1. `job.created`  (system)  → provider must respond
 *   2. requirement    (message) → carries `{"habitContext": "..."}`
 *   3. setBudget(0.01 USDC)
 *   4. `job.funded`   (system)  → provider must respond
 *   5. submit(<Gemini-authored intervention text>)
 *   6. skip-evaluation → auto-completes; `job.completed` arrives
 *
 * ORDERING: the SDK posts the requirement as a SEPARATE message AFTER the
 * on-chain job creation (`sendMessage(..., "requirement")` with up to 5
 * retries). The two may therefore arrive in either order relative to what we
 * observe, so both handlers reconcile against `session.entries` and whichever
 * arrives second triggers the budget.
 *
 * FAILURE POLICY — deliberate, and driven by the SDK:
 * The provider's tool matrix in state `funded` is `[submit]` only. A provider
 * CANNOT reject a funded job. So if the deliverable cannot be produced we do
 * NOT submit junk and we do NOT attempt a reject that would throw — we log a
 * reason code and let the job expire, which returns the funds to the client.
 *
 * Secrets: none are read directly here (the agent factory owns that) and none
 * are ever logged. Log lines carry job ids, chain ids and reason codes only.
 */

import type {
  EntryHandler,
  JobRoomEntry,
  JobSession,
} from '@virtuals-protocol/acp-node-v2';

import {
  acpJobBridge,
  extractInterventionMessage,
  getAcpInvalidCredentials,
  getAcpMissingCredentials,
  getAcpRuntimeConfig,
  getAcpSellerAgent,
  loadAcpSdk,
  parseHabitContext,
  resetAcpAgents,
  type AcpAgentFactoryDeps,
  type AcpAgentLike,
  type AcpJobBridge,
  type AcpJobState,
  type AcpRuntimeConfig,
  type AcpSdk,
  type LoadAcpSdk,
} from './virtualsAcp.js';

/** How many finished/in-flight jobs we keep in memory before pruning. */
const DEFAULT_MAX_TRACKED_JOBS = 500;

/** Terminal ACP system events → bridge state. */
const TERMINAL_EVENT_STATE = {
  'job.completed': 'COMPLETED',
  'job.rejected': 'REJECTED',
  'job.expired': 'EXPIRED',
} as const satisfies Record<string, AcpJobState>;

export interface AcpProviderJobRecord {
  jobId: string;
  chainId: number;
  /** The `habitContext` requirement value, once seen. */
  habitContext: string | null;
  budgetSet: boolean;
  submitted: boolean;
  /** Terminal system event type, once observed. */
  terminalEvent: string | null;
  /** Machine-readable reason code for the last thing that went wrong. */
  lastError: string | null;
  seenAt: string;
  updatedAt: string;
}

export interface AcpProviderLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface AcpProviderDependencies {
  getConfig?: () => AcpRuntimeConfig;
  loadSdk?: LoadAcpSdk;
  getSellerAgent?: (
    config: AcpRuntimeConfig,
    deps: AcpAgentFactoryDeps,
  ) => Promise<AcpAgentLike>;
  now?: () => Date;
  logger?: AcpProviderLogger;
  maxTrackedJobs?: number;
  /**
   * Where terminal outcomes are relayed. Defaults to the shared singleton;
   * injectable so tests can observe them without touching Sibyl.
   */
  bridge?: AcpJobBridge;
}

export type AcpProviderStartReason =
  | 'STARTED'
  | 'ALREADY_RUNNING'
  | 'ACP_DISABLED'
  | 'CONFIG_MISSING'
  | 'CONFIG_INVALID'
  | 'START_FAILED';

export interface AcpProviderStartResult {
  ok: boolean;
  started: boolean;
  reason: AcpProviderStartReason;
  /** Offending env variable NAMES, never values. */
  missing?: string[];
  error?: string;
}

export interface AcpProvider {
  start(): Promise<AcpProviderStartResult>;
  stop(): Promise<void>;
  isRunning(): boolean;
  /** The raw entry handler, exposed so offline tests can drive it directly. */
  handleEntry: EntryHandler;
  getJob(jobId: string, chainId?: number): AcpProviderJobRecord | undefined;
  trackedJobCount(): number;
}

function jobKey(chainId: number, jobId: string): string {
  return `${chainId}:${jobId}`;
}

/**
 * Pulls the `habitContext` requirement out of a job room, newest first.
 *
 * Scans `session.entries` rather than trusting the triggering entry, because
 * the requirement message and the `job.created` system event race each other.
 */
export function findRequirement(
  entries: readonly JobRoomEntry[],
  jobId: string,
): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry || entry.kind !== 'message') continue;
    if (entry.onChainJobId !== jobId) continue;
    if (entry.contentType !== 'requirement') continue;

    const parsed = parseHabitContext(entry.content);
    if (parsed) return parsed;
  }
  return null;
}

function describeEntry(entry: JobRoomEntry): string {
  if (!entry) return 'missing-entry';
  if (entry.kind === 'system') {
    return `system:${entry.event?.type ?? 'unknown'}`;
  }
  return `message:${entry.contentType ?? 'unknown'}`;
}

export function createAcpProvider(
  overrides: AcpProviderDependencies = {},
): AcpProvider {
  const deps: Required<
    Pick<AcpProviderDependencies, 'getConfig' | 'loadSdk' | 'getSellerAgent' | 'now' | 'logger'>
  > &
    AcpProviderDependencies = {
    getConfig: getAcpRuntimeConfig,
    loadSdk: loadAcpSdk,
    getSellerAgent: getAcpSellerAgent,
    now: () => new Date(),
    logger: {
      info: (message) => console.info(message),
      warn: (message) => console.warn(message),
    },
    ...overrides,
  };

  const bridge = overrides.bridge ?? acpJobBridge;
  const maxTrackedJobs = overrides.maxTrackedJobs ?? DEFAULT_MAX_TRACKED_JOBS;
  const jobs = new Map<string, AcpProviderJobRecord>();

  let running = false;
  let starting: Promise<AcpProviderStartResult> | null = null;
  let sdk: AcpSdk | null = null;
  let agent: AcpAgentLike | null = null;

  function touch(record: AcpProviderJobRecord): void {
    record.updatedAt = deps.now().toISOString();
  }

  function ensureRecord(chainId: number, jobId: string): AcpProviderJobRecord {
    const key = jobKey(chainId, jobId);
    const existing = jobs.get(key);
    if (existing) return existing;

    const timestamp = deps.now().toISOString();
    const record: AcpProviderJobRecord = {
      jobId,
      chainId,
      habitContext: null,
      budgetSet: false,
      submitted: false,
      terminalEvent: null,
      lastError: null,
      seenAt: timestamp,
      updatedAt: timestamp,
    };
    jobs.set(key, record);

    if (jobs.size > maxTrackedJobs) {
      // Cheap eviction: drop the least recently updated non-terminal job
      // first; if everything is terminal, drop the oldest.
      let victimKey: string | null = null;
      let victimAt = '';
      for (const [candidateKey, candidate] of jobs) {
        if (candidate.terminalEvent) continue;
        if (!victimKey || candidate.updatedAt < victimAt) {
          victimKey = candidateKey;
          victimAt = candidate.updatedAt;
        }
      }
      jobs.delete(victimKey ?? jobs.keys().next().value ?? key);
    }

    return record;
  }

  async function setBudget(session: JobSession, record: AcpProviderJobRecord): Promise<void> {
    if (record.budgetSet) return;
    if (!record.habitContext) return; // Requirement has not arrived yet.
    if (!sdk) return;

    const status = session.status;
    if (status !== 'open' && status !== 'budget_set') return;

    const config = deps.getConfig();
    await session.setBudget(sdk.AssetToken.usdc(config.priceUsd, session.chainId));
    record.budgetSet = true;
    touch(record);
    deps.logger.info(
      `[virtuals:provider] budget set job=${record.jobId} chain=${record.chainId}`,
    );
  }

  async function submit(
    session: JobSession,
    record: AcpProviderJobRecord,
  ): Promise<void> {
    if (record.submitted) return;
    if (session.status !== 'funded') return;

    const message = extractInterventionMessage(record.habitContext);
    if (!message) {
      // No deliverable → do NOT submit junk and do NOT reject (a provider has
      // no reject tool in `funded`). The job expires and refunds the client.
      record.lastError = 'DELIVERABLE_MISSING';
      touch(record);
      deps.logger.warn(
        `[virtuals:provider] no deliverable for job=${record.jobId} chain=${record.chainId}; letting it expire`,
      );
      return;
    }

    await session.submit(message);
    record.submitted = true;
    touch(record);
    deps.logger.info(
      `[virtuals:provider] submitted job=${record.jobId} chain=${record.chainId}`,
    );
  }

  const handleEntry: EntryHandler = async (session, entry) => {
    try {
      if (!entry || typeof entry !== 'object') return;

      const jobId = entry.onChainJobId;
      const chainId = entry.chainId;
      if (typeof jobId !== 'string' || !jobId) return;
      if (typeof chainId !== 'number' || !Number.isFinite(chainId)) return;

      // Ignore anything that is not a recognised entry kind BEFORE tracking it,
      // so junk can never populate (or evict from) the job table.
      if (entry.kind !== 'message' && entry.kind !== 'system') return;

      const record = ensureRecord(chainId, jobId);

      if (entry.kind === 'message') {
        if (entry.contentType === 'requirement') {
          const parsed = parseHabitContext(entry.content);
          if (parsed) {
            record.habitContext = parsed;
            touch(record);
            await setBudget(session, record);
          } else {
            record.lastError = 'REQUIREMENT_UNPARSEABLE';
            touch(record);
          }
        }
        return;
      }

      switch (entry.event?.type) {
        case 'job.created': {
          const found = findRequirement(session.entries, jobId);
          if (found) {
            record.habitContext = found;
            touch(record);
          }
          await setBudget(session, record);
          break;
        }

        case 'job.funded': {
          if (!record.habitContext) {
            const found = findRequirement(session.entries, jobId);
            if (found) {
              record.habitContext = found;
              touch(record);
            }
          }
          await submit(session, record);
          break;
        }

        case 'job.completed':
        case 'job.rejected':
        case 'job.expired': {
          record.terminalEvent = entry.event.type;
          touch(record);

          // Both wallets are Habitra's and the seller is the first to observe
          // the terminal event, so it relays the outcome into the shared
          // in-memory bridge. That is what drives the terminal Sibyl write —
          // without this the buyer would never learn how the job ended.
          bridge.markStateByJobId(
            record.jobId,
            TERMINAL_EVENT_STATE[entry.event.type],
            extractInterventionMessage(record.habitContext),
            deps.now(),
          );

          deps.logger.info(
            `[virtuals:provider] job=${record.jobId} chain=${record.chainId} ${entry.event.type}`,
          );
          break;
        }

        default:
          // budget.set / job.submitted belong to the client and the evaluator.
          break;
      }
    } catch (err) {
      // A bad entry must never take the listener down: the SSE stream stays up
      // and the next job is still served.
      const message = (err as Error)?.message ?? String(err);
      deps.logger.warn(
        `[virtuals:provider] entry handler failed (${describeEntry(entry)}): ${message}`,
      );
    }
  };

  async function begin(): Promise<AcpProviderStartResult> {
    const config = deps.getConfig();

    if (!config.enabled) {
      return { ok: false, started: false, reason: 'ACP_DISABLED' };
    }

    const missing = getAcpMissingCredentials(config);
    if (missing.length > 0) {
      deps.logger.warn(
        `[virtuals:provider] not started; missing config: ${missing.join(', ')}`,
      );
      return { ok: false, started: false, reason: 'CONFIG_MISSING', missing };
    }

    const invalid = getAcpInvalidCredentials(config);
    if (invalid.length > 0) {
      deps.logger.warn(
        `[virtuals:provider] not started; invalid config: ${invalid.join(', ')}`,
      );
      return { ok: false, started: false, reason: 'CONFIG_INVALID', missing: invalid };
    }

    try {
      sdk = await deps.loadSdk();
      agent = await deps.getSellerAgent(config, {});
      agent.on('entry', handleEntry);
      await agent.start();

      running = true;
      deps.logger.info(
        `[virtuals:provider] seller listener started (chain=${config.chainId}, offering=${config.offeringName})`,
      );
      return { ok: true, started: true, reason: 'STARTED' };
    } catch (err) {
      running = false;
      const message = (err as Error)?.message ?? String(err);
      deps.logger.warn(`[virtuals:provider] start failed: ${message}`);
      return { ok: false, started: false, reason: 'START_FAILED', error: message };
    }
  }

  return {
    handleEntry,

    isRunning(): boolean {
      return running;
    },

    trackedJobCount(): number {
      return jobs.size;
    },

    getJob(jobId: string, chainId?: number): AcpProviderJobRecord | undefined {
      if (typeof chainId === 'number') return jobs.get(jobKey(chainId, jobId));
      for (const record of jobs.values()) {
        if (record.jobId === jobId) return record;
      }
      return undefined;
    },

    async start(): Promise<AcpProviderStartResult> {
      if (running) return { ok: true, started: false, reason: 'ALREADY_RUNNING' };
      // Collapse concurrent starts: the SDK keeps ONE handler, so two racing
      // starts would silently unregister the first listener.
      if (starting) return starting;

      starting = begin().finally(() => {
        starting = null;
      });
      return starting;
    },

    async stop(): Promise<void> {
      if (!agent) {
        running = false;
        return;
      }

      try {
        await agent.stop();
      } catch (err) {
        deps.logger.warn(
          `[virtuals:provider] stop failed: ${(err as Error)?.message ?? String(err)}`,
        );
      } finally {
        running = false;
        agent = null;
        // A stopped SSE agent cannot be restarted, so drop the cached agent
        // pair. The buyer is rebuilt lazily on its next use.
        resetAcpAgents();
        deps.logger.info('[virtuals:provider] seller listener stopped');
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

let provider: AcpProvider | null = null;

export function getAcpProvider(): AcpProvider {
  if (!provider) provider = createAcpProvider();
  return provider;
}

/** Test seam: forgets the singleton so a fresh one can be injected. */
export function setAcpProvider(next: AcpProvider | null): void {
  provider = next;
}

export async function startAcpProvider(): Promise<AcpProviderStartResult> {
  return getAcpProvider().start();
}

export async function stopAcpProvider(): Promise<void> {
  if (!provider) return;
  await provider.stop();
}
