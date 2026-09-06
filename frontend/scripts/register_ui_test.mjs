import { setTimeout as delay } from 'node:timers/promises';

const chromePath = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const appBase = process.env.APP_BASE_URL || 'http://127.0.0.1:5173';
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

async function run() {
  const { chromium } = await import('playwright-core');

  const checks = [];
  function check(name, pass, detail = '') {
    checks.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}`);
  }

  let browser;
  try {
    await waitForUrl(backendHealth);
    await waitForUrl(appBase);

    browser = await chromium.launch({
      headless: true,
      executablePath: chromePath,
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    // 1) registration page renders
    await page.goto(`${appBase}/register`);
    await page.waitForLoadState('domcontentloaded');
    check('registration page renders', await page.getByRole('heading', { name: 'Create account' }).isVisible());

    // 2) unauthenticated can access /register
    check('unauthenticated users can access /register', page.url().includes('/register'));

    // 3) invalid/missing fields handled
    await page.getByRole('button', { name: 'Create account' }).click();
    check('missing fields show client errors',
      await page.getByText('Name is required.').isVisible()
      && await page.getByText('Email is required.').isVisible()
      && await page.getByText('Password is required.').isVisible());

    // 4) password mismatch client-side
    await page.locator('#name').fill('Mismatch User');
    await page.locator('#email').fill('mismatch@example.com');
    await page.locator('#password').fill('Password123!');
    await page.locator('#confirmPassword').fill('DifferentPass123!');
    await page.getByRole('button', { name: 'Create account' }).click();
    check('password mismatch rejected client-side', await page.getByText('Passwords do not match.').isVisible());

    // 5) valid registration submits + redirects dashboard + protected-route behavior
    const freshEmail = `reg-ui-${Date.now()}@example.com`;
    await page.locator('#name').fill('Fresh User');
    await page.locator('#email').fill(freshEmail);
    await page.locator('#password').fill('Password123!');
    await page.locator('#confirmPassword').fill('Password123!');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForURL('**/dashboard', { timeout: 15000 });
    check('valid registration submits and redirects to dashboard', page.url().includes('/dashboard'));

    // logout to retest protected route
    await context.clearCookies();
    await page.goto(`${appBase}/dashboard`);
    await page.waitForURL('**/login', { timeout: 10000 });
    check('protected-route behavior remains intact', page.url().includes('/login'));

    // 6) duplicate-email error displayed
    await page.goto(`${appBase}/register`);
    await page.locator('#name').fill('Dup User');
    await page.locator('#email').fill(freshEmail);
    await page.locator('#password').fill('Password123!');
    await page.locator('#confirmPassword').fill('Password123!');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForTimeout(300);
    const dupAlertText = ((await page.locator('.alert--error').textContent()) || '').trim();
    check('duplicate email error shown',
      dupAlertText.includes('already exists') || dupAlertText.includes('account with this email'),
      dupAlertText);

    // 7) loading state while submit (quick check)
    const quickEmail = `reg-ui-load-${Date.now()}@example.com`;
    await page.locator('#name').fill('Load User');
    await page.locator('#email').fill(quickEmail);
    await page.locator('#password').fill('Password123!');
    await page.locator('#confirmPassword').fill('Password123!');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForTimeout(50);
    const label = await page.locator('button[type="submit"]').textContent();
    check('submit shows loading state', (label || '').includes('Creating account'));

    await page.waitForURL('**/dashboard', { timeout: 15000 });

    const failed = checks.filter((c) => !c.pass);
    if (failed.length > 0) {
      console.log(`\nRegister UI test: ${failed.length}/${checks.length} checks FAILED`);
      process.exitCode = 1;
    } else {
      console.log(`\nRegister UI test: ${checks.length}/${checks.length} checks PASSED`);
      process.exitCode = 0;
    }
  } finally {
    if (browser) await browser.close();
  }
}

run().catch((err) => {
  console.error('register_ui_test failed:', err);
  process.exit(1);
});
