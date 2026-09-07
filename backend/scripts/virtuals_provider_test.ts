/**
 * Virtuals ACP v2 SELLER (provider) listener tests — offline-only.
 *
 * Drives the real `createAcpProvider()` entry handler with fake sessions and a
 * fake SDK. Nothing here loads the ACP SDK, opens a socket, signs anything, or
 * creates a job. The point is to prove the seller's half of the ACP state
 * machine is correct:
 *
 *   job.created  → setBudget(0.01 USDC on Base Sepolia)
 *   job.funded   → submit(<Gemini-authored text>)
 *   terminal     → relay into the job bridge (which is what reaches Sibyl)
 *
 * Run with:
 *   npm run test:virtuals_provider
 */

import type {
  EntryHandler,
  JobRoomEntry,
  JobSession,
} from '@virtuals-protocol/acp-node-v2';

import {
  createAcpProvider,
  findRequirement,
  type AcpProvider,
} from '../src/services/virtualsProvider.js';
import { buildTerminalOutcome } from '../src/services/virtuals.js';
import {
  AcpJobBridge,
  buildHabitContext,
  extractInterventionMessage,
  parseHabitContext,
  type AcpAgentLike,
  type AcpRuntimeConfig,
  type AcpSdk,
} from '../src/services/virtualsAcp.js';
import type { InterventionRequest } from '../src/services/virtuals.js';

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

const results: Check[] = [];
function check(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}`);
}

const SELLER = '0x1111111111111111111111111111111111111111';
const BUYER = '0x2222222222222222222222222222222222222222';
const CHAIN_ID = 84532; // Base Sepolia
const JOB_ID = '777';

const CONFIG: AcpRuntimeConfig = {
  enabled: true,
  provider: 'virtuals_acp_v2',
  chain: 'baseSepolia',
  chainId: CHAIN_ID,
  offeringName: 'accountabilityIntervention',
  priceUsd: 0.01,
  timeoutMs: 10_000,
  jobCreateTimeoutMs: 60_000,
  seller: { walletAddress: SELLER, walletId: 'seller-wallet-id', signerPrivateKey: 'KEY_A' },
  buyer: { walletAddress: BUYER, walletId: 'buyer-wallet-id', signerPrivateKey: 'KEY_B' },
};

const NOW = new Date('2026-09-07T12:00:00.000Z');

const MESSAGE = 'You have missed three runs in a row. Want to schedule one now?';

function buildRequest(overrides: Partial<InterventionRequest> = {}): InterventionRequest {
  return {
    userId: 'user-a',
    interventionId: 'int-prov-1',
    kind: 'commitment_check',
    habitId: 'habit-a-1',
    challengeId: null,
    goal: 'Get back on the morning run streak',
    message: MESSAGE,
    reason: 'Three consecutive misses after a 12-day streak.',
    context: { habitName: 'Morning run', currentStreak: 0, completionRate: 42, missedLastDays: 3 },
    requestedAt: '2026-09-06T12:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake SDK: only AssetToken is exercised by the seller path.
// ---------------------------------------------------------------------------

const usdcCalls: Array<{ amount: number; chainId: number }> = [];

class FakeAssetToken {
  readonly address = '0xECc22a8F6fD62388498fBa19813E214605a2BDb3';
  readonly symbol = 'USDC';
  readonly decimals = 6;
  readonly amount: number;

  constructor(amount: number) {
    this.amount = amount;
  }

  static usdc(amount: number, chainId: number): FakeAssetToken {
    usdcCalls.push({ amount, chainId });
    return new FakeAssetToken(amount);
  }
}

const FAKE_SDK = {
  AcpAgent: {},
  PrivyAlchemyEvmProviderAdapter: {},
  AssetToken: FakeAssetToken,
} as unknown as AcpSdk;

// ---------------------------------------------------------------------------
// Fake job session
// ---------------------------------------------------------------------------

const EVENT_TO_STATUS: Record<string, string> = {
  'job.created': 'open',
  'budget.set': 'budget_set',
  'job.funded': 'funded',
  'job.submitted': 'submitted',
  'job.completed': 'completed',
  'job.rejected': 'rejected',
  'job.expired': 'expired',
};

const RESPONDERS: Record<string, string[]> = {
  'job.created': ['provider'],
  'budget.set': ['client'],
  'job.funded': ['provider'],
  'job.submitted': ['evaluator'],
  'job.completed': ['client', 'provider'],
  'job.rejected': ['client', 'provider'],
  'job.expired': ['client', 'provider'],
};

interface SessionHarness {
  session: JobSession;
  entries: JobRoomEntry[];
  budgets: Array<{ amount: number; symbol: string }>;
  submits: string[];
  failSetBudget: boolean;
  failSubmit: boolean;
}

function makeSession(roles: string[] = ['provider']): SessionHarness {
  const entries: JobRoomEntry[] = [];
  const self = new Set([SELLER.toLowerCase()]);

  const harness: SessionHarness = {
    session: null as unknown as JobSession,
    entries,
    budgets: [],
    submits: [],
    failSetBudget: false,
    failSubmit: false,
  };

  const session = {
    jobId: JOB_ID,
    chainId: CHAIN_ID,
    roles,
    entries,
    get status(): string {
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (entry.kind === 'system') {
          const mapped = EVENT_TO_STATUS[entry.event.type];
          if (mapped) return mapped;
        }
      }
      return 'open';
    },
    shouldRespond(entry: JobRoomEntry): boolean {
      if (entry.kind === 'message') return !self.has(entry.from.toLowerCase());
      const allowed = RESPONDERS[entry.event.type];
      if (!allowed) return false;
      return roles.some((r) => allowed.includes(r));
    },
    async setBudget(token: unknown): Promise<void> {
      if (harness.failSetBudget) throw new Error('budget boom');
      const t = token as { amount: number; symbol: string };
      harness.budgets.push({ amount: t.amount, symbol: t.symbol });
    },
    async submit(deliverable: string): Promise<void> {
      if (harness.failSubmit) throw new Error('submit boom');
      harness.submits.push(deliverable);
    },
  } as unknown as JobSession;

  harness.session = session;
  return harness;
}

// ---------------------------------------------------------------------------
// Entry builders
// ---------------------------------------------------------------------------

function systemEvent(type: string, extra: Record<string, unknown> = {}): JobRoomEntry {
  return {
    kind: 'system',
    onChainJobId: JOB_ID,
    chainId: CHAIN_ID,
    timestamp: Date.now(),
    event: { type, jobId: JOB_ID, ...extra },
  } as unknown as JobRoomEntry;
}

function requirement(content: string, from = BUYER): JobRoomEntry {
  return {
    kind: 'message',
    onChainJobId: JOB_ID,
    chainId: CHAIN_ID,
    from,
    contentType: 'requirement',
    content,
    timestamp: Date.now(),
  } as unknown as JobRoomEntry;
}

const HABIT_CONTEXT = buildHabitContext(buildRequest());

async function feed(
  handler: EntryHandler,
  harness: SessionHarness,
  entry: JobRoomEntry,
): Promise<void> {
  harness.entries.push(entry);
  await handler(harness.session, entry);
}

// ---------------------------------------------------------------------------
// Fake seller agent
// ---------------------------------------------------------------------------

interface AgentCounters {
  on: number;
  start: number;
  stop: number;
}

function fakeAgent(counters: AgentCounters, captured: { current: EntryHandler | null }): AcpAgentLike {
  const agent: Record<string, unknown> = {
    start: async () => {
      counters.start += 1;
    },
    stop: async () => {
      counters.stop += 1;
    },
    getAddress: async () => SELLER,
    createJobByOfferingName: async () => 0n,
  };
  agent.on = (_event: unknown, handler: unknown) => {
    counters.on += 1;
    captured.current = handler as EntryHandler;
    return agent;
  };
  return agent as unknown as AcpAgentLike;
}

function quietLogger(): { info: (m: string) => void; warn: (m: string) => void } {
  return { info: () => undefined, warn: () => undefined };
}

/**
 * A provider that has actually been started.
 *
 * Required for anything that prices a job: `setBudget` refuses to run unless
 * the SDK is loaded, which only happens during `start()`.
 */
async function startedProvider(bridge: AcpJobBridge): Promise<AcpProvider> {
  const counters: AgentCounters = { on: 0, start: 0, stop: 0 };
  const captured: { current: EntryHandler | null } = { current: null };

  const provider = createAcpProvider({
    getConfig: () => CONFIG,
    loadSdk: async () => FAKE_SDK,
    getSellerAgent: async () => fakeAgent(counters, captured),
    now: () => NOW,
    logger: quietLogger(),
    bridge,
  });

  await provider.start();
  return provider;
}

async function main(): Promise<void> {
  // ---------------- Requirement parsing helpers ----------------
  check(
    'parseHabitContext reads habitContext from a JSON requirement',
    parseHabitContext(JSON.stringify({ habitContext: 'ctx' })) === 'ctx',
  );
  check(
    'parseHabitContext returns null for JSON without habitContext',
    parseHabitContext(JSON.stringify({ other: 1 })) === null,
  );
  check(
    'parseHabitContext falls back to the raw body for plain text',
    parseHabitContext('plain body') === 'plain body',
  );
  check(
    'extractInterventionMessage recovers the Gemini-authored text verbatim',
    extractInterventionMessage(HABIT_CONTEXT) === MESSAGE,
    String(extractInterventionMessage(HABIT_CONTEXT)),
  );
  check(
    'findRequirement ignores messages from other jobs',
    findRequirement(
      [
        {
          kind: 'message',
          onChainJobId: 'other-job',
          chainId: CHAIN_ID,
          from: BUYER,
          contentType: 'requirement',
          content: JSON.stringify({ habitContext: 'nope' }),
          timestamp: 1,
        } as unknown as JobRoomEntry,
      ],
      JOB_ID,
    ) === null,
  );
  check(
    'findRequirement finds the newest matching requirement',
    findRequirement(
      [
        requirement(JSON.stringify({ habitContext: 'first' })),
        requirement(JSON.stringify({ habitContext: 'second' })),
      ],
      JOB_ID,
    ) === 'second',
  );

  // ---------------- Happy path: created → requirement → budget → funded → submit
  {
    const provider = await startedProvider(new AcpJobBridge());

    const harness = makeSession();
    await feed(provider.handleEntry, harness, systemEvent('job.created'));
    check(
      'job.created alone does not set a budget (requirement has not arrived)',
      harness.budgets.length === 0,
      `budgets=${harness.budgets.length}`,
    );

    await feed(provider.handleEntry, harness, requirement(JSON.stringify({ habitContext: HABIT_CONTEXT })));
    check(
      'the requirement message triggers the $0.01 USDC budget',
      harness.budgets.length === 1 && harness.budgets[0]?.amount === 0.01,
      `budgets=${JSON.stringify(harness.budgets)}`,
    );
    check(
      'the budget is denominated in USDC',
      harness.budgets[0]?.symbol === 'USDC',
      `symbol=${harness.budgets[0]?.symbol}`,
    );
    check(
      'the budget is priced for Base Sepolia (chainId 84532)',
      usdcCalls[usdcCalls.length - 1]?.chainId === CHAIN_ID,
      `chainId=${usdcCalls[usdcCalls.length - 1]?.chainId}`,
    );

    await feed(provider.handleEntry, harness, systemEvent('job.funded', { client: BUYER, amount: 0.01 }));
    check(
      'job.funded submits exactly one deliverable',
      harness.submits.length === 1,
      `submits=${harness.submits.length}`,
    );
    check(
      'the deliverable is the Gemini-authored intervention, byte for byte',
      harness.submits[0] === MESSAGE,
      `deliverable=${harness.submits[0]}`,
    );

    // Idempotency: repeat events must not repeat side effects.
    await feed(provider.handleEntry, harness, systemEvent('job.funded', { client: BUYER, amount: 0.01 }));
    check('a duplicate job.funded does not submit twice', harness.submits.length === 1);
    await feed(provider.handleEntry, harness, requirement(JSON.stringify({ habitContext: HABIT_CONTEXT })));
    check('a duplicate requirement does not set the budget twice', harness.budgets.length === 1);
  }

  // ---------------- Ordering race: requirement BEFORE job.created ----------------
  {
    const provider = await startedProvider(new AcpJobBridge());
    const harness = makeSession();
    await feed(provider.handleEntry, harness, requirement(JSON.stringify({ habitContext: HABIT_CONTEXT })));
    await feed(provider.handleEntry, harness, systemEvent('job.created'));
    check(
      'a requirement arriving before job.created still sets the budget',
      harness.budgets.length === 1 && harness.budgets[0]?.amount === 0.01,
      `budgets=${harness.budgets.length}`,
    );
  }

  // ---------------- Terminal handling ----------------
  {
    const bridge = new AcpJobBridge();
    const request = buildRequest({ interventionId: 'int-prov-terminal' });
    bridge.reserve(request, NOW);
    bridge.markCreated('int-prov-terminal', JOB_ID, CHAIN_ID, NOW);

    const terminalRecords: string[] = [];
    bridge.onTerminal((record) => terminalRecords.push(record.state));

    const provider = await startedProvider(bridge);

    const harness = makeSession();
    await feed(provider.handleEntry, harness, systemEvent('job.created'));
    await feed(provider.handleEntry, harness, requirement(JSON.stringify({ habitContext: HABIT_CONTEXT })));
    await feed(provider.handleEntry, harness, systemEvent('job.funded', { client: BUYER, amount: 0.01 }));
    await feed(provider.handleEntry, harness, systemEvent('job.completed', { evaluator: BUYER, reason: '' }));

    check(
      'job.completed is relayed to the bridge as COMPLETED',
      terminalRecords.includes('COMPLETED'),
      `states=${terminalRecords.join(',')}`,
    );
    check(
      'the bridge record ends in a terminal state',
      bridge.getByInterventionId('int-prov-terminal')?.state === 'COMPLETED',
      `state=${bridge.getByInterventionId('int-prov-terminal')?.state}`,
    );

    const outcome = buildTerminalOutcome(
      bridge.getByInterventionId('int-prov-terminal')!,
      NOW,
    );
    check(
      'a completed ACP job becomes an ACCEPTED intervention outcome',
      outcome.status === 'ACCEPTED' && outcome.accepted === true,
      `status=${outcome.status} accepted=${outcome.accepted}`,
    );
    check(
      'the terminal outcome keeps the intervention source',
      outcome.source === 'virtuals_intervention_v1',
      `source=${outcome.source}`,
    );
    check(
      'the terminal outcome records the ACP job id',
      outcome.text.includes(JOB_ID),
      `text=${outcome.text.slice(0, 80)}`,
    );
    check(
      'the terminal outcome carries the habit id for later reasoning',
      outcome.habitId === 'habit-a-1',
      `habitId=${outcome.habitId}`,
    );
  }

  // ---------------- Rejected / expired mapping ----------------
  {
    const rejected = buildTerminalOutcome(
      {
        interventionId: 'i', request: buildRequest(), state: 'REJECTED', jobId: '1', chainId: CHAIN_ID,
        deliverable: null, failureReason: null, attempts: 1, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      },
      NOW,
    );
    check(
      'a rejected ACP job becomes a DECLINED intervention outcome',
      rejected.status === 'DECLINED' && rejected.accepted === false,
      `status=${rejected.status}`,
    );

    const expired = buildTerminalOutcome(
      {
        interventionId: 'i', request: buildRequest(), state: 'EXPIRED', jobId: '1', chainId: CHAIN_ID,
        deliverable: null, failureReason: null, attempts: 1, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      },
      NOW,
    );
    check(
      'an expired ACP job becomes an EXPIRED intervention outcome',
      expired.status === 'EXPIRED' && expired.accepted === null,
      `status=${expired.status}`,
    );
  }

  // ---------------- Malformed / hostile events ----------------
  {
    const provider = await startedProvider(new AcpJobBridge());
    const harness = makeSession();

    let threw = false;
    try {
      await provider.handleEntry(harness.session, null as unknown as JobRoomEntry);
      await provider.handleEntry(harness.session, {} as unknown as JobRoomEntry);
      await provider.handleEntry(harness.session, { kind: 'nonsense', onChainJobId: JOB_ID, chainId: CHAIN_ID } as unknown as JobRoomEntry);
      await provider.handleEntry(harness.session, { kind: 'system', onChainJobId: '', chainId: CHAIN_ID, event: { type: 'job.created' } } as unknown as JobRoomEntry);
      await provider.handleEntry(harness.session, { kind: 'system', onChainJobId: JOB_ID, chainId: 'nope', event: { type: 'job.created' } } as unknown as JobRoomEntry);
    } catch {
      threw = true;
    }

    check('malformed entries never throw out of the handler', threw === false);
    check('malformed entries create no job records', provider.trackedJobCount() === 0, `tracked=${provider.trackedJobCount()}`);

    // A requirement with no habitContext cannot be fulfilled.
    const bad = makeSession();
    await feed(provider.handleEntry, bad, systemEvent('job.created'));
    await feed(provider.handleEntry, bad, requirement(JSON.stringify({ unrelated: true })));
    check(
      'a requirement without habitContext does not set a budget',
      bad.budgets.length === 0,
      `budgets=${bad.budgets.length}`,
    );
    check(
      'the unparseable requirement is recorded as a reason code',
      provider.getJob(JOB_ID)?.lastError === 'REQUIREMENT_UNPARSEABLE',
      `lastError=${provider.getJob(JOB_ID)?.lastError}`,
    );

    // Funded with no deliverable: must not submit, must not throw.
    const starved = makeSession();
    await feed(provider.handleEntry, starved, systemEvent('job.created'));
    await feed(provider.handleEntry, starved, requirement(JSON.stringify({ noContext: 1 })));
    await feed(provider.handleEntry, starved, systemEvent('job.funded', { client: BUYER, amount: 0.01 }));
    check(
      'a funded job with no deliverable is left to expire, never junk-submitted',
      starved.submits.length === 0,
      `submits=${starved.submits.length}`,
    );
    check(
      'the missing deliverable is recorded as DELIVERABLE_MISSING',
      provider.getJob(JOB_ID)?.lastError === 'DELIVERABLE_MISSING',
      `lastError=${provider.getJob(JOB_ID)?.lastError}`,
    );
  }

  // ---------------- Failure containment ----------------
  {
    const provider = await startedProvider(new AcpJobBridge());

    const harness = makeSession();
    harness.failSetBudget = true;
    let threw = false;
    try {
      await feed(provider.handleEntry, harness, systemEvent('job.created'));
      await feed(provider.handleEntry, harness, requirement(JSON.stringify({ habitContext: HABIT_CONTEXT })));
    } catch {
      threw = true;
    }
    check('a setBudget failure does not escape the handler', threw === false);
    check('a failed setBudget leaves the job un-budgeted', provider.getJob(JOB_ID)?.budgetSet === false);

    const harness2 = makeSession();
    harness2.failSubmit = true;
    threw = false;
    try {
      await feed(provider.handleEntry, harness2, systemEvent('job.created'));
      await feed(provider.handleEntry, harness2, requirement(JSON.stringify({ habitContext: HABIT_CONTEXT })));
      await feed(provider.handleEntry, harness2, systemEvent('job.funded', { client: BUYER, amount: 0.01 }));
    } catch {
      threw = true;
    }
    check('a submit failure does not escape the handler', threw === false);
    check('a failed submit leaves the job un-submitted', provider.getJob(JOB_ID)?.submitted === false);
  }

  // ---------------- Lifecycle: one agent, one listener ----------------
  {
    const counters: AgentCounters = { on: 0, start: 0, stop: 0 };
    const captured: { current: EntryHandler | null } = { current: null };
    const agent = fakeAgent(counters, captured);

    const provider = createAcpProvider({
      getConfig: () => CONFIG,
      loadSdk: async () => FAKE_SDK,
      getSellerAgent: async () => agent,
      now: () => NOW,
      logger: quietLogger(),
      bridge: new AcpJobBridge(),
    });

    const first = await provider.start();
    check('provider starts with a fully configured topology', first.ok && first.started, first.reason);
    check('exactly one entry listener is registered', counters.on === 1, `on=${counters.on}`);
    check('the agent stream is started once', counters.start === 1, `start=${counters.start}`);
    check('the provider reports itself running', provider.isRunning() === true);

    const second = await provider.start();
    check(
      'a second start does not register another listener',
      second.started === false && second.reason === 'ALREADY_RUNNING' && counters.on === 1,
      `on=${counters.on} reason=${second.reason}`,
    );
    check('a second start does not open a second stream', counters.start === 1, `start=${counters.start}`);

    // Concurrent start must collapse: the SDK keeps ONE handler.
    await Promise.all([provider.start(), provider.start(), provider.start()]);
    check('concurrent starts still register one listener', counters.on === 1, `on=${counters.on}`);

    await provider.stop();
    check('stop tears the stream down once', counters.stop === 1, `stop=${counters.stop}`);
    check('the provider reports itself stopped', provider.isRunning() === false);
  }

  // ---------------- Lifecycle: refuses to start on a broken topology ----------------
  {
    const counters: AgentCounters = { on: 0, start: 0, stop: 0 };
    const captured: { current: EntryHandler | null } = { current: null };

    const disabled = createAcpProvider({
      getConfig: () => ({ ...CONFIG, enabled: false }),
      loadSdk: async () => FAKE_SDK,
      getSellerAgent: async () => fakeAgent(counters, captured),
      now: () => NOW,
      logger: quietLogger(),
      bridge: new AcpJobBridge(),
    });
    const off = await disabled.start();
    check('a disabled provider does not start', off.started === false && off.reason === 'ACP_DISABLED', off.reason);

    const halfConfigured = createAcpProvider({
      getConfig: () => ({ ...CONFIG, buyer: { walletAddress: '', walletId: '', signerPrivateKey: '' } }),
      loadSdk: async () => FAKE_SDK,
      getSellerAgent: async () => fakeAgent(counters, captured),
      now: () => NOW,
      logger: quietLogger(),
      bridge: new AcpJobBridge(),
    });
    const half = await halfConfigured.start();
    check(
      'a half-configured topology does not start',
      half.started === false && half.reason === 'CONFIG_MISSING',
      `${half.reason} ${(half.missing ?? []).join(',')}`,
    );

    const swapped = createAcpProvider({
      getConfig: () => ({
        ...CONFIG,
        seller: { ...CONFIG.seller, walletAddress: 'MIGH_FAKE_TEST_KEY' },
      }),
      loadSdk: async () => FAKE_SDK,
      getSellerAgent: async () => fakeAgent(counters, captured),
      now: () => NOW,
      logger: quietLogger(),
      bridge: new AcpJobBridge(),
    });
    const bad = await swapped.start();
    check(
      'a swapped address/key pair does not start (no secret leaves the box)',
      bad.started === false && bad.reason === 'CONFIG_INVALID',
      `${bad.reason} ${(bad.missing ?? []).join(',')}`,
    );

    const boom = createAcpProvider({
      getConfig: () => CONFIG,
      loadSdk: async () => FAKE_SDK,
      getSellerAgent: async () => {
        throw new Error('wallet unreachable');
      },
      now: () => NOW,
      logger: quietLogger(),
      bridge: new AcpJobBridge(),
    });
    const failed = await boom.start();
    check(
      'a start failure is reported, not thrown',
      failed.started === false && failed.reason === 'START_FAILED',
      `${failed.reason} ${failed.error ?? ''}`,
    );
    check('a failed start leaves the provider not running', boom.isRunning() === false);
  }

  const failedChecks = results.filter((r) => !r.pass);
  if (failedChecks.length > 0) {
    console.log(`\nVirtuals provider suite: ${failedChecks.length}/${results.length} checks FAILED`);
    process.exit(1);
  }

  console.log(`\nVirtuals provider suite: ${results.length}/${results.length} checks PASSED`);
}

main().catch((err) => {
  console.error('Virtuals provider suite crashed:', err);
  process.exit(1);
});
