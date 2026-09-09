import { setTimeout as delay } from 'node:timers/promises';

/**
 * Notifications UI test — real browser, real API, throwaway user.
 *
 * Seeds two habits with nothing recorded today (so both raise an "incomplete"
 * nudge) plus one committed challenge that started yesterday with maxMisses=2
 * (so yesterday counts as missed and the allowance drops to 1 -> urgent).
 *
 * Then it drives the bell through the real UI: count, panel contents, severity,
 * dismiss, Escape, click-outside, the post-completion refresh, both Settings
 * toggles, persistence across a reload, and "Clear all".
 *
 * The agent recommendation is never requested here — that endpoint calls the
 * model, and this feature must not poll it.
 */

// Vite's dev server binds IPv6 only, so localhost — not 127.0.0.1 — is correct.
const chromePath = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const appBase = process.env.APP_BASE_URL || 'http://localhost:5173';
const apiBase = process.env.API_BASE_URL || 'http://127.0.0.1:4000/api';
const backendHealth = process.env.BACKEND_HEALTH_URL || 'http://127.0.0.1:4000/health';

const HABIT_A = 'Notification habit A';
const HABIT_B = 'Notification habit B';
const CHALLENGE_TITLE = 'Notification test challenge';

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

/** Polls `read` until it returns a truthy value, or fails the check. */
async function waitFor(read, timeoutMs = 20000) {
  const start = Date.now();
  let last = null;

  while (Date.now() - start < timeoutMs) {
    last = await read();
    if (last) return last;
    await delay(250);
  }

  return last;
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
    body: { name: HABIT_A, frequency: 'DAILY', target: 1 },
    cookie,
  });
  const firstId = first.json?.data?.habit?.id ?? first.json?.habit?.id ?? null;

  await apiRequest('/habits', {
    method: 'POST',
    body: { name: HABIT_B, frequency: 'DAILY', target: 1 },
    cookie,
  });

  // Started yesterday with maxMisses=2: yesterday is a closed day with no
  // record, so daysMissed=1 and remainingMissAllowance=1 -> urgent.
  const challenge = await apiRequest('/challenges', {
    method: 'POST',
    body: {
      title: CHALLENGE_TITLE,
      startDate: utcDay(-1),
      endDate: utcDay(5),
      maxMisses: 2,
      habitId: firstId,
    },
    cookie,
  });

  const challengeId =
    challenge.json?.data?.challenge?.id ?? challenge.json?.challenge?.id ?? null;

  if (challengeId) {
    await apiRequest(`/challenges/${challengeId}/commit`, { method: 'POST', cookie });
  }

  return { habitAId: firstId, challengeId };
}

async function run() {
  const { chromium } = await import('playwright-core');

  await waitForUrl(backendHealth);
  await waitForUrl(appBase);

  const email = `notifications-ui-${Date.now()}@example.com`;
  const password = 'Password123!';

  const register = await apiRequest('/auth/register', {
    method: 'POST',
    body: { name: 'Noti Fication', email, password },
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

    const bell = page.locator('.notifications__bell');
    const badge = page.locator('.notifications__badge');
    const panel = page.locator('.notifications__panel');
    const items = page.locator('.notifications__item');

    const badgeText = () => badge.first().textContent().catch(() => null);

    await page.goto(`${appBase}/dashboard`);
    await bell.waitFor({ timeout: 30000 });

    // 1. Bell + unread indicator
    check('bell rendered in the navbar', (await bell.count()) === 1);
    const initialLabel = await bell.getAttribute('aria-label');
    check('bell is labelled', typeof initialLabel === 'string' && initialLabel.length > 0, String(initialLabel));

    const initialBadge = await waitFor(async () => {
      const text = await badgeText();
      return text === '3' ? text : null;
    });
    const countedLabel = await bell.getAttribute('aria-label');
    check('unread badge counts all three notifications', initialBadge === '3', String(initialBadge));
    check('aria-label reflects the unread count', /3 unread/.test(String(countedLabel)), String(countedLabel));
    check('bell reports collapsed state', (await bell.getAttribute('aria-expanded')) === 'false');

    // 2. Panel contents
    await bell.click();
    await panel.waitFor({ timeout: 15000 });
    check('panel opens', (await panel.count()) === 1);
    check('aria-expanded is true when open', (await bell.getAttribute('aria-expanded')) === 'true');
    check('panel is a dialog', (await panel.getAttribute('role')) === 'dialog');
    check('three notifications listed', (await items.count()) === 3, String(await items.count()));

    const panelText = (await panel.textContent())?.replace(/\s+/g, ' ') ?? '';
    check('incomplete habit A listed', panelText.includes(`${HABIT_A} is still open`), panelText.slice(0, 160));
    check('incomplete habit B listed', panelText.includes(`${HABIT_B} is still open`));
    check('challenge at risk listed', panelText.includes(`${CHALLENGE_TITLE} is at risk`));
    check('challenge message uses the backend allowance', /Only 1 miss left/.test(panelText), panelText.slice(0, 240));

    // 3. Severity + ordering: urgent first
    const urgent = page.locator('.notifications__item--urgent');
    check('one urgent notification', (await urgent.count()) === 1, String(await urgent.count()));
    const urgentText = (await urgent.first().textContent()) ?? '';
    check('urgent one is the challenge', urgentText.includes(CHALLENGE_TITLE));
    const firstItemClass = await items.first().getAttribute('class');
    check('urgent sorts first', /notifications__item--urgent/.test(String(firstItemClass)), String(firstItemClass));
    check('normal notifications present', (await page.locator('.notifications__item--normal').count()) === 2);

    // 4. Dismiss a single notification
    await page.locator('.notifications__dismiss').first().click();
    await delay(400);
    check('dismissing removes one item', (await items.count()) === 2, String(await items.count()));
    check('dismissed item was the urgent one', (await urgent.count()) === 0);
    check('badge follows the dismiss', (await badgeText()) === '2', String(await badgeText()));

    // 5. Escape closes the panel
    await page.keyboard.press('Escape');
    await delay(300);
    check('Escape closes the panel', (await panel.count()) === 0);

    // 6. Clicking outside closes the panel
    await bell.click();
    await panel.waitFor({ timeout: 10000 });
    await page.locator('.shell__title').first().click();
    await delay(300);
    check('click outside closes the panel', (await panel.count()) === 0);

    // 7. Completing a habit refreshes the list (Habits page -> refresh())
    await page.locator('.navbar__link', { hasText: 'Habits' }).first().click();
    await page.waitForURL('**/habits', { timeout: 15000 });
    await page.locator('.habit').first().waitFor({ timeout: 30000 });

    const habitRow = page.locator('.habit', { hasText: HABIT_A }).first();
    await habitRow.getByRole('button', { name: 'Completed' }).click();

    const afterCompletion = await waitFor(async () => {
      const text = await badgeText();
      return text === '1' ? text : null;
    }, 25000);
    check('completing a habit drops its notification', afterCompletion === '1', String(afterCompletion));

    // 8. Settings toggles
    await page.locator('.navbar__link', { hasText: 'Settings' }).first().click();
    await page.waitForURL('**/settings', { timeout: 15000 });
    await page.getByText('Notifications', { exact: false }).first().waitFor();

    check('settings shows the account email', (await page.locator('.settings__row').first().count()) === 1);
    const settingsText = (await page.locator('main').textContent())?.replace(/\s+/g, ' ') ?? '';
    check('account email rendered', settingsText.includes(email), email);
    check('about section rendered', /Habitra/.test(settingsText) && /Autonomous accountability that remembers/.test(settingsText));

    const notificationsToggle = page.locator('.settings__toggle input').first();
    const soundToggle = page.locator('.settings__toggle input').nth(1);

    check('exactly two toggles', (await page.locator('.settings__toggle input').count()) === 2);
    check('notifications toggle starts on', await notificationsToggle.isChecked());
    check('sound toggle starts off', !(await soundToggle.isChecked()));

    await notificationsToggle.uncheck();
    await delay(500);
    check('turning notifications off hides the badge', (await badge.count()) === 0);

    await bell.click();
    await panel.waitFor({ timeout: 10000 });
    check('panel says notifications are off', /turned off/i.test((await panel.textContent()) ?? ''));
    await page.keyboard.press('Escape');
    await delay(200);

    await notificationsToggle.check();
    await delay(800);
    check('turning notifications on restores the badge', (await badgeText()) === '1', String(await badgeText()));

    await soundToggle.check();
    await delay(300);
    check('sound toggle turns on', await soundToggle.isChecked());

    // 9. Preferences survive a reload (browser storage, nothing sensitive)
    await page.reload();
    await bell.waitFor({ timeout: 30000 });
    const afterReload = await waitFor(async () => {
      const text = await badgeText();
      return text === '1' ? text : null;
    });
    check('preferences persist across reload', afterReload === '1', String(afterReload));

    const stored = await page.evaluate(() => window.localStorage.getItem('habitra.notifications.v1'));
    check('storage uses the versioned key', typeof stored === 'string' && stored.length > 0, String(stored));
    check('storage holds no email or token', !/Noti|@example\.com|habitra_auth/.test(String(stored)), String(stored));

    // 10. Clear all
    await bell.click();
    await panel.waitFor({ timeout: 10000 });
    await panel.getByRole('button', { name: 'Clear all' }).click();
    await delay(500);
    check('clear all empties the panel', (await items.count()) === 0, String(await items.count()));
    check('empty state shown', /all caught up/i.test((await panel.textContent()) ?? ''));
    check('badge gone after clearing', (await badge.count()) === 0);

    // 11. Navigation still works
    await page.keyboard.press('Escape');
    await page.locator('.navbar__link', { hasText: 'Dashboard' }).first().click();
    await page.waitForURL('**/dashboard', { timeout: 15000 });
    check('nav still reaches the dashboard', page.url().endsWith('/dashboard'), page.url());

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
  console.error('NOTIFICATIONS_UI_FAIL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
