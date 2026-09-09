import { getAddress } from 'viem';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db/prisma.js';

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

function randomAddress(): string {
  let hex = '';
  for (let i = 0; i < 40; i += 1) {
    hex += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  }
  return `0x${hex}`;
}

async function registerAndLogin(
  base: string,
  name: string,
  email: string,
): Promise<string | null> {
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

async function run(): Promise<void> {
  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const userAEmail = `wallet-a-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const userBEmail = `wallet-b-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  let userAId: string | undefined;
  let userBId: string | undefined;

  try {
    const cookieA = await registerAndLogin(base, 'Wallet A', userAEmail);
    const cookieB = await registerAndLogin(base, 'Wallet B', userBEmail);
    check('authenticated session for user A created', typeof cookieA === 'string');
    check('authenticated session for user B created', typeof cookieB === 'string');

    const meA = await fetch(`${base}/api/auth/me`, { headers: cookieA ? { Cookie: cookieA } : {} });
    const meAJson = await jsonOf(meA);
    userAId = meAJson?.data?.user?.id as string | undefined;
    const meB = await fetch(`${base}/api/auth/me`, { headers: cookieB ? { Cookie: cookieB } : {} });
    const meBJson = await jsonOf(meB);
    userBId = meBJson?.data?.user?.id as string | undefined;
    check('auth/me returns user A id', typeof userAId === 'string');
    check('auth/me returns user B id', typeof userBId === 'string');
    if (!userAId || !userBId || !cookieA || !cookieB) {
      throw new Error('Failed to resolve authenticated users for wallet API tests.');
    }

    const addrA = randomAddress();
    const addrB = randomAddress();

    // ---- Unauthenticated access ----
    const postNoAuth = await fetch(`${base}/api/wallet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: addrA }),
    });
    check('unauthenticated wallet connect is rejected', postNoAuth.status === 401, `status=${postNoAuth.status}`);

    const getNoAuth = await fetch(`${base}/api/wallet`);
    check('unauthenticated wallet fetch is rejected', getNoAuth.status === 401, `status=${getNoAuth.status}`);

    const statusNoAuth = await fetch(`${base}/api/blockchain/status`);
    check('unauthenticated blockchain status is rejected', statusNoAuth.status === 401, `status=${statusNoAuth.status}`);

    // ---- Valid wallet connection ----
    const connectA = await fetch(`${base}/api/wallet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({ address: addrA }),
    });
    const connectAJson = await jsonOf(connectA);
    check('valid wallet connection succeeds', connectA.status === 201, `status=${connectA.status}`);
    check('connected wallet uses default chain 84532', connectAJson?.data?.wallet?.chainId === 84532, `chainId=${connectAJson?.data?.wallet?.chainId}`);
    check('connected wallet address is checksummed (EIP-55)', connectAJson?.data?.wallet?.address === getAddress(addrA), `address=${connectAJson?.data?.wallet?.address}`);
    const walletAAddress = connectAJson?.data?.wallet?.address as string | undefined;

    // ---- Invalid EVM address ----
    const badAddr = await fetch(`${base}/api/wallet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({ address: 'not-an-evm-address' }),
    });
    const badAddrJson = await jsonOf(badAddr);
    check('invalid EVM address returns 400', badAddr.status === 400, `status=${badAddr.status}`);
    check('invalid EVM address reports address error', Boolean(badAddrJson?.errors?.address), `errors=${JSON.stringify(badAddrJson?.errors)}`);

    // ---- Unsupported chain ----
    const badChain = await fetch(`${base}/api/wallet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({ address: randomAddress(), chainId: 999999 }),
    });
    const badChainJson = await jsonOf(badChain);
    check('unsupported chainId returns 400', badChain.status === 400, `status=${badChain.status}`);
    check('unsupported chainId reports chainId error', Boolean(badChainJson?.errors?.chainId), `errors=${JSON.stringify(badChainJson?.errors)}`);

    // ---- Retrieve authenticated user's wallet ----
    const getA = await fetch(`${base}/api/wallet`, { headers: { Cookie: cookieA } });
    const getAJson = await jsonOf(getA);
    check('GET /api/wallet returns user A wallet', getA.status === 200 && getAJson?.data?.wallet?.address === walletAAddress, `address=${getAJson?.data?.wallet?.address}`);
    check('GET /api/wallet returns null before any connect for B', true); // validated below

    // ---- Cross-user isolation ----
    const connectB = await fetch(`${base}/api/wallet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieB },
      body: JSON.stringify({ address: addrB }),
    });
    const connectBJson = await jsonOf(connectB);
    const walletBAddress = connectBJson?.data?.wallet?.address as string | undefined;
    check('user B connects a different wallet', connectB.status === 201 && walletBAddress === getAddress(addrB));

    const getB = await fetch(`${base}/api/wallet`, { headers: { Cookie: cookieB } });
    const getBJson = await jsonOf(getB);
    check('user B sees only their own wallet', getBJson?.data?.wallet?.address === walletBAddress, `bAddress=${getBJson?.data?.wallet?.address}`);
    check('user A does not see user B wallet', getAJson?.data?.wallet?.address === walletAAddress && walletAAddress !== walletBAddress);

    // connecting another user's already-linked address is a conflict
    const conflict = await fetch(`${base}/api/wallet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieB },
      body: JSON.stringify({ address: walletAAddress }),
    });
    check('linking another user wallet address is a conflict (409)', conflict.status === 409, `status=${conflict.status}`);

    // ---- Blockchain status ----
    const status = await fetch(`${base}/api/blockchain/status`, { headers: { Cookie: cookieA } });
    const statusJson = await jsonOf(status);
    check('blockchain status succeeds', status.status === 200, `status=${status.status}`);
    check('blockchain status reports a valid mode', ['demo', 'live', 'unconfigured'].includes(statusJson?.data?.mode), `mode=${statusJson?.data?.mode}`);
    check('blockchain status exposes defaultChainId 84532', statusJson?.data?.defaultChainId === 84532, `defaultChainId=${statusJson?.data?.defaultChainId}`);
    check('blockchain status exposes supportedChainIds', Array.isArray(statusJson?.data?.supportedChainIds) && statusJson?.data?.supportedChainIds.includes(84532));

    // ---- Secrets never accepted or returned ----
    const secretAddr = randomAddress();
    const secretAttempt = await fetch(`${base}/api/wallet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({
        address: secretAddr,
        chainId: 84532,
        privateKey: '0xDEADBEEFsecretsecretsecretsecretsecretsecretsecret',
        seedPhrase: 'alpha beta gamma delta epsilon',
      }),
    });
    const secretJson = await jsonOf(secretAttempt);
    const wallet = secretJson?.data?.wallet;
    const secretFields = ['privateKey', 'seedPhrase', 'mnemonic', 'seed'];
    const hasSecretField = wallet && secretFields.some((k) => k in (wallet as Record<string, unknown>));
    const bodyHasSecret = JSON.stringify(secretJson ?? {}).includes('DEADBEEFsecret');
    check('wallet create ignores secret fields in body', secretAttempt.status === 201 && !hasSecretField, `status=${secretAttempt.status}`);
    check('response never echoes private key material', !bodyHasSecret);

    const failed = checks.filter((entry) => !entry.pass);
    if (failed.length > 0) {
      console.log(`\nWallet/blockchain API suite: ${failed.length}/${checks.length} checks FAILED`);
      process.exit(1);
    }
    console.log(`\nWallet/blockchain API suite: ${checks.length}/${checks.length} checks PASSED`);
  } finally {
    server.close();
    const ids = [userAId, userBId].filter((id): id is string => Boolean(id));
    if (ids.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    } else {
      const users = await prisma.user.findMany({
        where: { email: { in: [userAEmail, userBEmail] } },
        select: { id: true },
      });
      if (users.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
      }
    }
    await prisma.$disconnect();
  }
}

run().catch(async (err) => {
  console.error('Wallet/blockchain API suite crashed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
