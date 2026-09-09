import { setTimeout as delay } from 'node:timers/promises';

const chromePath = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const appBase = process.env.APP_BASE_URL || 'http://127.0.0.1:5173';
const apiBase = process.env.API_BASE_URL || 'http://127.0.0.1:4000/api';
const backendHealth = process.env.BACKEND_HEALTH_URL || 'http://127.0.0.1:4000/health';

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

async function createAuthenticatedCookie() {
  const email = `agent-ui-${Date.now()}@example.com`;
  const password = 'Password123!';

  await fetch(`${apiBase}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Agent UI Test User', email, password }),
  });

  const login = await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!login.ok) {
    throw new Error(`Failed to login test user: HTTP ${login.status}`);
  }

  const pair = cookiePair(login.headers.get('set-cookie'));
  if (!pair?.startsWith('habitra_auth=')) {
    throw new Error('Missing auth cookie in login response.');
  }

  return pair.slice('habitra_auth='.length);
}

async function run() {
  const { chromium } = await import('playwright-core');

  const checks = [];
  function check(name, pass, detail = '') {
    checks.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}`);
  }

  /**
   * Assert that a locator becomes visible, waiting up to `timeout` first.
   *
   * A bare `isVisible()` is a one-shot DOM read: right after a click React has
   * only just switched to its loading state, so the previous error text is
   * already unmounted and the new one has not been rendered yet — the read
   * lands in that gap and reports false. Waiting still requires the exact same
   * text to appear; it just stops sampling the DOM in the middle of a render.
   */
  async function checkVisible(name, locator, timeout = 5000) {
    try {
      await locator.waitFor({ state: 'visible', timeout });
      check(name, true);
    } catch {
      check(name, false, `text did not become visible within ${timeout}ms`);
    }
  }

  await waitForUrl(backendHealth);
  await waitForUrl(appBase);

  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  try {
    // protected-route behavior (unauthenticated)
    const anonContext = await browser.newContext();
    const anonPage = await anonContext.newPage();
    await anonPage.goto(`${appBase}/agent`);
    await anonPage.waitForURL('**/login', { timeout: 10000 });
    check('protected-route behavior for /agent remains intact', anonPage.url().includes('/login'));
    await anonContext.close();

    // authenticated context
    const token = await createAuthenticatedCookie();
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: 'habitra_auth',
        value: token,
        url: appBase,
      },
    ]);

    const page = await context.newPage();
    await page.goto(`${appBase}/agent`);

    await page.waitForURL('**/agent', { timeout: 10000 });
    await page.locator('h1:has-text("Habitra Agent")').waitFor({ timeout: 10000 });
    check('authenticated access to /agent works', page.url().includes('/agent'));
    check('agent page renders heading', await page.locator('h1:has-text("Habitra Agent")').isVisible());
    check('recommendation button appears', await page.getByRole('button', { name: 'Get my recommendation' }).isVisible());

    let scenario = 'success_true';
    const requestUrls = [];

    await page.route('**/api/agent/recommendation*', async (route) => {
      const request = route.request();
      requestUrls.push(request.url());

      if (scenario === 'network_error') {
        await route.abort('failed');
        return;
      }

      if (scenario === 'error_503') {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'error', message: 'Agent is not configured.' }),
        });
        return;
      }

      if (scenario === 'error_502') {
        await route.fulfill({
          status: 502,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'error', message: 'Unable to generate recommendation right now.' }),
        });
        return;
      }

      if (scenario === 'success_false') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'success',
            data: {
              recommendation: {
                message: 'Stay consistent today.',
                recommendation: 'Do one easy habit now.',
                reason: 'Momentum is more important than intensity.',
                memoryUsed: false,
                generatedAt: '2026-09-06T08:00:00.000Z',
              },
            },
          }),
        });
        return;
      }

      await delay(350);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'success',
          data: {
            recommendation: {
              message: 'Great recovery trend this week.',
              recommendation: 'Complete your shortest habit first this morning.',
              reason: 'You are most consistent when you start with a quick win.',
              memoryUsed: true,
              generatedAt: '2026-09-06T07:45:00.000Z',
            },
          },
        }),
      });
    });

    // loading + success (memoryUsed=true)
    await page.getByRole('button', { name: 'Get my recommendation' }).click();
    check('loading state is shown', await page.locator('.agent-card__loading').isVisible());
    check('button disabled while loading', await page.getByRole('button', { name: 'Habitra is thinking...' }).isDisabled());

    await page.getByText('Your recommendation').waitFor({ timeout: 10000 });
    check('successful recommendation is displayed',
      await page.getByText('Great recovery trend this week.').isVisible()
      && await page.getByText('Complete your shortest habit first this morning.').isVisible()
      && await page.getByText('You are most consistent when you start with a quick win.').isVisible());
    check('memoryUsed=true display is understandable',
      await page.getByText('Memory used').isVisible()
      && await page.getByText('Based on what Habitra remembers').isVisible());

    // memoryUsed=false
    scenario = 'success_false';
    await page.getByRole('button', { name: 'Get my recommendation' }).click();
    await page.getByText('Do one easy habit now.').waitFor({ timeout: 10000 });
    check('memoryUsed=false display is understandable',
      await page.getByText('Memory not used').isVisible()
      && await page.getByText('no remembered context used this time').isVisible());

    // 502
    scenario = 'error_502';
    await page.getByRole('button', { name: 'Get my recommendation' }).click();
    await checkVisible('502 handled with useful message', page.getByText('could not generate a recommendation right now'));

    // 503
    scenario = 'error_503';
    await page.getByRole('button', { name: 'Get my recommendation' }).click();
    await checkVisible('503 handled with configuration message', page.getByText('agent is not configured yet'));

    // network
    scenario = 'network_error';
    await page.getByRole('button', { name: 'Get my recommendation' }).click();
    await checkVisible('network failure handled gracefully', page.getByText('Unable to reach the server'));

    const noUserIdOverride = requestUrls.every((url) => !new URL(url).searchParams.has('userId'));
    check('recommendation request does not send userId override', noUserIdOverride);

    await context.close();

    const failed = checks.filter((c) => !c.pass);
    if (failed.length > 0) {
      console.log(`\nAgent UI test: ${failed.length}/${checks.length} checks FAILED`);
      process.exitCode = 1;
    } else {
      console.log(`\nAgent UI test: ${checks.length}/${checks.length} checks PASSED`);
      process.exitCode = 0;
    }
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('agent_ui_test failed:', err);
  process.exit(1);
});
