import { setTimeout as delay } from 'node:timers/promises';

const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const appBase = process.env.APP_BASE_URL || 'http://127.0.0.1:5173';

async function waitForUrl(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return;
    } catch {
      // retry
    }
    await delay(500);
  }
  throw new Error(`Timeout waiting for ${url}`);
}

function challengeProgress(overrides = {}) {
  return {
    challengeId: 'c-default',
    status: 'DRAFT',
    currentStatus: 'DRAFT',
    startDate: '2026-09-01',
    endDate: '2026-09-03',
    durationDays: 3,
    daysTotal: 3,
    daysElapsed: 1,
    daysCompleted: 0,
    daysMissed: 0,
    daysPending: 3,
    maxMisses: 0,
    remainingMissAllowance: 0,
    completionRate: 0,
    linkedHabit: { habitId: 'h1', name: 'Study', status: 'ACTIVE' },
    failureReason: null,
    ...overrides,
  };
}

function challenge(overrides = {}) {
  return {
    id: 'c-default',
    userId: 'u1',
    title: 'Default challenge',
    description: null,
    status: 'DRAFT',
    startDate: '2026-09-01T00:00:00.000Z',
    endDate: '2026-09-03T00:00:00.000Z',
    durationDays: 3,
    maxMisses: 0,
    committedAt: null,
    completedAt: null,
    failedAt: null,
    failReason: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    linkedHabit: { habitId: 'h1', name: 'Study', status: 'ACTIVE' },
    progress: challengeProgress(),
    ...overrides,
  };
}

async function run() {
  const { chromium } = await import('playwright-core');

  const checks = [];
  function check(name, pass, detail = '') {
    checks.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}`);
  }

  await waitForUrl(appBase);

  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  try {
    const anon = await browser.newContext();
    const anonPage = await anon.newPage();
    await anonPage.goto(`${appBase}/challenges`);
    await anonPage.waitForURL('**/login', { timeout: 10000 });
    check('protected-route behavior for /challenges remains intact', anonPage.url().includes('/login'));
    await anon.close();

    const data = {
      user: {
        id: 'u1',
        name: 'Challenge UI User',
        email: 'challenge-ui@example.com',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
      habits: [
        {
          id: 'h1',
          userId: 'u1',
          name: 'Study',
          description: null,
          frequency: 'DAILY',
          target: 1,
          preferredTime: null,
          status: 'ACTIVE',
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      ],
      challenges: [
        challenge({
          id: 'c1',
          title: 'Draft challenge',
          status: 'DRAFT',
          progress: challengeProgress({ challengeId: 'c1', status: 'DRAFT', currentStatus: 'DRAFT' }),
        }),
        challenge({
          id: 'c2',
          title: 'Active challenge',
          status: 'ACTIVE',
          committedAt: '2026-09-01T00:00:00.000Z',
          progress: challengeProgress({ challengeId: 'c2', status: 'ACTIVE', currentStatus: 'ACTIVE', daysElapsed: 2, daysPending: 1 }),
        }),
      ],
    };

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.route('**/api/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      const method = req.method();

      if (path === '/api/auth/me' && method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'success', data: { user: data.user } }),
        });
        return;
      }

      if (path === '/api/habits' && method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'success', data: { habits: data.habits } }),
        });
        return;
      }

      if (path === '/api/challenges' && method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'success', data: { challenges: data.challenges } }),
        });
        return;
      }

      if (path === '/api/challenges' && method === 'POST') {
        const body = req.postDataJSON();
        const id = `c${data.challenges.length + 1}`;
        const created = challenge({
          id,
          title: body.title,
          description: body.description ?? null,
          startDate: `${body.startDate}T00:00:00.000Z`,
          endDate: `${body.endDate}T00:00:00.000Z`,
          maxMisses: body.maxMisses,
          progress: challengeProgress({
            challengeId: id,
            status: 'DRAFT',
            currentStatus: 'DRAFT',
            startDate: body.startDate,
            endDate: body.endDate,
            maxMisses: body.maxMisses,
            remainingMissAllowance: body.maxMisses,
          }),
        });
        data.challenges.unshift(created);
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'success', data: { challenge: created } }),
        });
        return;
      }

      const detailMatch = path.match(/^\/api\/challenges\/(c\d+)$/);
      if (detailMatch && method === 'GET') {
        const hit = data.challenges.find((item) => item.id === detailMatch[1]);
        if (!hit) {
          await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ status: 'error', message: 'Challenge not found.' }) });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'success', data: { challenge: hit } }),
        });
        return;
      }

      const commitMatch = path.match(/^\/api\/challenges\/(c\d+)\/commit$/);
      if (commitMatch && method === 'POST') {
        const hit = data.challenges.find((item) => item.id === commitMatch[1]);
        if (hit) {
          hit.status = 'ACTIVE';
          hit.committedAt = new Date().toISOString();
          hit.progress = { ...hit.progress, status: 'ACTIVE', currentStatus: 'ACTIVE' };
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'success', data: { challenge: hit } }),
        });
        return;
      }

      const evalMatch = path.match(/^\/api\/challenges\/(c\d+)\/evaluate$/);
      if (evalMatch && method === 'POST') {
        const hit = data.challenges.find((item) => item.id === evalMatch[1]);
        if (hit) {
          hit.status = 'FAILED';
          hit.failedAt = new Date().toISOString();
          hit.failReason = 'MISSES_EXCEEDED:1>0';
          hit.progress = {
            ...hit.progress,
            status: 'FAILED',
            currentStatus: 'FAILED',
            failureReason: 'MISSES_EXCEEDED:1>0',
            daysMissed: 1,
          };
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'success', data: { challenge: hit } }),
        });
        return;
      }

      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'error', message: `Unhandled mock route: ${method} ${path}` }),
      });
    });

    await page.goto(`${appBase}/challenges`);
    await page.waitForURL('**/challenges', { timeout: 10000 });

    await page.locator('h1:has-text("Habitra Challenges")').waitFor({ timeout: 10000 });
    check('challenges page renders title', await page.locator('h1:has-text("Habitra Challenges")').isVisible());
    check('challenges list renders existing cards', await page.getByText('Draft challenge').isVisible() && await page.getByText('Active challenge').isVisible());
    check('DRAFT challenge shows Commit action', await page.getByRole('button', { name: 'Commit' }).first().isVisible());
    check('ACTIVE challenge shows Evaluate action', await page.getByRole('button', { name: 'Evaluate' }).first().isVisible());

    await page.getByRole('button', { name: 'View details' }).first().click();
    await page.locator('h2:has-text("Challenge details")').waitFor({ timeout: 10000 });
    check('challenge details panel opens', await page.getByText('Days completed:').isVisible());

    await page.getByRole('button', { name: 'Create challenge' }).click();
    await page.locator('label:has-text("Title")').waitFor({ timeout: 10000 });
    await page.fill('#challenge-title', 'UI Created Challenge');
    await page.fill('#challenge-start', '2026-10-01');
    await page.fill('#challenge-end', '2026-10-10');
    await page.fill('#challenge-max-misses', '1');
    await page.getByRole('button', { name: 'Create challenge' }).click();
    await page.getByText('created.').waitFor({ timeout: 10000 });
    check('create challenge flow submits and refreshes list', await page.getByRole('heading', { name: 'UI Created Challenge' }).isVisible());

    await page.getByRole('button', { name: 'Commit' }).first().click();
    await page.getByText('committed.').waitFor({ timeout: 10000 });
    check('commit action updates challenge state', await page.getByText('ACTIVE').first().isVisible());

    await page.getByRole('button', { name: 'Evaluate' }).first().click();
    await page.getByText('evaluated.').waitFor({ timeout: 10000 });
    check('evaluate action updates status and reason', await page.getByText('MISSES_EXCEEDED:1>0').first().isVisible());

    await ctx.close();

    const failed = checks.filter((c) => !c.pass);
    if (failed.length > 0) {
      console.log(`\nChallenges UI test: ${failed.length}/${checks.length} checks FAILED`);
      process.exitCode = 1;
    } else {
      console.log(`\nChallenges UI test: ${checks.length}/${checks.length} checks PASSED`);
      process.exitCode = 0;
    }
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('challenges_ui_test failed:', err);
  process.exit(1);
});
