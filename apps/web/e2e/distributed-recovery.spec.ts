import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

/**
 * Milestone 30 UI states during dependency outages, through the two-replica proxy topology
 * (`node scripts/distributed-local.mjs`). Gated: it stops and restarts the DEDICATED verification
 * containers named below, never the shared development services.
 */
const baseURL = process.env.DISTRIBUTED_UI_BASE_URL;
const pg = process.env.DISTRIBUTED_PG_CONTAINER, redis = process.env.DISTRIBUTED_REDIS_CONTAINER;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' });
test.skip(!baseURL || !pg || !redis, 'Set DISTRIBUTED_UI_BASE_URL, DISTRIBUTED_PG_CONTAINER and DISTRIBUTED_REDIS_CONTAINER.');
test.use({ baseURL: baseURL ?? 'http://127.0.0.1:5320' });
test.afterAll(() => { if (pg && redis) { docker('start', redis); docker('start', pg); } });

test('outages show what still works, keep the session, and clear after recovery', async ({ page }) => {
  test.setTimeout(480000);
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in as Alice Demo' }).click();
  await expect(page.getByRole('heading', { name: 'Portfolio overview' })).toBeVisible();
  await expect(page.getByLabel('Update connection')).toContainText('Live', { timeout: 20000 });
  await expect(page.locator('[data-service-state]')).toHaveCount(0);

  docker('stop', redis!);
  const events = page.locator('[data-service-state="events"]');
  await expect(events).toContainText('Live updates are paused', { timeout: 40000 });
  await expect(events).toContainText('assistant answers still finish and are saved');
  await expect(page.getByLabel('Update connection')).not.toContainText('Live', { timeout: 30000 });
  // Saved data still loads from PostgreSQL while live delivery is down.
  await page.getByRole('link', { name: 'Portfolios', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your portfolios' })).toBeVisible();
  await page.screenshot({ path: 'test-results/m30-redis-outage.png', fullPage: true });
  docker('start', redis!);
  await expect(events).toHaveCount(0, { timeout: 40000 });
  await expect(page.getByLabel('Update connection')).toContainText('Live', { timeout: 40000 });

  docker('stop', pg!);
  const database = page.locator('[data-service-state="database"]');
  await expect(database).toContainText('Saved data is temporarily unavailable', { timeout: 40000 });
  await expect(database).toContainText('nothing is partially saved');
  await expect(database).toHaveAttribute('role', 'alert');
  // Outlast the 30 s session refresh: an outage must not look like a sign-out.
  await page.waitForTimeout(35000);
  await expect(page.getByRole('region', { name: 'Authenticated session' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in to PortfolioPilot' })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/m30-database-outage.png', fullPage: true });
  docker('start', pg!);
  await expect(database).toHaveCount(0, { timeout: 90000 });
  await page.getByRole('link', { name: 'Portfolios', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your portfolios' })).toBeVisible();
});
