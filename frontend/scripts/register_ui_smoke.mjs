const chromePath = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const appBase = process.env.APP_BASE_URL || 'http://127.0.0.1:5173';

async function run() {
  const { chromium } = await import('playwright-core');

  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    const freshEmail = `reg-smoke-${Date.now()}@example.com`;

    await page.goto(`${appBase}/register`);
    await page.locator('#name').fill('Smoke Register User');
    await page.locator('#email').fill(freshEmail);
    await page.locator('#password').fill('Password123!');
    await page.locator('#confirmPassword').fill('Password123!');

    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForURL('**/dashboard', { timeout: 15000 });

    const cookiePresent = (await context.cookies()).some((c) => c.name === 'habitra_auth');

    console.log('REGISTER_SMOKE_OK');
    console.log(`email=${freshEmail}`);
    console.log(`dashboard=${page.url().includes('/dashboard')}`);
    console.log(`authCookiePresent=${cookiePresent}`);
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('REGISTER_SMOKE_FAIL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
