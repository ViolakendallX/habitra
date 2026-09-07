/**
 * virtualsAcp.ts — Virtuals ACP v2 transport for the intervention action layer.
 *
 * LAYERING (unchanged, do not blur):
 *   Gemini  = reasoning — decides WHETHER an intervention is needed.
 *   Sibyl   = memory    — remembers what happened.
 *   This    = transport — moves an ALREADY-DECIDED intervention across ACP v2.
 *
 * Nothing here inspects habits, analytics or memories to decide anything. The
 * intervention text it carries was authored upstream by Gemini; this module only
 * encodes it, ships it, and tracks what the ACP job did.
 *
 * TOPOLOGY (two participants, verified requirement of ACP v2 — see the package
 * README: "The buyer and seller must use different wallets"):
 *   seller = the registered Habitra agent, which owns the
 *            `accountabilityIntervention` offering and fulfils jobs.
 *   buyer  = a separate Habitra-owned agent, which creates and funds jobs.
 *
 * Secrets: this module reads credentials from the environment and passes them
 * to the SDK. It never logs them, never puts them in a result object, and never
 * includes them in a normalised error message. Credential *names* only.
 */

import type { Address } from 'viem';
import { base, baseSepolia } from 'viem/chains';

import type {
  AcpAgent,
  EntryHandler,
  JobRoomEntry,
  JobSession,
} from '@virtuals-protocol/acp-node-v2';

import type { InterventionRequest } from './virtuals.js';

/** Default offering registered on the Virtuals Service Registry. */
export const DEFAULT_ACP_OFFERING_NAME = 'accountabilityIntervention';

/** Fixed price of the registered offering, in USDC. */
export const DEFAULT_ACP_PRICE_USD = 0.01;

const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * Job creation is an on-chain transaction through a sponsored RPC; it is not a
 * 10-second operation. Kept separate from VIRTUALS_ACP_TIMEOUT_MS so the
 * existing timeout keeps its meaning without making real job creation fail.
 */
const DEFAULT_JOB_CREATE_TIMEOUT_MS = 60_000;

/** Retry budget per interventionId before we refuse to bill again. */
export const ACP_MAX_JOB_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// SDK loading
//
// The SDK is loaded lazily so that simply importing this module (which happens
// on the normal request path) never pulls the Virtuals/Privy/Solana dependency
// tree in, and so ACP stays entirely opt-in.
// ---------------------------------------------------------------------------

type AcpSdkModule = typeof import('@virtuals-protocol/acp-node-v2');

export interface AcpSdk {
  AcpAgent: AcpSdkModule['AcpAgent'];
  PrivyAlchemyEvmProviderAdapter: AcpSdkModule['PrivyAlchemyEvmProviderAdapter'];
  AssetToken: AcpSdkModule['AssetToken'];
}

export type LoadAcpSdk = () => Promise<AcpSdk>;

let cachedSdk: AcpSdk | null = null;

export async function loadAcpSdk(): Promise<AcpSdk> {
  if (!cachedSdk) {
    const mod = await import('@virtuals-protocol/acp-node-v2');
    cachedSdk = {
      AcpAgent: mod.AcpAgent,
      PrivyAlchemyEvmProviderAdapter: mod.PrivyAlchemyEvmProviderAdapter,
      AssetToken: mod.AssetToken,
    };
  }
  return cachedSdk;
}

/** Test seam: replaces the lazily loaded SDK module. */
export function setAcpSdk(sdk: AcpSdk | null): void {
  cachedSdk = sdk;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AcpWalletCredentials {
  walletAddress: string;
  walletId: string;
  signerPrivateKey: string;
}

export interface AcpRuntimeConfig {
  enabled: boolean;
  provider: string;
  chain: 'base' | 'baseSepolia';
  chainId: number;
  offeringName: string;
  priceUsd: number;
  timeoutMs: number;
  jobCreateTimeoutMs: number;
  builderCode?: string;
  /** The registered Habitra agent: owns the offering, fulfils jobs. */
  seller: AcpWalletCredentials;
  /** Separate Habitra-owned agent: creates and funds jobs. */
  buyer: AcpWalletCredentials;
}

function nonEmpty(value: string | undefined): string {
  return (value ?? '').trim();
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

function parsePriceUsd(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getAcpRuntimeConfig(): AcpRuntimeConfig {
  const chainRaw = nonEmpty(process.env.VIRTUALS_ACP_CHAIN).toLowerCase();
  const chain: 'base' | 'baseSepolia' = chainRaw === 'base' ? 'base' : 'baseSepolia';

  return {
    enabled: parseBoolean(process.env.VIRTUALS_ACP_ENABLED, false),
    provider: nonEmpty(process.env.VIRTUALS_ACP_PROVIDER).toLowerCase(),
    chain,
    chainId: chain === 'base' ? base.id : baseSepolia.id,
    offeringName: nonEmpty(process.env.VIRTUALS_ACP_OFFERING_NAME) || DEFAULT_ACP_OFFERING_NAME,
    priceUsd: parsePriceUsd(process.env.VIRTUALS_ACP_PRICE_USD, DEFAULT_ACP_PRICE_USD),
    timeoutMs: parseTimeoutMs(process.env.VIRTUALS_ACP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    jobCreateTimeoutMs: parseTimeoutMs(
      process.env.VIRTUALS_ACP_JOB_TIMEOUT_MS,
      DEFAULT_JOB_CREATE_TIMEOUT_MS,
    ),
    builderCode: nonEmpty(process.env.VIRTUALS_ACP_BUILDER_CODE) || undefined,
    seller: {
      walletAddress: nonEmpty(process.env.VIRTUALS_EVM_WALLET_ADDRESS),
      walletId: nonEmpty(process.env.VIRTUALS_EVM_WALLET_ID),
      signerPrivateKey: nonEmpty(process.env.VIRTUALS_EVM_SIGNER_PRIVATE_KEY),
    },
    buyer: {
      walletAddress: nonEmpty(process.env.VIRTUALS_BUYER_EVM_WALLET_ADDRESS),
      walletId: nonEmpty(process.env.VIRTUALS_BUYER_EVM_WALLET_ID),
      signerPrivateKey: nonEmpty(process.env.VIRTUALS_BUYER_EVM_SIGNER_PRIVATE_KEY),
    },
  };
}

/**
 * Credentials that are absent. Names only — never values.
 */
export function getAcpMissingCredentials(config: AcpRuntimeConfig): string[] {
  const missing: string[] = [];

  if (!config.seller.walletAddress) missing.push('VIRTUALS_EVM_WALLET_ADDRESS');
  if (!config.seller.walletId) missing.push('VIRTUALS_EVM_WALLET_ID');
  if (!config.seller.signerPrivateKey) missing.push('VIRTUALS_EVM_SIGNER_PRIVATE_KEY');
  if (!config.buyer.walletAddress) missing.push('VIRTUALS_BUYER_EVM_WALLET_ADDRESS');
  if (!config.buyer.walletId) missing.push('VIRTUALS_BUYER_EVM_WALLET_ID');
  if (!config.buyer.signerPrivateKey) missing.push('VIRTUALS_BUYER_EVM_SIGNER_PRIVATE_KEY');

  return missing;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isEvmAddress(value: string): boolean {
  return EVM_ADDRESS.test(value);
}

/**
 * Credentials that are present but structurally wrong.
 *
 * This is a safety net, not decoration: `providerAddress` is sent off-box to
 * the Virtuals registry, so a wallet address field that was pasted with the
 * signer key in it would leak a secret *and* fail the job. Anything that looks
 * wrong is reported by variable name and refuses to be used.
 */
export function getAcpInvalidCredentials(config: AcpRuntimeConfig): string[] {
  const invalid: string[] = [];

  const participants: Array<[AcpWalletCredentials, string, string]> = [
    [config.seller, 'VIRTUALS_EVM_WALLET_ADDRESS', 'VIRTUALS_EVM_SIGNER_PRIVATE_KEY'],
    [
      config.buyer,
      'VIRTUALS_BUYER_EVM_WALLET_ADDRESS',
      'VIRTUALS_BUYER_EVM_SIGNER_PRIVATE_KEY',
    ],
  ];

  for (const [creds, addressVar, keyVar] of participants) {
    if (creds.walletAddress && !isEvmAddress(creds.walletAddress)) {
      invalid.push(addressVar);
    }
    // A P-256/PKCS#8 signer key is never a 20-byte hex address. If it is, the
    // address and the key were swapped, or the key field holds an address.
    if (creds.signerPrivateKey && isEvmAddress(creds.signerPrivateKey)) {
      invalid.push(keyVar);
    }
    // The classic copy-paste leak: the address field contains the key.
    if (
      creds.signerPrivateKey &&
      creds.walletAddress &&
      creds.signerPrivateKey === creds.walletAddress
    ) {
      invalid.push(keyVar);
    }
  }

  // Buyer and seller must be distinct wallets: ACP v2 requires it.
  if (
    config.buyer.walletAddress &&
    config.seller.walletAddress &&
    config.buyer.walletAddress.toLowerCase() === config.seller.walletAddress.toLowerCase()
  ) {
    invalid.push('VIRTUALS_BUYER_EVM_WALLET_ADDRESS');
  }

  return [...new Set(invalid)];
}

// ---------------------------------------------------------------------------
// Agent construction
// ---------------------------------------------------------------------------

/**
 * The slice of `AcpAgent` this module depends on.
 *
 * Declared as a `Pick` of the real class so the signatures stay exact (no
 * hand-written structural type can drift from the SDK) while tests can supply a
 * small fake.
 */
export type AcpAgentLike = Pick<
  AcpAgent,
  'start' | 'stop' | 'on' | 'getAddress' | 'createJobByOfferingName'
>;

export type AcpCreateAgent = (
  sdk: AcpSdk,
  credentials: AcpWalletCredentials,
  config: AcpRuntimeConfig,
) => Promise<AcpAgentLike>;

export const defaultCreateAcpAgent: AcpCreateAgent = async (sdk, credentials, config) => {
  const evmProvider = await sdk.PrivyAlchemyEvmProviderAdapter.create({
    // Explicit: the adapter defaults to Base MAINNET. Never rely on that here.
    chains: [config.chain === 'base' ? base : baseSepolia],
    walletAddress: credentials.walletAddress as Address,
    walletId: credentials.walletId,
    signerPrivateKey: credentials.signerPrivateKey,
    ...(config.builderCode ? { builderCode: config.builderCode } : {}),
  });

  return sdk.AcpAgent.create({ evmProvider });
};

export interface AcpAgentFactoryDeps {
  loadSdk?: LoadAcpSdk;
  createAgent?: AcpCreateAgent;
}

interface AgentCache {
  key: string;
  sdk: AcpSdk;
  buyer: AcpAgentLike | null;
  seller: AcpAgentLike | null;
}

let agentCache: AgentCache | null = null;

function acpCacheKey(config: AcpRuntimeConfig): string {
  return JSON.stringify([
    config.chainId,
    config.offeringName,
    config.seller.walletAddress,
    config.buyer.walletAddress,
    config.builderCode ?? '',
  ]);
}

/** Test seam: drops cached agents so a new config takes effect. */
export function resetAcpAgents(): void {
  agentCache = null;
}

async function ensureAgentCache(
  config: AcpRuntimeConfig,
  deps: AcpAgentFactoryDeps,
): Promise<AgentCache> {
  const key = acpCacheKey(config);
  if (agentCache && agentCache.key === key) return agentCache;

  const load = deps.loadSdk ?? loadAcpSdk;
  agentCache = { key, sdk: await load(), buyer: null, seller: null };
  return agentCache;
}

export async function getAcpBuyerAgent(
  config: AcpRuntimeConfig,
  deps: AcpAgentFactoryDeps = {},
): Promise<AcpAgentLike> {
  const cache = await ensureAgentCache(config, deps);
  if (!cache.buyer) {
    const create = deps.createAgent ?? defaultCreateAcpAgent;
    cache.buyer = await create(cache.sdk, config.buyer, config);
  }
  return cache.buyer;
}

export async function getAcpSellerAgent(
  config: AcpRuntimeConfig,
  deps: AcpAgentFactoryDeps = {},
): Promise<AcpAgentLike> {
  const cache = await ensureAgentCache(config, deps);
  if (!cache.seller) {
    const create = deps.createAgent ?? defaultCreateAcpAgent;
    cache.seller = await create(cache.sdk, config.seller, config);
  }
  return cache.seller;
}

// ---------------------------------------------------------------------------
// Requirement / deliverable encoding
//
// The offering declares one requirement, `habitContext` (String/Plain), and one
// deliverable, `intervention` (String/Plain). The Gemini-authored intervention
// therefore travels *inside* habitContext: the seller echoes it back verbatim as
// the deliverable. Gemini stays the only author of the text.
// ---------------------------------------------------------------------------

export const HABIT_CONTEXT_VERSION = 'habitra-intervention-v1';
export const INTERVENTION_MARKER = '----- BEGIN HABITRA INTERVENTION MESSAGE -----';

export function buildHabitContext(request: InterventionRequest): string {
  const context = request.context ?? {};
  const value = (label: string, raw: string | number | undefined | null): string =>
    raw === undefined || raw === null ? `${label}: unknown` : `${label}: ${raw}`;

  return [
    `Habitra accountability intervention request (${HABIT_CONTEXT_VERSION})`,
    `Intervention id: ${request.interventionId}`,
    value('Habit', context.habitName),
    `Kind: ${request.kind}`,
    value('Current streak', context.currentStreak),
    value('Completion rate', context.completionRate),
    value('Misses in recent window', context.missedLastDays),
    '',
    `Goal: ${request.goal}`,
    `Reason: ${request.reason}`,
    '',
    INTERVENTION_MARKER,
    request.message,
  ].join('\n');
}

/** Extracts the `habitContext` value from a requirement message body. */
export function parseHabitContext(raw: string): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object') {
      const habitContext = (parsed as { habitContext?: unknown }).habitContext;
      if (typeof habitContext === 'string' && habitContext.trim()) return habitContext;
      return null;
    }
  } catch {
    // Not JSON: fall through and treat the body as plain text.
  }

  return trimmed;
}

/** Pulls the Gemini-authored intervention text back out of a habitContext. */
export function extractInterventionMessage(habitContext: string | null | undefined): string | null {
  if (!habitContext) return null;

  const index = habitContext.indexOf(INTERVENTION_MARKER);
  if (index === -1) {
    const fallback = habitContext.trim();
    return fallback || null;
  }

  const rest = habitContext.slice(index + INTERVENTION_MARKER.length).trim();
  return rest || null;
}

// ---------------------------------------------------------------------------
// In-memory job bridge
//
// Smallest safe answer to "do not blindly create duplicate paid jobs": the
// interventionId is the idempotency key, and a record that already has a job id
// is returned instead of billed again. In-memory only — it does NOT survive a
// restart. See the report: persistent idempotency needs a table.
// ---------------------------------------------------------------------------

export type AcpJobState =
  | 'RESERVED'
  | 'CREATED'
  | 'FUNDED'
  | 'SUBMITTED'
  | 'COMPLETED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'FAILED';

export const ACP_TERMINAL_STATES: readonly AcpJobState[] = [
  'COMPLETED',
  'REJECTED',
  'EXPIRED',
  'FAILED',
];

export interface AcpJobRecord {
  interventionId: string;
  request: InterventionRequest;
  state: AcpJobState;
  jobId: string | null;
  chainId: number | null;
  deliverable: string | null;
  failureReason: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface AcpReservation {
  record: AcpJobRecord;
  /** true when an earlier attempt already produced (or is holding) this job. */
  duplicate: boolean;
  /** false when the caller must NOT create a job. */
  allowed: boolean;
  reason?: string;
}

export class AcpJobBridge {
  private readonly records = new Map<string, AcpJobRecord>();
  private readonly byJobId = new Map<string, string>();
  private readonly listeners: Array<(record: AcpJobRecord) => void> = [];

  reserve(request: InterventionRequest, now: Date = new Date()): AcpReservation {
    const timestamp = now.toISOString();
    const existing = this.records.get(request.interventionId);

    if (!existing) {
      const record: AcpJobRecord = {
        interventionId: request.interventionId,
        request,
        state: 'RESERVED',
        jobId: null,
        chainId: null,
        deliverable: null,
        failureReason: null,
        attempts: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.records.set(record.interventionId, record);
      return { record, duplicate: false, allowed: true };
    }

    // A failed attempt may be retried within the attempt budget.
    if (existing.state === 'FAILED' && existing.attempts < ACP_MAX_JOB_ATTEMPTS) {
      existing.attempts += 1;
      existing.state = 'RESERVED';
      existing.failureReason = null;
      existing.updatedAt = timestamp;
      return { record: existing, duplicate: false, allowed: true };
    }

    return {
      record: existing,
      duplicate: true,
      allowed: false,
      reason: existing.jobId ? 'ACP_JOB_ALREADY_CREATED' : 'ACP_JOB_IN_FLIGHT',
    };
  }

  markCreated(interventionId: string, jobId: string, chainId: number, now: Date = new Date()): void {
    const record = this.records.get(interventionId);
    if (!record) return;

    record.state = 'CREATED';
    record.jobId = jobId;
    record.chainId = chainId;
    record.updatedAt = now.toISOString();
    this.byJobId.set(jobId, interventionId);
  }

  markFailed(interventionId: string, reason: string, now: Date = new Date()): void {
    const record = this.records.get(interventionId);
    if (!record) return;

    record.state = 'FAILED';
    record.failureReason = reason;
    record.updatedAt = now.toISOString();
    // No terminal notification: retries are still allowed, so nothing has
    // settled yet. The initial CREATED outcome already went to Sibyl.
  }

  /** Applies a lifecycle state observed by the buyer listener, by ACP job id. */
  markStateByJobId(
    jobId: string,
    state: AcpJobState,
    deliverable: string | null = null,
    now: Date = new Date(),
  ): AcpJobRecord | null {
    const interventionId = this.byJobId.get(jobId);
    if (!interventionId) return null;

    const record = this.records.get(interventionId);
    if (!record) return null;

    record.state = state;
    record.updatedAt = now.toISOString();
    if (deliverable) record.deliverable = deliverable;

    if (ACP_TERMINAL_STATES.includes(state)) {
      for (const listener of this.listeners) {
        try {
          listener(record);
        } catch {
          // A bad listener must never break the transport.
        }
      }
    }

    return record;
  }

  getByInterventionId(interventionId: string): AcpJobRecord | undefined {
    return this.records.get(interventionId);
  }

  getByJobId(jobId: string): AcpJobRecord | undefined {
    const interventionId = this.byJobId.get(jobId);
    return interventionId ? this.records.get(interventionId) : undefined;
  }

  onTerminal(listener: (record: AcpJobRecord) => void): void {
    this.listeners.push(listener);
  }

  reset(): void {
    this.records.clear();
    this.byJobId.clear();
    this.listeners.length = 0;
  }
}

export const acpJobBridge = new AcpJobBridge();

// Re-exported so the provider can type its handler against the real SDK types.
export type { EntryHandler, JobRoomEntry, JobSession };
