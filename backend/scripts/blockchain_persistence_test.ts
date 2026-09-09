import { getAddress } from 'viem';
import { prisma } from '../src/db/prisma.js';
import {
  BlockchainPersistenceError,
  connectWallet,
  createPendingTransaction,
  getUserTransactionHistory,
  getUserWalletForChain,
  updateTransaction,
  DEFAULT_CHAIN_ID,
} from '../src/services/blockchainPersistence.js';

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

/** Random 20-byte EVM address so repeated runs never collide on the unique key. */
function randomAddress(): string {
  let hex = '';
  for (let i = 0; i < 40; i += 1) {
    hex += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  }
  return `0x${hex}`;
}

const BEES = '0x000000000000000000000000000000000000beef';
const TX_HASH = `0x${'1'.repeat(64)}`;

async function run(): Promise<void> {
  const createdUserIds: string[] = [];

  try {
    const userA = await prisma.user.create({
      data: {
        name: 'blockchain-persist-a',
        email: `bc-persist-a-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        passwordHash: 'hash',
      },
    });
    const userB = await prisma.user.create({
      data: {
        name: 'blockchain-persist-b',
        email: `bc-persist-b-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        passwordHash: 'hash',
      },
    });
    createdUserIds.push(userA.id, userB.id);

    const addrA = randomAddress();
    const addrB = randomAddress();

    // 1) connectWallet stores a checksummed address on the default chain.
    const walletA = await connectWallet({ userId: userA.id, address: addrA });
    check('connectWallet stores wallet on default chain', walletA.chainId === DEFAULT_CHAIN_ID, `chainId=${walletA.chainId}`);
    check('connectWallet returns checksummed (EIP-55) address', walletA.address === getAddress(addrA), `address=${walletA.address}`);

    // 2) invalid EVM address is rejected.
    let invalidAddrThrew = false;
    try {
      await connectWallet({ userId: userA.id, address: 'not-an-address' });
    } catch (err) {
      invalidAddrThrew = err instanceof BlockchainPersistenceError;
    }
    check('connectWallet rejects invalid EVM address', invalidAddrThrew);

    // 3) unsupported chain id is rejected.
    let badChainThrew = false;
    try {
      await connectWallet({ userId: userA.id, address: randomAddress(), chainId: 999999 });
    } catch (err) {
      badChainThrew = err instanceof BlockchainPersistenceError;
    }
    check('connectWallet rejects unsupported chainId', badChainThrew);

    // 4) idempotent connect returns the same record.
    const walletA2 = await connectWallet({ userId: userA.id, address: addrA });
    check('connectWallet is idempotent for same user/address/chain', walletA2.id === walletA.id);

    // 5) an address already linked to another user cannot be linked again.
    let dupUserThrew = false;
    try {
      await connectWallet({ userId: userB.id, address: addrA });
    } catch (err) {
      dupUserThrew = err instanceof BlockchainPersistenceError;
    }
    check('connectWallet rejects address already linked to another user', dupUserThrew);

    // 6) getUserWalletForChain returns the user's wallet.
    const fetched = await getUserWalletForChain(userA.id);
    check('getUserWalletForChain returns connected wallet', fetched !== null && fetched.id === walletA.id);

    // 7) getUserWalletForChain returns null when none connected.
    const none = await getUserWalletForChain(userB.id);
    check('getUserWalletForChain returns null when absent', none === null);

    // 8) createPendingTransaction creates a PENDING record with amount.
    const tx = await createPendingTransaction({
      userId: userA.id,
      walletId: walletA.id,
      type: 'FUND',
      amount: '50',
      tokenAddress: BEES,
      challengeId: 'challenge-xyz',
    });
    check('createPendingTransaction sets PENDING status', tx.status === 'PENDING', `status=${tx.status}`);
    check('createPendingTransaction stores base-units amount', tx.amount === '50', `amount=${tx.amount}`);
    check('createPendingTransaction links challengeId', tx.challengeId === 'challenge-xyz');

    // 9) ownership enforced: another user cannot use my wallet.
    let ownerWalletThrew = false;
    try {
      await createPendingTransaction({ userId: userB.id, walletId: walletA.id, type: 'FUND' });
    } catch (err) {
      ownerWalletThrew = err instanceof BlockchainPersistenceError;
    }
    check('createPendingTransaction rejects another user wallet', ownerWalletThrew);

    // 10) invalid transaction type rejected.
    let badTypeThrew = false;
    try {
      await createPendingTransaction({ userId: userA.id, walletId: walletA.id, type: 'BOGUS' as never });
    } catch (err) {
      badTypeThrew = err instanceof BlockchainPersistenceError;
    }
    check('createPendingTransaction rejects invalid type', badTypeThrew);

    // 11) invalid amount string rejected.
    let badAmountThrew = false;
    try {
      await createPendingTransaction({ userId: userA.id, walletId: walletA.id, type: 'FUND', amount: 'abc' });
    } catch (err) {
      badAmountThrew = err instanceof BlockchainPersistenceError;
    }
    check('createPendingTransaction rejects non-integer amount', badAmountThrew);

    // 12) invalid token address rejected.
    let badTokenThrew = false;
    try {
      await createPendingTransaction({ userId: userA.id, walletId: walletA.id, type: 'FUND', tokenAddress: 'nope' });
    } catch (err) {
      badTokenThrew = err instanceof BlockchainPersistenceError;
    }
    check('createPendingTransaction rejects invalid token address', badTokenThrew);

    // 13) updateTransaction sets status + txHash, ownership enforced.
    const updated = await updateTransaction({
      userId: userA.id,
      transactionId: tx.id,
      status: 'CONFIRMED',
      txHash: TX_HASH,
    });
    check('updateTransaction updates status', updated.status === 'CONFIRMED', `status=${updated.status}`);
    check('updateTransaction stores txHash', updated.txHash === TX_HASH);

    // 14) another user cannot update my transaction.
    let ownerTxThrew = false;
    try {
      await updateTransaction({ userId: userB.id, transactionId: tx.id, status: 'FAILED' });
    } catch (err) {
      ownerTxThrew = err instanceof BlockchainPersistenceError;
    }
    check('updateTransaction rejects another user transaction', ownerTxThrew);

    // 15) history returns newest-first and includes the transaction.
    const tx2 = await createPendingTransaction({ userId: userA.id, walletId: walletA.id, type: 'CLAIM' });
    const history = await getUserTransactionHistory(userA.id);
    check('getUserTransactionHistory returns user transactions', history.length >= 2, `count=${history.length}`);
    check('getUserTransactionHistory is newest-first', history[0]?.id === tx2.id, `first=${history[0]?.id}`);
    check('getUserTransactionHistory only returns owned rows', history.every((t) => t.userId === userA.id));

    // 16) history filter by type.
    const fundHistory = await getUserTransactionHistory(userA.id, { type: 'FUND' });
    check('history filter by type works', fundHistory.length >= 1 && fundHistory.every((t) => t.type === 'FUND'));

    // 17) no secrets are ever stored on the wallet record.
    const secretKeys = ['privateKey', 'private_key', 'seed', 'seedPhrase', 'mnemonic'];
    const hasSecret = secretKeys.some((k) => k in (walletA as Record<string, unknown>));
    check('wallet record contains no secret fields', !hasSecret);

    const failed = checks.filter((entry) => !entry.pass);
    if (failed.length > 0) {
      console.log(`\nBlockchain persistence tests: ${failed.length}/${checks.length} checks FAILED`);
      process.exit(1);
    }
    console.log(`\nBlockchain persistence tests: ${checks.length}/${checks.length} checks PASSED`);
  } finally {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.$disconnect();
  }
}

run().catch(async (err) => {
  console.error('Blockchain persistence tests crashed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
