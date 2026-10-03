import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { closeConnections, getDatabase } from '@portfolio-pilot/db';
import { e2eDatabaseUrl, isDisposableDatabase, ORIGIN } from './support/env';

// New article -> recommendation, end to end through background processes only (milestone 31).
// The article enters through the ingestion CLI (same repository path as provider polling). Nothing
// in this test dispatches the outbox or runs analysis: the harness's outbox worker must claim the
// event, run the mock article analysis, generate owner-specific recommendations, evaluate the alert
// rule and publish the owner notification, which reaches the open page over SSE without a reload.
const exec = promisify(execFile);
const url = e2eDatabaseUrl('ALERT_E2E_DATABASE_URL');
const injector = fileURLToPath(new URL('../../worker/dist/inject-fixture.js', import.meta.url));

test.describe('new article to recommendation', () => {
  test.skip(!url, 'Run through `npm run test:browser` (needs the running outbox worker).');
  test.afterAll(async () => { await closeConnections(); });

  test('an ingested article becomes a live, cited recommendation and alert for the holder only, once', async ({ page, browser }) => {
    test.setTimeout(120000);
    if (!isDisposableDatabase(url!)) throw new Error('Disposable loopback test database required.');
    const db = await getDatabase(url!);
    const run = `e2e-rec-${crypto.randomUUID().slice(0, 8)}`;
    const inject = () => exec(process.execPath, [injector, run, '1'], { env: { ...process.env, NODE_ENV: 'development', DATA_MODE: 'mock', DATABASE_URL: url! } });
    const bob = await browser.newContext();
    try {
      // Alice holds NOVA (seed portfolio "Long term"); Bob holds only ACME.
      await page.goto('/research'); await page.getByRole('button', { name: 'Sign in as Alice Demo' }).click();
      await page.getByRole('link', { name: 'Research & alerts' }).click();
      await page.getByLabel('Rule name', { exact: true }).fill(run);
      await page.getByRole('listbox', { name: 'Watched securities' }).selectOption('demo-nova');
      await page.getByLabel('Cooldown seconds', { exact: true }).fill('0');
      await page.getByRole('button', { name: 'Create alert rule' }).click();
      await expect(page.getByRole('button', { name: `Edit ${run}` })).toBeVisible();
      await expect(page.getByLabel('Update connection')).toContainText('Live');
      const bobPage = await bob.newPage();
      await bobPage.goto('/research'); await bobPage.getByRole('button', { name: 'Sign in as Bob Demo' }).click();
      await expect(bobPage.getByRole('region', { name: 'Configurable alerts' })).toBeVisible();

      await inject();
      const notice = page.getByRole('article', { name: 'Alert notification', exact: true }).filter({ hasText: run });
      await expect(notice).toHaveCount(1, { timeout: 45000 });
      await expect(notice).toContainText('New');

      const article = await db.newsSource.findUniqueOrThrow({ where: { provider_recordId: { provider: 'development-fixture', recordId: run } } });
      const notification = await db.alertNotification.findFirstOrThrow({ where: { ownerId: 'demo-alice', articleId: article.articleId } });
      expect(notification.recommendationIds.length).toBeGreaterThan(0);
      const recommendation = await db.recommendation.findUniqueOrThrow({ where: { id: notification.recommendationIds[0]! } });
      expect(recommendation).toMatchObject({ ownerId: 'demo-alice', articleId: article.articleId, status: 'active' });
      const card = page.locator(`[data-recommendation-id="${recommendation.id}"]`);
      await expect(card).toBeVisible();
      await expect(card).toContainText('Evidence');
      await expect(card).not.toContainText(/price target|guaranteed|you should (buy|sell)/i);

      // The same delivery again (provider redelivery) changes nothing visible or stored.
      const redelivered = new Date();
      await inject();
      // Ingestion may deduplicate it before the outbox; either way give the 100 ms dispatcher time to act.
      await page.waitForTimeout(3000);
      await expect.poll(() => db.outboxEvent.count({ where: { createdAt: { gte: redelivered }, status: { not: 'PUBLISHED' } } }), { timeout: 30000 }).toBe(0);
      expect(await db.alertNotification.count({ where: { ownerId: 'demo-alice', articleId: article.articleId } })).toBe(1);
      expect(await db.recommendation.count({ where: { ownerId: 'demo-alice', articleId: article.articleId, status: 'active' } })).toBe(notification.recommendationIds.length);
      await page.reload();
      await expect(notice).toHaveCount(1);

      // Bob does not hold NOVA: no recommendation, no notification, and no access to Alice's.
      expect(await db.recommendation.count({ where: { ownerId: 'demo-bob', articleId: article.articleId } })).toBe(0);
      await bobPage.reload();
      await expect(bobPage.getByRole('region', { name: 'Configurable alerts' })).not.toContainText(run);
      expect((await bob.request.patch(`/api/recommendations/${recommendation.id}`, { headers: { origin: ORIGIN }, data: { disposition: 'saved' } })).status()).toBe(404);
      expect(JSON.stringify(await (await bob.request.get('/api/recommendations?status=history')).json())).not.toContain(recommendation.id);
    } finally {
      await bob.close();
      await db.alertRule.deleteMany({ where: { ownerId: 'demo-alice', name: run } });
    }
  });
});
