import { expect, test, type Browser, type Page } from '@playwright/test';
import { ORIGIN, PIN_COOKIE } from './support/env';

// Cross-replica fan-out (milestone 31). The harness runs two API replicas behind one origin; its
// proxy honours a test-only cookie that holds a browser context on one replica and names the
// replica in `x-pp-upstream`. Each assertion below is about what users see, with the replica
// placement verified rather than assumed.

async function session(browser: Browser, replica: 0 | 1, account: 'Alice' | 'Bob') {
  const context = await browser.newContext();
  await context.addCookies([{ name: PIN_COOKIE!, value: String(replica), url: ORIGIN }]);
  const page = await context.newPage();
  const stream = page.waitForResponse(r => r.url().includes('/api/events?cursor='));
  await page.goto('/');
  await page.getByRole('button', { name: `Sign in as ${account} Demo` }).click();
  expect((await stream).headers()['x-pp-upstream'], `${account}'s event stream is served by replica ${replica}`).toBe(String(replica));
  await expect(page.getByLabel('Update connection')).toContainText('Live', { timeout: 20000 });
  return { context, page, replica };
}
const option = (page: Page, name: string) => page.locator('#portfolio-selector option', { hasText: name });

test.describe('two API replicas', () => {
  test.skip(!PIN_COOKIE, 'Run through `npm run test:browser` (two API replicas with test-only pinning).');

  test('a change accepted by one replica reaches the owner on the other replica live, and never another user', async ({ browser }) => {
    test.setTimeout(120000);
    const aliceA = await session(browser, 0, 'Alice'), aliceB = await session(browser, 1, 'Alice');
    const bobA = await session(browser, 0, 'Bob'), bobB = await session(browser, 1, 'Bob');
    try {
      const name = `Fan-out ${crypto.randomUUID().slice(0, 8)}`;
      const created = await aliceA.context.request.post('/api/portfolios', { data: { name }, headers: { origin: ORIGIN } });
      expect(created.status()).toBe(201);
      expect(created.headers()['x-pp-upstream'], 'the mutation was processed by replica 0').toBe('0');
      const portfolioId = (await created.json()).portfolio.id as string;
      // Delivered to Alice's other session on the other replica without a reload.
      await expect(option(aliceB.page, name)).toHaveCount(1, { timeout: 15000 });
      await expect(option(aliceA.page, name)).toHaveCount(1, { timeout: 15000 });

      // A trade accepted by replica 1 updates the holdings Alice is viewing through replica 0.
      await aliceA.page.goto('/portfolios');
      await aliceA.page.locator('#portfolio-selector').selectOption(portfolioId);
      await expect(aliceA.page.getByText('No holdings yet.', { exact: false })).toBeVisible();
      await expect(aliceA.page.getByLabel('Update connection')).toContainText('Live', { timeout: 20000 });
      const trade = await aliceB.context.request.post(`/api/portfolios/${portfolioId}/transactions`, {
        headers: { origin: ORIGIN, 'Idempotency-Key': crypto.randomUUID() },
        data: { security: { symbol: 'NOVA', exchangeMic: 'XNAS', currency: 'USD' }, side: 'BUY', quantity: '3', price: '50', fees: '1', occurredAt: '2025-06-02T15:00:00.000Z' } });
      expect(trade.status()).toBe(200);
      expect(trade.headers()['x-pp-upstream']).toBe('1');
      const holdings = aliceA.page.getByRole('table', { name: 'Portfolio holdings' });
      await expect(holdings.getByRole('rowheader', { name: /NOVA/ })).toBeVisible({ timeout: 15000 });
      await expect(holdings.getByRole('cell', { name: 'USD 151.00', exact: true })).toBeVisible();

      // Bob, on either replica, never receives Alice's portfolio, and cannot read it.
      const bobName = `Bob fan-out ${crypto.randomUUID().slice(0, 8)}`;
      const bobCreated = await bobA.context.request.post('/api/portfolios', { data: { name: bobName }, headers: { origin: ORIGIN } });
      expect(bobCreated.status()).toBe(201);
      await expect(option(bobB.page, bobName)).toHaveCount(1, { timeout: 15000 }); // Bob's stream is live
      for (const bob of [bobA, bobB]) {
        await expect(option(bob.page, name)).toHaveCount(0);
        expect((await bob.context.request.get(`/api/portfolios/${portfolioId}`)).status()).toBe(404);
      }
      for (const alice of [aliceA, aliceB]) await expect(option(alice.page, bobName)).toHaveCount(0);
    } finally {
      for (const s of [aliceA, aliceB, bobA, bobB]) await s.context.close();
    }
  });

  test('an answer requested through one replica streams to the same conversation open on the other', async ({ browser }) => {
    test.setTimeout(120000);
    const aliceA = await session(browser, 0, 'Alice'), aliceB = await session(browser, 1, 'Alice');
    const bob = await session(browser, 1, 'Bob');
    try {
      await aliceA.page.goto('/assistant');
      const createdConversation = aliceA.page.waitForResponse(r => r.url().endsWith('/api/conversations') && r.request().method() === 'POST');
      await aliceA.page.getByRole('button', { name: 'New conversation', exact: true }).click();
      const conversationId = (await (await createdConversation).json()).conversation.id as string;
      await aliceB.page.goto('/assistant');
      await aliceB.page.getByLabel('Conversation', { exact: true }).selectOption(conversationId);
      await expect(aliceB.page.getByLabel('Update connection')).toContainText('Live', { timeout: 20000 });

      await aliceA.page.locator('#chat-question').fill('Which recent news affects my largest holding?');
      const started = aliceA.page.waitForResponse(r => r.url().endsWith('/runs') && r.request().method() === 'POST');
      await aliceA.page.getByRole('button', { name: 'Send', exact: true }).click();
      const response = await started;
      expect(response.status()).toBe(202);
      expect(response.headers()['x-pp-upstream']).toBe('0');
      const run = (await response.json()).run as { id: string; assistantMessageId: string };

      // The worker's output reaches replica 1's subscriber: one final answer, no duplicated text.
      const answerB = aliceB.page.locator(`[data-message-id="${run.assistantMessageId}"]`);
      await expect(answerB).toHaveCount(1, { timeout: 30000 });
      await expect(answerB).toContainText('Assistant · MOCK', { timeout: 30000 });
      // Compare with what was persisted, read back through replica 1: same text, shown exactly once.
      const messages = await (await aliceB.context.request.get(`/api/conversations/${conversationId}/messages`)).json() as { messages: { id: string; content: string }[] };
      const persisted = messages.messages.find(m => m.id === run.assistantMessageId)!.content;
      const firstLine = persisted.split('\n').find(line => line.trim().length > 20)!.trim().slice(0, 60);
      for (const page of [aliceB.page, aliceA.page]) {
        await expect(page.locator(`[data-message-id="${run.assistantMessageId}"]`)).toContainText(firstLine);
        const shown = await page.getByLabel('Conversation messages').innerText();
        expect(shown.split(firstLine).length - 1, 'answer text appears once').toBe(1);
      }

      for (const path of [`/api/conversations/${conversationId}/messages`, `/api/runs/${run.id}`, `/api/runs/${run.id}/chunks`]) {
        expect((await bob.context.request.get(path)).status(), path).toBe(404);
      }
    } finally {
      for (const s of [aliceA, aliceB, bob]) await s.context.close();
    }
  });
});
