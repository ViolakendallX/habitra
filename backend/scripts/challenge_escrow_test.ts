/**
 * Integration tests for the Challenge <-> BEES escrow boundary.
 *
 * Run with: npm run test:challenge_escrow   (inside backend/)
 *
 * These tests cover DEMO_CHAIN_MODE=true (the default): no RPC call, no signing,
 * no broadcast transaction. They assert that the *financial records* are created
 * correctly and that simulated records are never presented as real on-chain
 * transactions.
 *
 * Coverage:
 *   1.  Demo stake lock creates the correct FUND transaction
 *   2.  Demo successful challenge creates a CLAIM transaction
 *   3.  Demo failed challenge creates a PENALTY transaction
 *   4.  Successful settlement cannot happen twice
 *   5.  Failed settlement cannot happen twice
 *   6.  A challenge belonging to another user cannot be settled
 *   7.  A challenge with no linked wallet cannot be settled
 *   8.  A challenge that is not COMPLETED/FAILED cannot be settled
 *   9.  Re-running challenge evaluation does not duplicate settlement
 *   10. A simulated transaction is never presented as a real onchain transaction
 *   plus lock validation and idempotency cases.
 */

import { createApp } from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import { isDemoMode } from '../src/services/blockchain.js';
import {
  findSettlement,
  getChallengeEscrowState,
  isSimulatedTransaction,
  lockChallengeStake,
  settleChallengeAsFailure,
  settleChallengeAsSuccess,
} from '../src/services/challengeEscrow.js';

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

const checks: Check[] = [];

function check(name: string, pass: boolean, detail?: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}`);
}

function extractCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const first = setCookie.split(';')[0]?.trim();
  return first || null;
}

async function jsonOf(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Random, syntactically valid EVM address (test fixture only — never a key). */
function randomAddress(): string {
  let hex = '0x';
  const chars = '0123456789abcdef';
  for (let i = 0; i < 40; i += 1) {
    hex += chars[Math.floor(Math.random() * 16)];
  }
  return hex;
}

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function registerAndLogin(base: string, name: string, email: string): Promise<string | null> {
  await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password: 'Password123!' }),
  });

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password123!' }),
  });

  return extractCookie(login.headers.get('set-cookie'));
}

async function userIdOf(base: string, cookie: string | null): Promise<string | null> {
  const me = await fetch(`${base}/api/auth/me`, { headers: cookie ? { Cookie: cookie } : {} });
  const json = await jsonOf(me);
  return (json?.data?.user?.id as string | undefined) ?? null;
}

async function createHabit(base: string, cookie: string | null, name: string): Promise<string | undefined> {
  const res = await fetch(`${base}/api/habits`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ name, frequency: 'DAILY', target: 1 }),
  });
  const json = await jsonOf(res);
  return json?.data?.habit?.id;
}

async function createChallenge(
  base: string,
  cookie: string | null,
  habitId: string,
  title: string,
  maxMisses: number,
): Promise<string | undefined> {
  const res = await fetch(`${base}/api/challenges`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({
      title,
      startDate: isoDay(1),
      endDate: isoDay(3),
      maxMisses,
      habitId,
    }),
  });
  const json = await jsonOf(res);
  return json?.data?.challenge?.id;
}

async function commitChallenge(
  base: string,
  cookie: string | null,
  challengeId: string,
): Promise<number> {
  const res = await fetch(`${base}/api/challenges/${challengeId}/commit`, {
    method: 'POST',
    headers: cookie ? { Cookie: cookie } : {},
  });
  return res.status;
}

async function evaluateChallenge(
  base: string,
  cookie: string | null,
  challengeId: string,
): Promise<{ status: number; challengeStatus?: string }> {
  const res = await fetch(`${base}/api/challenges/${challengeId}/evaluate`, {
    method: 'POST',
    headers: cookie ? { Cookie: cookie } : {},
  });
  const json = await jsonOf(res);
  return { status: res.status, challengeStatus: json?.data?.challenge?.status };
}

async function linkWallet(base: string, cookie: string | null): Promise<string> {
  const address = randomAddress();
  await fetch(`${base}/api/wallet`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ address, chainId: 84532 }),
  });
  return address;
}

async function stakeViaApi(
  base: string,
  cookie: string | null,
  challengeId: string,
  amount: string,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/challenges/${challengeId}/stake`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ amount }),
  });
  return { status: res.status, json: await jsonOf(res) };
}

/** Simulates time passing: moves the challenge window into the past. */
async function forcePastWindow(challengeId: string): Promise<void> {
  await prisma.challenge.update({
    where: { id: challengeId },
    data: {
      startDate: new Date('2026-08-01T00:00:00.000Z'),
      endDate: new Date('2026-08-03T00:00:00.000Z'),
    },
  });
}

function countTx(challengeId: string, type?: string): Promise<number> {
  return prisma.transaction.count({
    where: { challengeId, ...(type ? { type } : {}) },
  });
}

/**
 * 5 BEES in base units. Deliberately below 2^63-1: `Transaction.amount` is a
 * Postgres int8, so ~9.22 BEES is the largest representable stake.
 */
const STAKE = '5000000000000000000';

async function run(): Promise<void> {
  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const emails: string[] = [];

  try {
    // ------------------------------------------------------------------
    // Setup
    // ------------------------------------------------------------------
    check('DEMO_CHAIN_MODE is active for this suite', isDemoMode() === true, `demoMode=${isDemoMode()}`);

    const emailA = `escrow-a-${Date.now()}@example.com`;
    const emailB = `escrow-b-${Date.now()}@example.com`;
    const emailC = `escrow-c-${Date.now()}@example.com`;
    emails.push(emailA, emailB, emailC);

    const cookieA = await registerAndLogin(base, 'Escrow A', emailA);
    const cookieB = await registerAndLogin(base, 'Escrow B', emailB);
    const cookieC = await registerAndLogin(base, 'Escrow C', emailC);

    const userAId = await userIdOf(base, cookieA);
    const userBId = await userIdOf(base, cookieB);
    const userCId = await userIdOf(base, cookieC);

    check('test users resolved', Boolean(userAId && userBId && userCId));
    if (!userAId || !userBId || !userCId) {
      throw new Error('Failed to resolve test user ids.');
    }

    const habitAId = await createHabit(base, cookieA, 'Escrow Habit A');
    const habitBId = await createHabit(base, cookieB, 'Escrow Habit B');
    const habitCId = await createHabit(base, cookieC, 'Escrow Habit C');
    if (!habitAId || !habitBId || !habitCId) {
      throw new Error('Habit setup failed.');
    }

    // Blockchain status should report demo mode (no on-chain calls).
    const statusRes = await fetch(`${base}/api/blockchain/status`, {
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    const statusJson = await jsonOf(statusRes);
    check(
      'blockchain status reports demo mode',
      statusJson?.data?.mode === 'demo',
      `mode=${statusJson?.data?.mode}`,
    );

    // User A links a wallet; user C deliberately does not.
    await linkWallet(base, cookieA);
    await linkWallet(base, cookieB);

    // ------------------------------------------------------------------
    // 1. Demo stake lock creates the correct FUND transaction
    // ------------------------------------------------------------------
    const passChallengeId = (await createChallenge(base, cookieA, habitAId, 'Pass challenge', 10))!;
    check('pass challenge created', typeof passChallengeId === 'string');

    const commitPass = await commitChallenge(base, cookieA, passChallengeId);
    check('pass challenge committed', commitPass === 200, `status=${commitPass}`);

    const stakeRes = await stakeViaApi(base, cookieA, passChallengeId, STAKE);
    const stakeResult = stakeRes.json?.data?.escrow;

    check(
      'demo stake lock returns 201',
      stakeRes.status === 201,
      `status=${stakeRes.status} message=${stakeRes.json?.message} code=${stakeRes.json?.code}`,
    );
    check(
      'demo stake lock records a FUND transaction',
      stakeResult?.transaction?.type === 'FUND',
      `type=${stakeResult?.transaction?.type}`,
    );
    check(
      'demo stake lock transaction is CONFIRMED with the correct amount',
      stakeResult?.transaction?.status === 'CONFIRMED' && stakeResult?.transaction?.amount === STAKE,
      `status=${stakeResult?.transaction?.status} amount=${stakeResult?.transaction?.amount}`,
    );
    check(
      'demo stake lock is flagged as simulated',
      stakeResult?.simulated === true && stakeResult?.mode === 'demo',
      `simulated=${stakeResult?.simulated} mode=${stakeResult?.mode}`,
    );

    const fundCount = await countTx(passChallengeId, 'FUND');
    check('exactly one FUND row exists for the challenge', fundCount === 1, `count=${fundCount}`);

    // ------------------------------------------------------------------
    // Lock validation + idempotency
    // ------------------------------------------------------------------
    const dupStake = await stakeViaApi(base, cookieA, passChallengeId, STAKE);
    check(
      'locking the same challenge twice is a no-op (200, ALREADY_LOCKED)',
      dupStake.status === 200 && dupStake.json?.data?.escrow?.code === 'ALREADY_LOCKED',
      `status=${dupStake.status} code=${dupStake.json?.data?.escrow?.code}`,
    );
    check('duplicate lock created no extra FUND row', (await countTx(passChallengeId, 'FUND')) === 1);

    const zeroStake = await stakeViaApi(base, cookieA, passChallengeId, '0');
    check(
      'zero / invalid stake amount is rejected',
      zeroStake.status === 400 || zeroStake.json?.data?.escrow?.code === 'INVALID_AMOUNT',
      `status=${zeroStake.status}`,
    );

    const badAmountStake = await stakeViaApi(base, cookieA, passChallengeId, 'not-a-number');
    check(
      'non-numeric stake amount is rejected',
      badAmountStake.status === 400,
      `status=${badAmountStake.status}`,
    );

    // Transaction.amount is a Postgres int8 (max 2^63-1), so an oversized stake
    // must be rejected with a validation error, not a database range error.
    const overflowStake = await stakeViaApi(
      base,
      cookieA,
      passChallengeId,
      '99999999999999999999999999',
    );
    check(
      'stake above the int8 storage limit is rejected as INVALID_AMOUNT',
      overflowStake.status === 400 && overflowStake.json?.code === 'INVALID_AMOUNT',
      `status=${overflowStake.status} code=${overflowStake.json?.code}`,
    );

    // ------------------------------------------------------------------
    // 2. Demo successful challenge creates a CLAIM transaction
    // ------------------------------------------------------------------
    await forcePastWindow(passChallengeId);
    const passEval = await evaluateChallenge(base, cookieA, passChallengeId);
    check(
      'challenge evaluates to COMPLETED',
      passEval.challengeStatus === 'COMPLETED',
      `status=${passEval.challengeStatus}`,
    );

    const claimCount = await countTx(passChallengeId, 'CLAIM');
    check('successful challenge created a CLAIM transaction', claimCount === 1, `count=${claimCount}`);

    const claimRow = await prisma.transaction.findFirst({
      where: { challengeId: passChallengeId, type: 'CLAIM' },
    });
    check(
      'CLAIM row is CONFIRMED, simulated and carries no txHash',
      claimRow?.status === 'CONFIRMED' && claimRow?.txHash === null,
      `status=${claimRow?.status} txHash=${claimRow?.txHash}`,
    );

    // ------------------------------------------------------------------
    // 4. Successful settlement cannot happen twice
    // ------------------------------------------------------------------
    const secondSuccess = await settleChallengeAsSuccess(userAId, passChallengeId);
    check(
      'second successful settlement is rejected as ALREADY_SETTLED',
      secondSuccess.duplicate === true && secondSuccess.code === 'ALREADY_SETTLED',
      `code=${secondSuccess.code} duplicate=${secondSuccess.duplicate}`,
    );
    check(
      'second successful settlement created no new CLAIM row',
      (await countTx(passChallengeId, 'CLAIM')) === 1,
    );

    // ------------------------------------------------------------------
    // 3. Demo failed challenge creates a PENALTY transaction
    // ------------------------------------------------------------------
    const failChallengeId = (await createChallenge(base, cookieA, habitAId, 'Fail challenge', 0))!;
    await commitChallenge(base, cookieA, failChallengeId);
    await stakeViaApi(base, cookieA, failChallengeId, STAKE);
    await forcePastWindow(failChallengeId);

    const failEval = await evaluateChallenge(base, cookieA, failChallengeId);
    check(
      'challenge evaluates to FAILED',
      failEval.challengeStatus === 'FAILED',
      `status=${failEval.challengeStatus}`,
    );

    const penaltyCount = await countTx(failChallengeId, 'PENALTY');
    check('failed challenge created a PENALTY transaction', penaltyCount === 1, `count=${penaltyCount}`);

    const penaltyRow = await prisma.transaction.findFirst({
      where: { challengeId: failChallengeId, type: 'PENALTY' },
    });
    check(
      'PENALTY row is CONFIRMED, simulated and carries no txHash',
      penaltyRow?.status === 'CONFIRMED' && penaltyRow?.txHash === null,
      `status=${penaltyRow?.status} txHash=${penaltyRow?.txHash}`,
    );

    // ------------------------------------------------------------------
    // 5. Failed settlement cannot happen twice
    // ------------------------------------------------------------------
    const secondFailure = await settleChallengeAsFailure(userAId, failChallengeId);
    check(
      'second failed settlement is rejected as ALREADY_SETTLED',
      secondFailure.duplicate === true && secondFailure.code === 'ALREADY_SETTLED',
      `code=${secondFailure.code} duplicate=${secondFailure.duplicate}`,
    );
    check(
      'second failed settlement created no new PENALTY row',
      (await countTx(failChallengeId, 'PENALTY')) === 1,
    );

    // ------------------------------------------------------------------
    // 9. Re-running challenge evaluation does not duplicate settlement
    // ------------------------------------------------------------------
    await evaluateChallenge(base, cookieA, failChallengeId);
    await evaluateChallenge(base, cookieA, failChallengeId);
    await evaluateChallenge(base, cookieA, passChallengeId);

    check(
      're-running evaluation does not duplicate PENALTY settlement',
      (await countTx(failChallengeId, 'PENALTY')) === 1,
      `count=${await countTx(failChallengeId, 'PENALTY')}`,
    );
    check(
      're-running evaluation does not duplicate CLAIM settlement',
      (await countTx(passChallengeId, 'CLAIM')) === 1,
      `count=${await countTx(passChallengeId, 'CLAIM')}`,
    );
    check(
      're-running evaluation created no settlement rows at all beyond the first',
      (await countTx(failChallengeId)) === 2 && (await countTx(passChallengeId)) === 2,
      `failTotal=${await countTx(failChallengeId)} passTotal=${await countTx(passChallengeId)}`,
    );

    // ------------------------------------------------------------------
    // 6. A challenge belonging to another user cannot be settled
    // ------------------------------------------------------------------
    const crossUserSettle = await settleChallengeAsFailure(userBId, failChallengeId);
    check(
      'another user cannot settle the challenge',
      crossUserSettle.ok === false && crossUserSettle.code === 'CHALLENGE_NOT_FOUND',
      `code=${crossUserSettle.code}`,
    );

    const crossUserState = await getChallengeEscrowState(userBId, failChallengeId);
    check('another user sees no escrow state', crossUserState === null);

    const crossUserApi = await fetch(`${base}/api/challenges/${failChallengeId}/escrow`, {
      headers: cookieB ? { Cookie: cookieB } : {},
    });
    check(
      'escrow endpoint returns 404 for another user challenge',
      crossUserApi.status === 404,
      `status=${crossUserApi.status}`,
    );

    // ------------------------------------------------------------------
    // 7. A challenge with no linked wallet cannot be settled
    // ------------------------------------------------------------------
    const noWalletChallengeId = (await createChallenge(base, cookieC, habitCId, 'No wallet', 0))!;
    await commitChallenge(base, cookieC, noWalletChallengeId);
    await forcePastWindow(noWalletChallengeId);
    const noWalletEval = await evaluateChallenge(base, cookieC, noWalletChallengeId);
    check(
      'wallet-less challenge still evaluates to FAILED',
      noWalletEval.challengeStatus === 'FAILED',
      `status=${noWalletEval.challengeStatus}`,
    );

    const noWalletSettle = await settleChallengeAsFailure(userCId, noWalletChallengeId);
    check(
      'challenge with no linked wallet cannot be settled',
      noWalletSettle.ok === false && noWalletSettle.code === 'NO_WALLET',
      `code=${noWalletSettle.code}`,
    );

    // A fresh ACTIVE challenge (not yet evaluated) is used for the lock check so
    // that the wallet condition is the one under test, not the closed-state one.
    const pendingLockChallengeId = (await createChallenge(base, cookieC, habitCId, 'Pending lock', 3))!;
    await commitChallenge(base, cookieC, pendingLockChallengeId);

    const noWalletLock = await lockChallengeStake({
      userId: userCId,
      challengeId: pendingLockChallengeId,
      amount: STAKE,
    });
    check(
      'stake cannot be locked without a linked wallet',
      noWalletLock.ok === false && noWalletLock.code === 'NO_WALLET',
      `code=${noWalletLock.code}`,
    );
    check(
      'wallet-less challenge created no transaction rows',
      (await countTx(noWalletChallengeId)) === 0,
      `count=${await countTx(noWalletChallengeId)}`,
    );
    check(
      'wallet-less lock attempt created no transaction rows',
      (await countTx(pendingLockChallengeId)) === 0,
      `count=${await countTx(pendingLockChallengeId)}`,
    );

    // ------------------------------------------------------------------
    // 8. A challenge that is not COMPLETED/FAILED cannot be settled
    // ------------------------------------------------------------------
    const activeChallengeId = (await createChallenge(base, cookieA, habitAId, 'Active challenge', 3))!;
    await commitChallenge(base, cookieA, activeChallengeId);
    const activeSettle = await settleChallengeAsSuccess(userAId, activeChallengeId);
    check(
      'ACTIVE challenge cannot be settled',
      activeSettle.ok === false && activeSettle.code === 'CHALLENGE_NOT_SETTLED_STATE',
      `code=${activeSettle.code}`,
    );

    const draftChallengeId = (await createChallenge(base, cookieA, habitAId, 'Draft challenge', 3))!;
    const draftSettle = await settleChallengeAsSuccess(userAId, draftChallengeId);
    check(
      'DRAFT challenge cannot be settled',
      draftSettle.ok === false && draftSettle.code === 'CHALLENGE_NOT_SETTLED_STATE',
      `code=${draftSettle.code}`,
    );

    const noStakeChallengeId = (await createChallenge(base, cookieA, habitAId, 'No stake', 0))!;
    await commitChallenge(base, cookieA, noStakeChallengeId);
    await forcePastWindow(noStakeChallengeId);
    await evaluateChallenge(base, cookieA, noStakeChallengeId);
    const noStakeSettle = await settleChallengeAsFailure(userAId, noStakeChallengeId);
    check(
      'challenge with no locked stake cannot be settled',
      noStakeSettle.ok === false && noStakeSettle.code === 'STAKE_NOT_LOCKED',
      `code=${noStakeSettle.code}`,
    );
    check(
      'no settlement row was created without a locked stake',
      (await countTx(noStakeChallengeId)) === 0,
      `count=${await countTx(noStakeChallengeId)}`,
    );

    // ------------------------------------------------------------------
    // 10. A simulated transaction is never presented as a real onchain tx
    // ------------------------------------------------------------------
    const passState = await getChallengeEscrowState(userAId, passChallengeId);
    check(
      'escrow state marks the settlement as simulated with no hash',
      passState?.settlement?.simulated === true && passState?.settlement?.txHash === null,
      `simulated=${passState?.settlement?.simulated} txHash=${passState?.settlement?.txHash}`,
    );
    check(
      'escrow state marks the stake as simulated',
      passState?.stake?.simulated === true,
      `simulated=${passState?.stake?.simulated}`,
    );

    const allRows = await prisma.transaction.findMany({
      where: { userId: userAId },
    });
    const fabricated = allRows.filter((tx) => tx.txHash !== null);
    check(
      'no simulated row ever carries a fabricated tx hash',
      fabricated.length === 0,
      `rowsWithHash=${fabricated.length} total=${allRows.length}`,
    );
    check(
      'every demo row is identified as simulated by the helper',
      allRows.every((tx) => isSimulatedTransaction({ ...tx, amount: tx.amount?.toString() ?? null } as any)),
      `rows=${allRows.length}`,
    );

    const failState = await getChallengeEscrowState(userAId, failChallengeId);
    check(
      'failed challenge escrow state reports PENALTY as settled',
      failState?.settled === true && failState?.settlement?.type === 'PENALTY',
      `settled=${failState?.settled} type=${failState?.settlement?.type}`,
    );
    check(
      'findSettlement helper reports the same settlement',
      findSettlement(
        (await prisma.transaction.findMany({ where: { challengeId: failChallengeId } })).map((tx) => ({
          id: tx.id,
          userId: tx.userId,
          walletId: tx.walletId,
          challengeId: tx.challengeId,
          type: tx.type as 'FUND' | 'CLAIM' | 'PENALTY',
          status: tx.status as 'PENDING' | 'CONFIRMED' | 'FAILED',
          txHash: tx.txHash,
          chainId: tx.chainId,
          amount: tx.amount?.toString() ?? null,
          tokenAddress: tx.tokenAddress,
          createdAt: tx.createdAt.toISOString(),
          updatedAt: tx.updatedAt.toISOString(),
        })),
      ) !== null,
    );

    // ------------------------------------------------------------------
    // Escrow endpoint works for the owner
    // ------------------------------------------------------------------
    const ownerEscrowRes = await fetch(`${base}/api/challenges/${passChallengeId}/escrow`, {
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    const ownerEscrowJson = await jsonOf(ownerEscrowRes);
    check(
      'owner can read escrow state',
      ownerEscrowRes.status === 200 && ownerEscrowJson?.data?.escrow?.settled === true,
      `status=${ownerEscrowRes.status}`,
    );

    const unauthEscrow = await fetch(`${base}/api/challenges/${passChallengeId}/escrow`);
    check('unauthenticated escrow read is rejected', unauthEscrow.status === 401, `status=${unauthEscrow.status}`);
  } catch (error) {
    check('escrow suite completed without throwing', false, String(error));
  } finally {
    try {
      await prisma.user.deleteMany({ where: { email: { in: emails } } });
    } catch {
      // Cleanup is best-effort; cascade deletes remove wallets/transactions.
    }
    server.close();
  }

  const passed = checks.filter((c) => c.pass).length;
  console.log('');
  console.log(`Challenge escrow suite: ${passed}/${checks.length} checks PASSED`);
  if (passed !== checks.length) {
    process.exitCode = 1;
  }
}

run();
