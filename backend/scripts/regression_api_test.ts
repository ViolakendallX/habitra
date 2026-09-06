import { createApp } from '../src/app.js';
import { prisma } from '../src/db/prisma.js';

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

async function main(): Promise<void> {
  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  let userAEmail = '';
  let userBEmail = '';

  try {
    // ---------------- auth regressions ----------------
    userAEmail = `reg-a-${Date.now()}@example.com`;
    const registerA = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'User A', email: userAEmail, password: 'Password123!' }),
    });
    check('auth register user A works', registerA.status === 201, `status=${registerA.status}`);

    const loginA = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userAEmail, password: 'Password123!' }),
    });
    const cookieA = extractCookie(loginA.headers.get('set-cookie'));
    check('auth login user A works', loginA.status === 200, `status=${loginA.status}`);
    check('auth login sets cookie', typeof cookieA === 'string' && cookieA.startsWith('habitra_auth='));

    const meNoCookie = await fetch(`${base}/api/auth/me`);
    check('auth me without cookie is rejected', meNoCookie.status === 401, `status=${meNoCookie.status}`);

    const meA = await fetch(`${base}/api/auth/me`, {
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    check('auth me with cookie succeeds', meA.status === 200, `status=${meA.status}`);

    // create user B + login
    userBEmail = `reg-b-${Date.now()}@example.com`;
    const registerB = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'User B', email: userBEmail, password: 'Password123!' }),
    });
    check('auth register user B works', registerB.status === 201, `status=${registerB.status}`);

    const loginB = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userBEmail, password: 'Password123!' }),
    });
    const cookieB = extractCookie(loginB.headers.get('set-cookie'));
    check('auth login user B works', loginB.status === 200, `status=${loginB.status}`);

    // ---------------- habits/completion/history/analytics/cross-user ----------------
    const createHabit = await fetch(`${base}/api/habits`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookieA ? { Cookie: cookieA } : {}),
      },
      body: JSON.stringify({
        name: 'Regression habit',
        frequency: 'DAILY',
        target: 1,
        preferredTime: '08:30',
      }),
    });
    const createHabitJson = await jsonOf(createHabit);
    const habitId = createHabitJson?.data?.habit?.id as string | undefined;
    check('habit create works', createHabit.status === 201 && typeof habitId === 'string', `status=${createHabit.status}`);

    const completion1 = await fetch(`${base}/api/habits/${habitId}/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookieA ? { Cookie: cookieA } : {}),
      },
      body: JSON.stringify({ date: '2026-09-06', status: 'COMPLETED' }),
    });
    check('completion create works', completion1.status === 201, `status=${completion1.status}`);

    const completionDup = await fetch(`${base}/api/habits/${habitId}/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookieA ? { Cookie: cookieA } : {}),
      },
      body: JSON.stringify({ date: '2026-09-06', status: 'COMPLETED' }),
    });
    check('completion duplicate still returns 409', completionDup.status === 409, `status=${completionDup.status}`);

    const historyA = await fetch(`${base}/api/habits/${habitId}/completions`, {
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    const historyAJson = await jsonOf(historyA);
    check('completion history works for owner', historyA.status === 200, `status=${historyA.status}`);
    check(
      'completion history includes at least one row',
      Array.isArray(historyAJson?.data?.completions) && historyAJson.data.completions.length >= 1,
    );

    const analyticsA = await fetch(`${base}/api/analytics`, {
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    const analyticsAJson = await jsonOf(analyticsA);
    check('analytics works for owner', analyticsA.status === 200, `status=${analyticsA.status}`);
    check('analytics returns success envelope', analyticsAJson?.status === 'success');

    const historyBOnA = await fetch(`${base}/api/habits/${habitId}/completions`, {
      headers: cookieB ? { Cookie: cookieB } : {},
    });
    check('cross-user history access remains blocked', historyBOnA.status === 404, `status=${historyBOnA.status}`);

    const completionBOnA = await fetch(`${base}/api/habits/${habitId}/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookieB ? { Cookie: cookieB } : {}),
      },
      body: JSON.stringify({ date: '2026-09-07', status: 'MISSED', missReason: 'Not owner' }),
    });
    check('cross-user completion write remains blocked', completionBOnA.status === 404, `status=${completionBOnA.status}`);
  } finally {
    server.close();

    const emails = [userAEmail, userBEmail].filter(Boolean);
    if (emails.length > 0) {
      await prisma.user.deleteMany({ where: { email: { in: emails } } });
    }
    await prisma.$disconnect();
  }

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.log(`\nRegression API suite: ${failed.length}/${results.length} checks FAILED`);
    process.exit(1);
  }

  console.log(`\nRegression API suite: ${results.length}/${results.length} checks PASSED`);
}

main().catch(async (err) => {
  console.error('Regression API suite crashed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
