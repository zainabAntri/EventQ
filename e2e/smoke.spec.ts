import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Phase 1 smoke suite.
 *
 * Proves the foundation actually stands up end to end: both servers boot, the
 * frontend renders, the API is reachable and healthy, the accessibility
 * baseline holds in a real browser, and the privacy-critical noindex headers
 * are present.
 *
 * Real user journeys arrive in Phase 2, when there is something to journey
 * through.
 */

test.describe('foundation smoke', () => {
  test('landing page renders with a correct document outline', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveTitle(/EventQ/);
    // Exactly one h1: the single most common real-world heading defect.
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('main')).toBeVisible();
  });

  test('skip link is the first thing a keyboard user reaches', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');

    const focused = page.locator(':focus');
    await expect(focused).toHaveText(/skip to main content/i);
    // It must also become visible on focus — a permanently hidden skip link
    // helps nobody.
    await expect(focused).toBeVisible();
  });

  test('has no serious accessibility violations in a real browser', async ({ page }) => {
    await page.goto('/');

    // Unlike the jsdom suite, this one CAN measure colour contrast, because a
    // real engine has applied the real stylesheet.
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();

    const blocking = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );

    expect(blocking, blocking.map((v) => `${v.id}: ${v.help}`).join('\n')).toEqual([]);
  });

  test('renders legibly on a phone, which is how attendees arrive', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // The page must never scroll sideways on a phone.
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows).toBe(false);
  });

  test('application routes are excluded from search indexes', async ({ request }) => {
    // An indexed event page would expose attendee questions publicly. This is a
    // privacy control, not an SEO preference.
    for (const path of ['/e/EVENTQ26', '/app/events', '/present/EVENTQ26']) {
      const response = await request.get(path);
      expect(response.headers()['x-robots-tag'], `${path} must be noindex`).toContain('noindex');
    }
  });

  test('robots.txt disallows the application surfaces', async ({ request }) => {
    const body = await (await request.get('/robots.txt')).text();

    expect(body).toContain('Disallow: /e/');
    expect(body).toContain('Disallow: /app/');
    expect(body).toContain('Sitemap:');
  });
});

test.describe('api reachability', () => {
  const API = 'http://localhost:4000';

  test('reports itself ready with a live database', async ({ request }) => {
    const response = await request.get(`${API}/health/ready`);

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ready',
      checks: { database: 'up' },
    });
  });

  test('returns problem+json for an unknown route', async ({ request }) => {
    const response = await request.get(`${API}/api/v1/does-not-exist`);

    expect(response.status()).toBe(404);
    expect(response.headers()['content-type']).toContain('application/problem+json');

    const body = await response.json();
    expect(body.code).toBe('NOT_FOUND');
    // Every failure is traceable back to a server-side log line.
    expect(body.traceId).toBeTruthy();
  });

  test('publishes an OpenAPI document derived from the contracts', async ({ request }) => {
    const document = await (await request.get(`${API}/api/docs/json`)).json();

    expect(document.info.title).toBe('EventQ API');
    expect(document.paths).toHaveProperty('/health/ready');
    expect(document.components.schemas).toHaveProperty('ProblemDetails');
  });
});
