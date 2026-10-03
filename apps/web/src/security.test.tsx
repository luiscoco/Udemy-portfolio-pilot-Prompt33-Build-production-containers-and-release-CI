import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ChatMarkdown } from './chat-markdown';
import { sourceLink } from './lib/news-content';
const attack = JSON.parse(readFileSync(new URL('../../../tests/fixtures/adversarial-news.json', import.meta.url), 'utf8'));
it('makes malicious evidence links inert even if supplied as cited sources; escapes article markup', () => {
  for (const url of attack.maliciousLinks) {
    expect(sourceLink(url)).toBeNull();
    const sources = [{ articleId: 'a', title: attack.title, url, publishedAt: '2026-10-03T00:00:00.000Z', isSynthetic: true }];
    const html = renderToStaticMarkup(<ChatMarkdown sources={sources} content={`${attack.title} [source](${url})`} />);
    expect(html).not.toContain('href='); expect(html).not.toContain('<img');
  }
});
