import { describe, expect, it } from 'vitest';
import { openEventPages } from '../../packages/venue/src/catalogue.js';

describe('category-independent discovery', () => {
  it('walks beyond the old fifteen-page limit without category filters', async () => {
    const urls: URL[] = [];
    const mock: typeof fetch = async input => {
      const url = new URL(String(input));
      urls.push(url);
      const page = Number(url.searchParams.get('after_cursor') ?? 0);
      return Response.json({ events: [{ id: String(page), tags: [{ slug: page === 16 ? 'weather' : 'politics' }] }],
        next_cursor: page < 16 ? String(page + 1) : null });
    };
    const events = [];
    for await (const page of openEventPages(mock)) events.push(...page);
    expect(events).toHaveLength(17);
    expect(events.at(-1)).toMatchObject({ tags: [{ slug: 'weather' }] });
    expect(urls.every(url => !url.searchParams.has('tag_id') && !url.searchParams.has('tag_slug')
      && url.searchParams.get('closed') === 'false')).toBe(true);
  });

  it('fails rather than reporting a truncated catalogue as complete', async () => {
    for (const response of [() => new Response('', { status: 503 }),
      () => Response.json({ events: [], next_cursor: 'repeated' }),
      () => Response.json({ message: 'invalid' })]) {
      const mock: typeof fetch = async () => response();
      await expect((async () => { for await (const _ of openEventPages(mock)) { /* consume */ } })())
        .rejects.toThrow();
    }
  });
});
