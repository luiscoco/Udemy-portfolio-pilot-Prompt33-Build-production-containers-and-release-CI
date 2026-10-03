import { expect, test } from '@playwright/test';
import { closeConnections, getDatabase } from '@portfolio-pilot/db';
import { e2eDatabaseUrl, isDisposableDatabase } from './support/env';

// Authentication expiry in the browser (milestone 31). The session row expires in PostgreSQL (the
// server's truth); the browser clock is controlled so the 30-second session refresh happens now
// instead of after a real wait. Only this browser's session is expired.
const url = e2eDatabaseUrl('PORTFOLIO_E2E_DATABASE_URL');

test.describe('session expiry', () => {
  test.skip(!url, 'Run through `npm run test:browser` (needs the database behind the API).');
  test.afterAll(async () => { await closeConnections(); });

  test('an expired server session signs the browser out, clears account data and rejects the old cookie', async ({ page, browser }) => {
    test.setTimeout(60000);
    if (!isDisposableDatabase(url!)) throw new Error('Disposable loopback test database required.');
    const db = await getDatabase(url!);
    await page.clock.install();
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in as Alice Demo' }).click();
    const holdings = page.getByRole('table', { name: 'Portfolio holdings' });
    await expect(holdings).toBeVisible();
    await expect(page.getByRole('region', { name: 'Authenticated session' })).toContainText('Alice Demo');

    const cookie = (await page.context().cookies()).find(c => c.name === 'better-auth.session_token');
    expect(cookie, 'signed session cookie').toBeTruthy();
    const token = decodeURIComponent(cookie!.value).split('.')[0]!;
    // Another, still valid session of the same user (a second device) must be unaffected.
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await otherPage.goto('/'); await otherPage.getByRole('button', { name: 'Sign in as Alice Demo' }).click();
    await expect(otherPage.getByRole('table', { name: 'Portfolio holdings' })).toBeVisible();
    try {
      expect((await db.session.updateMany({ where: { token }, data: { expiresAt: new Date(Date.now() - 1000) } })).count).toBe(1);
      await page.clock.fastForward('00:31');
      await expect(page.getByRole('heading', { name: 'Sign in to PortfolioPilot', exact: true })).toBeVisible({ timeout: 15000 });
      await expect(holdings).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Authenticated session' })).toHaveCount(0);
      await expect(page.getByLabel('Update connection')).toHaveCount(0);
      expect((await page.request.get('/api/portfolios')).status()).toBe(401);
      expect((await page.request.get('/api/me')).status()).toBe(401);
      // The other session still works, and signing in again restores access in this browser.
      expect((await other.request.get('/api/portfolios')).status()).toBe(200);
      await page.getByRole('button', { name: 'Sign in as Alice Demo' }).click();
      await expect(holdings).toBeVisible();
    } finally {
      await other.close();
    }
  });
});
