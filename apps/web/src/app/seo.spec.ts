// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import nextConfig from '../../next.config';
import { metadata as homeMetadata } from './page';
import { metadata as rootMetadata } from './layout';
import robots from './robots';
import sitemap from './sitemap';

// next/font only works inside the Next compiler.
vi.mock('next/font/google', () => ({ Inter: () => ({ variable: 'font-inter' }) }));

/**
 * The privacy half of SEO. An indexed event page would publish attendee
 * questions, so these pin down "private unless opted in" at every layer that
 * decides it.
 */
describe('search engine exposure', () => {
  it('defaults every page to noindex, so a new page is private until decided otherwise', () => {
    expect(rootMetadata.robots).toEqual({ index: false, follow: false });
  });

  it('opts only the landing page into indexing, with a canonical URL', () => {
    expect(homeMetadata.robots).toEqual({ index: true, follow: true });
    expect(homeMetadata.alternates?.canonical).toBe('/');
  });

  it('sends X-Robots-Tag noindex on every path except the landing page', async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const noindex = rules.filter((rule) =>
      rule.headers.some((h) => h.key === 'X-Robots-Tag' && h.value.includes('noindex')),
    );

    // `/:path+` needs at least one segment: it matches /e/ABC and /dashboard,
    // never `/`. Changing it to an allowlist of private paths would leave every
    // future route indexable by default.
    expect(noindex.map((rule) => rule.source)).toEqual(['/:path+']);
  });

  it('does not block crawling of pages it wants de-indexed', () => {
    // A crawler that may not fetch /e/ never sees its noindex, and can still
    // list the bare URL when a join link is shared publicly.
    const disallowed = [robots().rules].flat().flatMap((rule) => [rule.disallow ?? []].flat());

    expect(disallowed).toEqual(['/api/', '/health/']);
  });

  it('lists no event in the sitemap', () => {
    const urls = sitemap().map((entry) => entry.url);

    expect(urls).toEqual(['http://localhost:3000']);
  });
});

describe('share previews', () => {
  it('gives every page a complete, generic Open Graph and X card', () => {
    expect(rootMetadata.openGraph).toMatchObject({
      siteName: 'EventQ',
      title: expect.any(String),
      description: expect.any(String),
    });
    expect(rootMetadata.twitter).toMatchObject({ card: 'summary_large_image' });
  });
});
