/**
 * ACP v2 adapter boundary tests (offline-only).
 *
 * This suite verifies that:
 * - mock remains default when ACP vars are absent
 * - ACP v2 can be selected only with explicit env enablement
 * - missing / malformed credentials fail fast with configuration errors
 * - the real job-creation call is built with the correct arguments
 * - no network side effects are required to validate selection behaviour
 *
 * NOTHING here touches the network. The ACP SDK is never loaded: the buyer
 * agent and its job-creation call are stubbed, and the assertions inspect the
 * arguments that WOULD have been sent.
 *
 * Run with:
 *   npm run test:virtuals_acp_v2
 */

import {
  createVirtualsAcpV2Client,
  getVirtualsAcpV2Config,
  getVirtualsAcpV2MissingConfig,
  selectInterventionBackend,
  type InterventionRequest,
  type VirtualsAcpV2Config,
} from '../src/services/virtuals.js';

import {
  AcpJobBridge,
  extractInterventionMessage,
  getAcpInvalidCredentials,
  getAcpMissingCredentials,
  getAcpRuntimeConfig,
  isEvmAddress,
  type AcpAgentLike,
} from '../src/services/virtualsAcp.js';

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

const SELLER_ADDRESS = '0x1111111111111111111111111111111111111111';
const BUYER_ADDRESS = '0x2222222222222222222222222222222222222222';

const ORIGINAL_ENV: Record<string, string | undefined> = {
  VIRTUALS_ACP_ENABLED: process.env.VIRTUALS_ACP_ENABLED,
  VIRTUALS_ACP_PROVIDER: process.env.VIRTUALS_ACP_PROVIDER,
  VIRTUALS_EVM_WALLET_ADDRESS: process.env.VIRTUALS_EVM_WALLET_ADDRESS,
  VIRTUALS_EVM_WALLET_ID: process.env.VIRTUALS_EVM_WALLET_ID,
  VIRTUALS_EVM_SIGNER_PRIVATE_KEY: process.env.VIRTUALS_EVM_SIGNER_PRIVATE_KEY,
  VIRTUALS_BUYER_EVM_WALLET_ADDRESS: process.env.VIRTUALS_BUYER_EVM_WALLET_ADDRESS,
  VIRTUALS_BUYER_EVM_WALLET_ID: process.env.VIRTUALS_BUYER_EVM_WALLET_ID,
  VIRTUALS_BUYER_EVM_SIGNER_PRIVATE_KEY: process.env.VIRTUALS_BUYER_EVM_SIGNER_PRIVATE_KEY,
  VIRTUALS_ACP_CHAIN: process.env.VIRTUALS_ACP_CHAIN,
  VIRTUALS_ACP_TIMEOUT_MS: process.env.VIRTUALS_ACP_TIMEOUT_MS,
  VIRTUALS_ACP_BUILDER_CODE: process.env.VIRTUALS_ACP_BUILDER_CODE,
};

function setEnv(values: Partial<Record<keyof typeof ORIGINAL_ENV, string | undefined>>): void {
  const keys = Object.keys(ORIGINAL_ENV) as Array<keyof typeof ORIGINAL_ENV>;
  for (const key of keys) {
    const next = values[key];
    if (next === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }
}

function buildRequest(overrides: Partial<InterventionRequest> = {}): InterventionRequest {
  return {
    userId: 'user-a',
    interventionId: 'int-acp-1',
    kind: 'nudge',
    habitId: null,
    challengeId: null,
    goal: 'Do one tiny action now.',
    message: 'Small nudge to rebuild consistency.',
    reason: 'Recent misses suggest a reminder may help.',
    context: {
      habitName: 'Morning Reading',
      currentStreak: 0,
      completionRate: 20,
      missedLastDays: 4,
    },
    requestedAt: '2026-09-07T10:00:00.000Z',
    ...overrides,
  };
}

/** Records what WOULD have gone on chain. Never performs I/O. */
interface CapturedJob {
  chainId: number;
  offeringName: string;
  providerAddress: string;
  requirement: Record<string, unknown> | string;
  opts: unknown;
}

function stubBuyerAgent(capture: { current: CapturedJob | null }, jobId = 4242n): AcpAgentLike {
  return {
    createJobByOfferingName: async (
      chainId: number,
      offeringName: string,
      providerAddress: string,
      requirementData: Record<string, unknown> | string,
      opts?: unknown,
    ) => {
      capture.current = { chainId, offeringName, providerAddress, requirement: requirementData, opts };
      return jobId;
    },
    // Unused by the client; present to satisfy the agent shape.
    getAddress: async () => BUYER_ADDRESS,
    on: function (this: unknown) {
      return this as never;
    },
    start: async () => undefined,
    stop: async () => undefined,
  } as unknown as AcpAgentLike;
}

async function main(): Promise<void> {
  try {
    // 1) Default/missing env -> mock selection.
    setEnv({});
    const selDefault = selectInterventionBackend();
    check(
      'default selection stays on mock when ACP is not enabled',
      selDefault.backend === 'mock',
      `backend=${selDefault.backend}`,
    );

    // 2) Enabled but missing creds -> still mock fallback.
    setEnv({
      VIRTUALS_ACP_ENABLED: 'true',
      VIRTUALS_ACP_PROVIDER: 'virtuals_acp_v2',
      VIRTUALS_ACP_CHAIN: 'baseSepolia',
    });
    const selMissing = selectInterventionBackend();
    check(
      'selection falls back to mock when ACP env is incomplete',
      selMissing.backend === 'mock',
      selMissing.reason,
    );
    check(
      'missing list reports required credential variable names',
      getVirtualsAcpV2MissingConfig(selMissing.config).length === 3,
      getVirtualsAcpV2MissingConfig(selMissing.config).join(','),
    );

    // 3) ACP boundary client returns explicit config error when called incomplete.
    const incompleteConfig: VirtualsAcpV2Config = {
      enabled: true,
      walletAddress: '',
      walletId: '',
      signerPrivateKey: '',
      chain: 'baseSepolia',
      timeoutMs: 10_000,
    };
    const acpBoundary = createVirtualsAcpV2Client(incompleteConfig);
    const acpBoundaryResult = await acpBoundary.submit(buildRequest());
    check(
      'ACP boundary returns FAILED with config missing reason',
      acpBoundaryResult.ok === false && acpBoundaryResult.reason === 'VIRTUALS_ACP_CONFIG_MISSING',
      acpBoundaryResult.ok ? 'ok=true' : acpBoundaryResult.reason,
    );

    // 4) Full credential presence selects ACP boundary backend.
    setEnv({
      VIRTUALS_ACP_ENABLED: 'true',
      VIRTUALS_ACP_PROVIDER: 'virtuals_acp_v2',
      VIRTUALS_EVM_WALLET_ADDRESS: SELLER_ADDRESS,
      VIRTUALS_EVM_WALLET_ID: '00000000-0000-0000-0000-000000000001',
      VIRTUALS_EVM_SIGNER_PRIVATE_KEY: 'MIGH_FAKE_TEST_KEY',
      VIRTUALS_BUYER_EVM_WALLET_ADDRESS: BUYER_ADDRESS,
      VIRTUALS_BUYER_EVM_WALLET_ID: '00000000-0000-0000-0000-000000000002',
      VIRTUALS_BUYER_EVM_SIGNER_PRIVATE_KEY: 'MIGH_FAKE_BUYER_TEST_KEY',
      VIRTUALS_ACP_CHAIN: 'baseSepolia',
      VIRTUALS_ACP_TIMEOUT_MS: '12000',
    });

    const cfg = getVirtualsAcpV2Config();
    check('ACP config parser reads enabled=true', cfg.enabled === true, `enabled=${cfg.enabled}`);
    check('ACP config parser reads chain', cfg.chain === 'baseSepolia', `chain=${cfg.chain}`);
    check('ACP config parser reads timeout', cfg.timeoutMs === 12000, `timeout=${cfg.timeoutMs}`);

    const selReady = selectInterventionBackend();
    check(
      'selection chooses virtuals_acp_v2 when seller + buyer env are present',
      selReady.backend === 'virtuals_acp_v2',
      `backend=${selReady.backend} :: ${selReady.reason}`,
    );

    // 5) Half a topology must NOT select ACP: the buyer wallet is mandatory.
    const savedBuyerAddress = process.env.VIRTUALS_BUYER_EVM_WALLET_ADDRESS;
    delete process.env.VIRTUALS_BUYER_EVM_WALLET_ADDRESS;
    const selNoBuyer = selectInterventionBackend();
    check(
      'selection stays on mock when only the seller is configured',
      selNoBuyer.backend === 'mock',
      `backend=${selNoBuyer.backend}`,
    );
    check(
      'missing-participant check names the absent buyer variable',
      getAcpMissingCredentials(getAcpRuntimeConfig()).includes('VIRTUALS_BUYER_EVM_WALLET_ADDRESS'),
      getAcpMissingCredentials(getAcpRuntimeConfig()).join(','),
    );
    process.env.VIRTUALS_BUYER_EVM_WALLET_ADDRESS = savedBuyerAddress;

    // 6) A structurally wrong credential must never be sent to the registry.
    const savedSellerAddress = process.env.VIRTUALS_EVM_WALLET_ADDRESS;
    process.env.VIRTUALS_EVM_WALLET_ADDRESS = 'MIGH_FAKE_TEST_KEY';
    check(
      'a wallet address field holding a key is detected as invalid',
      getAcpInvalidCredentials(getAcpRuntimeConfig()).includes('VIRTUALS_EVM_WALLET_ADDRESS'),
      getAcpInvalidCredentials(getAcpRuntimeConfig()).join(','),
    );
    check(
      'invalid credentials keep the runtime on the mock backend',
      selectInterventionBackend().backend === 'mock',
      `backend=${selectInterventionBackend().backend}`,
    );
    process.env.VIRTUALS_EVM_WALLET_ADDRESS = savedSellerAddress;

    check('isEvmAddress accepts a real 20-byte address', isEvmAddress(SELLER_ADDRESS));
    check('isEvmAddress rejects a key-shaped string', !isEvmAddress('MIGH_FAKE_TEST_KEY'));

    // 7) Real execution path — fully stubbed, still no network.
    const capture: { current: CapturedJob | null } = { current: null };
    const bridge = new AcpJobBridge();
    const liveClient = createVirtualsAcpV2Client(selReady.config, {
      getBuyerAgent: async () => stubBuyerAgent(capture),
      bridge,
    });

    const result = await liveClient.submit(buildRequest({ interventionId: 'int-acp-ready' }));

    check(
      'a real ACP job is created and reported as CREATED',
      result.ok === true && result.status === 'CREATED' && result.provider === 'virtuals',
      result.ok ? `status=${result.status}` : result.reason,
    );
    check(
      'the ACP job id is returned as providerRef',
      result.ok === true && result.providerRef === '4242',
      `providerRef=${result.ok ? String(result.providerRef) : 'n/a'}`,
    );

    const job = capture.current;
    check(
      'job targets Base Sepolia (chainId 84532)',
      job?.chainId === 84532,
      `chainId=${job?.chainId}`,
    );
    check(
      'job targets the registered offering by name',
      job?.offeringName === 'accountabilityIntervention',
      `offering=${job?.offeringName}`,
    );
    check(
      'job targets the SELLER wallet, not the buyer',
      job?.providerAddress === SELLER_ADDRESS,
      `provider=${job?.providerAddress}`,
    );

    const requirement = job?.requirement as { habitContext?: string } | undefined;
    check(
      'requirement carries habitContext as a string',
      typeof requirement?.habitContext === 'string' && requirement.habitContext.length > 0,
      `type=${typeof requirement?.habitContext}`,
    );
    check(
      'habitContext carries the Gemini-authored intervention text',
      extractInterventionMessage(requirement?.habitContext ?? '') ===
        'Small nudge to rebuild consistency.',
      `text=${String(extractInterventionMessage(requirement?.habitContext ?? ''))}`,
    );
    check(
      'evaluatorAddress is omitted (skip-evaluation mode)',
      job?.opts !== undefined &&
        typeof job.opts === 'object' &&
        !('evaluatorAddress' in (job.opts as Record<string, unknown>)),
      `opts=${JSON.stringify(job?.opts)}`,
    );

    // 8) Idempotency: the same interventionId must NOT bill a second job.
    const second = await liveClient.submit(buildRequest({ interventionId: 'int-acp-ready' }));
    check(
      'a duplicate interventionId does not create a second job',
      second.ok === true && capture.current?.chainId === 84532 && bridge.getByInterventionId('int-acp-ready')?.attempts === 1,
      `attempts=${bridge.getByInterventionId('int-acp-ready')?.attempts}`,
    );
    check(
      'the duplicate returns the original job id',
      second.ok === true && second.providerRef === '4242',
      `providerRef=${second.ok ? String(second.providerRef) : 'n/a'}`,
    );

    // 9) Job-creation failure is contained and recorded.
    const failingClient = createVirtualsAcpV2Client(selReady.config, {
      getBuyerAgent: async () => stubBuyerAgent({ current: null }, 0n),
      createJob: async () => {
        throw new Error('insufficient gas');
      },
      bridge,
    });
    const failedResult = await failingClient.submit(
      buildRequest({ interventionId: 'int-acp-boom' }),
    );
    check(
      'a job-creation failure is reported as VIRTUALS_ACP_JOB_FAILED',
      failedResult.ok === false && failedResult.reason === 'VIRTUALS_ACP_JOB_FAILED',
      failedResult.ok ? 'ok=true' : failedResult.reason,
    );
    check(
      'the failed attempt is recorded so a retry is possible',
      bridge.getByInterventionId('int-acp-boom')?.state === 'FAILED',
      `state=${bridge.getByInterventionId('int-acp-boom')?.state}`,
    );

    const retryClient = createVirtualsAcpV2Client(selReady.config, {
      getBuyerAgent: async () => stubBuyerAgent(capture, 999n),
      bridge,
    });
    const retried = await retryClient.submit(buildRequest({ interventionId: 'int-acp-boom' }));
    check(
      'a FAILED attempt may be retried within the attempt budget',
      retried.ok === true && retried.providerRef === '999',
      retried.ok ? String(retried.providerRef) : retried.reason,
    );
  } finally {
    // Restore original env exactly.
    const keys = Object.keys(ORIGINAL_ENV) as Array<keyof typeof ORIGINAL_ENV>;
    for (const key of keys) {
      const value = ORIGINAL_ENV[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.log(`\nACP v2 boundary suite: ${failed.length}/${results.length} checks FAILED`);
    process.exit(1);
  }

  console.log(`\nACP v2 boundary suite: ${results.length}/${results.length} checks PASSED`);
}

main().catch((err) => {
  console.error('ACP v2 boundary suite crashed:', err);
  process.exit(1);
});
