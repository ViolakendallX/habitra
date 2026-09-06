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
  const email = `agent-smoke-ui-${Date.now()}@example.com`;
  const password = 'Password123!';

  const register = await fetch(`${apiBase}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Agent Smoke User', email, password }),
  });

  if (!(register.ok || register.status === 409)) {
    throw new Error(`Register failed: HTTP ${register.status}`);
  }

  const login = await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!login.ok) {
    throw new Error(`Login failed: HTTP ${login.status}`);
  }

  const pair = cookiePair(login.headers.get('set-cookie'));
  if (!pair?.startsWith('habitra_auth=')) {
    throw new Error('Missing auth cookie in login response.');
  }

  return {
    email,
    token: pair.slice('habitra_auth='.length),
  };
}

async function run() {
  const { chromium } = await import('playwright-core');

  await waitForUrl(backendHealth);
  await waitForUrl(appBase);

  const { email, token } = await createAuthenticatedCookie();

  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  try {
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: 'habitra_auth',
        value: token,
        url: appBase,
      },
    ]);

    const page = await context.newPage();

    const requestUrls = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/agent/recommendation')) {
        requestUrls.push(request.url());
      }
    });

    await page.goto(`${appBase}/agent`);
    await page.getByRole('button', { name: 'Get my recommendation' }).click();

    await page.getByText('Your recommendation').waitFor({ timeout: 90000 });

    const message = (await page.locator('.agent-result__row').nth(0).locator('.agent-result__text').textContent())?.trim() || '';
    const recommendation = (await page.locator('.agent-result__row').nth(1).locator('.agent-result__text').textContent())?.trim() || '';
    const reason = (await page.locator('.agent-result__row').nth(2).locator('.agent-result__text').textContent())?.trim() || '';

    const noUserIdOverride = requestUrls.every((url) => !new URL(url).searchParams.has('userId'));

    if (!message || !recommendation || !reason) {
      throw new Error('Real recommendation content was empty.');
    }

    console.log('AGENT_UI_SMOKE_OK');
    console.log(`email=${email}`);
    console.log(`requestCount=${requestUrls.length}`);
    console.log(`noUserIdOverride=${noUserIdOverride}`);
    console.log(`message=${message.slice(0, 180)}`);
    console.log(`recommendation=${recommendation.slice(0, 180)}`);
    console.log(`reason=${reason.slice(0, 180)}`);
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('AGENT_UI_SMOKE_FAIL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
