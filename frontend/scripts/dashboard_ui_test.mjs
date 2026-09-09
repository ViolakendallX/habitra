import { setTimeout as delay } from 'node:timers/promises';

/**
 * Dashboard UI test — real browser, real API, throwaway user.
 *
 * Seeds a user with two habits (one completed today) and one committed
 * challenge, loads /dashboard and asserts the sections render from live data.
 * It also fails on any browser console error, page error, or 5xx response,
 * and checks the shared navigation still works from the dashboard.
 *
 * The AI insight button is only clicked when DASHBOARD_CLICK_INSIGHT=1, so the
 * default run never triggers a model call.
 */

// Vite's dev server binds IPv6 only, so localhost — not 127.0.0.1 — is correct.
const chromePath = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const appBase = process.env.APP_BASE_URL || 'http://localhost:5173';
const apiBase = process.env.API_BASE_URL || 'http://127.0.0.1:4000/api';
const backendHealth = process.env.BACKEND_HEALTH_URL || 'http://127.0.0.1:4000/health';
const clickInsight = process.env.DASHBOARD_CLICK_INSIGHT === '1';

const checks = [];

function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail });
}

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

function cookiePair(setCookieHeader) {
  if (!setCookieHeader) return null;
  return setCookieHeader.split(';')[0] || null;
}

function utcDay(offsetDays = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

async function apiRequest(path, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  return { status: res.status, json };
}

async function seed(cookie) {
  const first = await apiRequest('/habits', {
    method: 'POST',
    body: { name: 'Morning run', frequency: 'DAILY', target: 1 },
    cookie,
  });
  const firstId = first.json?.data?.habit?.id ?? first.json?.habit?.id ?? null;

  await apiRequest('/habits', {
    method: 'POST',
    body: { name: 'Read 20 pages', frequency: 'DAILY', target: 1 },
    cookie,
  });

  if (firstId) {
    await apiRequest(`/habits/${firstId}/completions`, {
      method: 'POST',
      body: { date: utcDay(0), status: 'COMPLETED' },
      cookie,
    });
  }

  const challenge = await apiRequest('/challenges', {
    method: 'POST',
    body: {
      title: 'Dashboard test challenge',
      startDate: utcDay(-1),
      endDate: utcDay(5),
      maxMisses: 1,
      habitId: firstId,
    },
    cookie,
  });

  const challengeId =
    challenge.json?.data?.challenge?.id ?? challenge.json?.challenge?.id ?? null;

  if (challengeId) {
    await apiRequest(`/challenges/${challengeId}/commit`, { method: 'POST', cookie });
  }

  return { habitId: firstId, challengeId };
}

async function run() {
  const { chromium } = await import('playwright-core');

  await waitForUrl(backendHealth);
  await waitForUrl(appBase);

  // The login response sets the session cookie; reuse exactly that header.
  const email = `dashboard-ui-${Date.now()}@example.com`;
  const password = 'Password123!';

  const register = await apiRequest('/auth/register', {
    method: 'POST',
    body: { name: 'Dash Board', email, password },
  });

  if (!(register.status === 201 || register.status === 200 || register.status === 409)) {
    throw new Error(`Register failed: HTTP ${register.status}`);
  }

  const loginRes = await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!loginRes.ok) {
    throw new Error(`Login failed: HTTP ${loginRes.status}`);
  }

  const pair = cookiePair(loginRes.headers.get('set-cookie'));
  if (!pair?.startsWith('habitra_auth=')) {
    throw new Error('Missing auth cookie in login response.');
  }

  const cookie = pair;
  const token = pair.slice('habitra_auth='.length);

  await seed(cookie);

  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  try {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'habitra_auth', value: token, url: appBase }]);

    const page = await context.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    const serverErrors = [];

    page.on('console', (message) => {
      // Chrome always asks for /favicon.ico and index.html declares none, so
      // that 404 is a browser default request, not an application error.
      const source = message.location()?.url ?? '';
      if (message.type() === 'error' && !/favicon\.ico/.test(source)) {
        consoleErrors.push(`${message.text()} (${source})`);
      }
    });
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('response', (response) => {
      if (response.status() >= 500) {
        serverErrors.push(`${response.status()} ${response.url()}`);
      }
    });

    await page.goto(`${appBase}/dashboard`);
    await page.getByText("Today's progress").waitFor({ timeout: 30000 });

    // Sections render their headings immediately and fill in after the API
    // round trips finish, so wait for the loaded state before asserting.
    await page.locator('.today').waitFor({ state: 'visible', timeout: 60000 });
    await page.locator('.habit-card').first().waitFor({ state: 'visible', timeout: 60000 });
    await page.locator('.bees').waitFor({ state: 'visible', timeout: 60000 });

    // 1. Greeting / header
    const heading = (await page.locator('.shell__title').first().textContent())?.trim() ?? '';
    check('greeting addresses the user', /Good (morning|afternoon|evening), Dash Board/.test(heading), heading);

    // 2. Today's progress
    const ring = page.locator('.progress-ring');
    check('progress ring rendered', (await ring.count()) === 1);
    const progressText =
      (await page.locator('.today__count').first().textContent())?.replace(/\s+/g, ' ').trim() ?? '';
    check('today progress reads 1 of 2', /1 of 2 completed/.test(progressText), progressText);

    // 3. Week selector
    const days = page.locator('.weekstrip__day');
    check('week selector shows 7 days', (await days.count()) === 7, String(await days.count()));
    const todayCells = page.locator('.weekstrip__day--today');
    check('current day is highlighted', (await todayCells.count()) === 1);
    const selectedCells = page.locator('.weekstrip__day--selected');
    check('today is selected by default', (await selectedCells.count()) === 1);

    // 4/5. Habit cards
    const cards = page.locator('.habit-card');
    check('two habit cards rendered', (await cards.count()) === 2, String(await cards.count()));
    const cardText = (await cards.first().textContent())?.replace(/\s+/g, ' ') ?? '';
    check('habit card shows frequency + target', /Daily · target 1/.test(cardText), cardText.slice(0, 120));
    const completedBadges = page.locator('.habit-card .badge--ok');
    check('completed habit shows a done badge', (await completedBadges.count()) >= 1);
    const pendingBadges = page.locator('.habit-card .badge', { hasText: 'Not recorded yet' });
    check('unrecorded habit shows its state', (await pendingBadges.count()) >= 1);
    check('habit card shows streak info', /Streak:/.test(cardText), cardText.slice(0, 160));

    // 6. Active challenge
    const challengeCard = page.locator('.card', { hasText: 'Active challenge' }).first();
    const challengeText = (await challengeCard.textContent())?.replace(/\s+/g, ' ') ?? '';
    check('active challenge title shown', /Dashboard test challenge/.test(challengeText));
    check('challenge progress bar rendered', (await challengeCard.locator('.progress-bar').count()) === 1);
    check('challenge stats rendered', /Completed:/.test(challengeText) && /Allowance:/.test(challengeText));

    // 7. BEES
    const beesCard = page.locator('.card', { hasText: 'BEES' }).first();
    const beesText = (await beesCard.textContent())?.replace(/\s+/g, ' ') ?? '';
    check('BEES section rendered', /BEES/.test(beesText));
    check('BEES mentions wallet + chain', /Wallet:/.test(beesText) && /Chain:/.test(beesText));

    // 8. AI accountability
    const aiCard = page.locator('.card', { hasText: 'AI accountability' }).first();
    check('AI section present', (await aiCard.count()) === 1);
    const insightButton = aiCard.getByRole('button', { name: 'Get latest insight' });
    check('AI insight action present', (await insightButton.count()) === 1);

    if (clickInsight) {
      await insightButton.click();
      await aiCard.locator('.insight').waitFor({ timeout: 90000 });
      const insightText = (await aiCard.locator('.insight').textContent()) ?? '';
      check('insight rendered after click', insightText.length > 20);
      check('memory signal shown', /Memory (used|not used)/.test(insightText));
    }

    // 9. Links to the other pages
    for (const [label, path] of [
      ['Habits', '/habits'],
      ['Challenges', '/challenges'],
      ['Agent', '/agent'],
      ['Wallet', '/wallet'],
    ]) {
      const link = page.locator('.dashboard__actions a', { hasText: label }).first();
      const href = await link.getAttribute('href');
      check(`dashboard links to ${path}`, href === path, String(href));
    }

    // Navigation still works from the dashboard.
    await page.locator('.navbar__link', { hasText: 'Habits' }).first().click();
    await page.waitForURL('**/habits', { timeout: 15000 });
    check('nav goes to /habits', page.url().endsWith('/habits'), page.url());

    await page.locator('.navbar__link', { hasText: 'Dashboard' }).first().click();
    await page.waitForURL('**/dashboard', { timeout: 15000 });
    await page.getByText('My habits').first().waitFor({ timeout: 15000 });
    check('nav returns to /dashboard', page.url().endsWith('/dashboard'), page.url());

    check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
    check('no 5xx responses', serverErrors.length === 0, serverErrors.join(' | '));
  } finally {
    await browser.close();
  }

  const failed = checks.filter((item) => !item.ok);

  for (const item of checks) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
  }

  console.log(`checks=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`);
  console.log(`email=${email}`);

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error('DASHBOARD_UI_FAIL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
