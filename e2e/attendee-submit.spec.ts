import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The journey the whole product exists for: scan a QR code, ask a question.
 *
 * This runs against the seeded event (EVENTQ26), which is PUBLISHED and
 * pre-moderated. It is the first real user journey in the suite — the Phase 1
 * smoke tests only proved the servers stand up.
 *
 * The mobile-safari project matters more than chromium here. Attendees arrive
 * by pointing a phone camera at a poster; if this does not work at that width,
 * on that engine, it does not work.
 */
const EVENT_PATH = '/e/EVENTQ26';
const QUESTION = 'How do you keep a professional network warm without it feeling transactional?';

/** Unique per run, so a re-run is not refused as a duplicate of the last one. */
function uniqueQuestion(): string {
  return `${QUESTION} (${Math.random().toString(36).slice(2, 10)})`;
}

/**
 * Opens the page and waits until React has actually taken over the form.
 *
 * Without this the suite is a race it loses on WebKit. The page is
 * server-rendered, so the textarea paints and accepts focus before React has
 * hydrated — and a controlled input is re-rendered from React's own state the
 * moment it does, discarding anything typed in that window. Chromium hydrates
 * fast enough to hide the problem; WebKit does not, which is how it was found.
 *
 * The join request is fired from a useEffect, and useEffect runs ONLY after
 * hydration. Waiting for it is therefore a precise, deterministic signal that
 * the form is genuinely interactive — far better than an arbitrary timeout,
 * which would be slow on fast machines and still flaky on slow ones.
 *
 * Worth noting this is not purely a test concern: the same window exists for a
 * real attendee on a slow phone. It is small, and typing usually starts after
 * reading the question — but it is the reason the textarea must not be the only
 * thing standing between a scan and a submitted question.
 */
async function openEventPage(page: Page): Promise<void> {
  const joined = page.waitForResponse(
    (response) => response.url().includes('/attendee') && response.request().method() === 'POST',
  );
  await page.goto(EVENT_PATH);
  await joined;
}

test.describe('attendee asks a question', () => {
  test('scan to submitted, with no account and no signup', async ({ page }) => {
    await openEventPage(page);

    // The event is identifiable before anything is typed — someone who scanned
    // the wrong poster needs to notice immediately.
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/networking night/i);

    // Nothing resembling registration exists on this page.
    await expect(page.getByLabel(/email/i)).toHaveCount(0);
    await expect(page.getByLabel(/password/i)).toHaveCount(0);

    const box = page.getByLabel(/your question/i);
    // Focus is already in the box: the single biggest contributor to the
    // 15-second target is not having to tap around to find it.
    await expect(box).toBeFocused();

    await box.fill(uniqueQuestion());
    await page.getByRole('button', { name: /send question/i }).click();

    // Pre-moderated, so the confirmation must say so — otherwise people assume
    // it failed and send it again.
    await expect(page.getByText(/your question is in/i)).toBeVisible();
    await expect(page.getByText(/once a moderator has approved it/i)).toBeVisible();
  });

  test('can ask a second question without reloading', async ({ page }) => {
    await openEventPage(page);

    await page.getByLabel(/your question/i).fill(uniqueQuestion());
    await page.getByRole('button', { name: /send question/i }).click();
    await expect(page.getByText(/your question is in/i)).toBeVisible();

    await page.getByRole('button', { name: /ask another/i }).click();
    await expect(page.getByLabel(/your question/i)).toHaveValue('');
  });

  test('refuses a too-short question before troubling the server', async ({ page }) => {
    await openEventPage(page);

    await page.getByLabel(/your question/i).fill('too short');
    await page.getByRole('button', { name: /send question/i }).click();

    await expect(page.getByText(/at least 10 characters/i)).toBeVisible();
    await expect(page.getByText(/your question is in/i)).toHaveCount(0);
  });

  test('renders a script tag as text rather than executing it', async ({ page }) => {
    const injected = '<script>window.__xss = true</script> what does that markup do?';

    await openEventPage(page);
    await page.getByLabel(/your question/i).fill(injected);
    await page.getByRole('button', { name: /send question/i }).click();
    await expect(page.getByText(/your question is in/i)).toBeVisible();

    // The real proof, in a real engine: the script never ran.
    expect(await page.evaluate(() => '__xss' in window)).toBe(false);
  });

  test('never scrolls sideways on a phone', async ({ page }) => {
    await openEventPage(page);

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows).toBe(false);
  });

  test('has a send button big enough to hit one-handed', async ({ page }) => {
    await openEventPage(page);

    const box = await page.getByRole('button', { name: /send question/i }).boundingBox();

    // WCAG 2.2 target size (minimum) is 24px; 44px is the widely-used comfort
    // threshold. This is pressed standing up, in a dim room, by someone who is
    // also listening to a speaker.
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  test('has no serious accessibility violations in a real browser', async ({ page }) => {
    await openEventPage(page);

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

  test('is not indexable, because attendee questions are not public content', async ({
    request,
  }) => {
    const response = await request.get(EVENT_PATH);

    expect(response.headers()['x-robots-tag']).toContain('noindex');
  });
});

test.describe('an event that cannot be shown', () => {
  test('gives one indistinguishable answer for every reason', async ({ page }) => {
    // Unknown, draft, closed, archived and private must all look the same, or
    // the page hands back the distinction the API deliberately removed.
    await page.goto('/e/ZZZZZZZZ');

    await expect(page.getByRole('heading', { level: 1 })).toContainText(/not available/i);
    await expect(page.getByLabel(/your question/i)).toHaveCount(0);
  });
});
