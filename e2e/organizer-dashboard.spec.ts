import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The other half of the product's core loop: a question is asked, and a
 * moderator decides whether the room sees it.
 *
 * The test asks a real question through the attendee page first rather than
 * relying on whatever state the seeded questions happen to be in. That makes it
 * self-contained, and it exercises the actual journey — submitted, held for
 * moderation, approved — instead of two halves that have never met.
 *
 * Runs on chromium only. The attendee surface is the one that must work on a
 * phone; a moderator is at a laptop with a keyboard, which is exactly what this
 * suite drives.
 */

const EVENT_PATH = '/e/EVENTQ26';
const MODERATOR = 'moderator@eventq.local';

/**
 * The seed deliberately commits no password — it takes one from SEED_PASSWORD
 * or generates a random one and prints it once.
 *
 * So this suite needs the same value the database was seeded with, and skips
 * rather than fails without it. A hard failure here would mean a red suite for
 * anyone who has not set the variable, which trains people to ignore red.
 */
const PASSWORD = process.env.SEED_PASSWORD;

test.describe('organizer moderates the queue', () => {
  test.skip(
    !PASSWORD,
    'Set SEED_PASSWORD to the value used by `pnpm db:seed` to run the dashboard suite.',
  );

  // A phone is the attendee's device; a moderator is at a keyboard.
  test.skip(({ browserName }) => browserName !== 'chromium', 'Desktop journey.');

  async function askQuestion(page: Page, body: string): Promise<void> {
    const joined = page.waitForResponse(
      (response) => response.url().includes('/attendee') && response.request().method() === 'POST',
    );
    await page.goto(EVENT_PATH);
    await joined;

    await page.getByLabel(/your question/i).fill(body);
    await page.getByRole('button', { name: /send|submit|ask/i }).click();

    await expect(page.getByText(/thank|sent|received|waiting/i).first()).toBeVisible();
  }

  async function signIn(page: Page): Promise<void> {
    await page.goto('/sign-in');
    await page.getByLabel(/email/i).fill(MODERATOR);
    await page.getByLabel(/password/i).fill(PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page.getByRole('heading', { name: /your events/i })).toBeVisible();
  }

  test('a submitted question is held, then approved from the dashboard', async ({ page }) => {
    const body = `Does a moderated question reach the room only after approval? (${Date.now()})`;

    await askQuestion(page, body);
    await signIn(page);

    // Into the event's console.
    await page.getByRole('link', { name: /networking night/i }).click();

    // The console opens on the questions that need attention, so the question
    // just submitted is here without any filtering.
    await expect(page.getByRole('tab', { name: /waiting/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    const card = page.getByRole('listitem').filter({ hasText: body });
    await expect(card).toBeVisible();

    // Everything needed to decide is on the card: who asked, when, and how much
    // support it has.
    await expect(card).toContainText(/anonymous/i);
    await expect(card).toContainText(/votes?/);

    await card.getByRole('button', { name: 'Approve' }).click();

    // It leaves the queue it was in — the thing that makes working a list feel
    // like progress rather than an endless scroll.
    await expect(card).toBeHidden();

    // And it is genuinely approved, not merely hidden from one view.
    await page.getByRole('tab', { name: /approved/i }).click();
    await expect(page.getByRole('listitem').filter({ hasText: body })).toBeVisible();
  });

  test('the queue can be worked entirely from the keyboard', async ({ page }) => {
    // A moderator at a live event has one hand on a laptop and their eyes on
    // the stage. Reaching for a mouse to change tabs is the difference between
    // keeping up and falling behind.
    await signIn(page);
    await page.getByRole('link', { name: /networking night/i }).click();

    const waiting = page.getByRole('tab', { name: /waiting/i });
    await waiting.focus();

    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: /approved/i })).toBeFocused();

    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: /answered/i })).toBeFocused();

    // Arrow keys move between tabs; Tab itself moves OUT of the tablist rather
    // than stepping through all seven, which is what a roving tabindex buys.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('tab', { name: /answered/i })).not.toBeFocused();
  });

  test('search finds a question by its words', async ({ page }) => {
    const body = `What is the etiquette for following up on LinkedIn afterwards? (${Date.now()})`;

    await askQuestion(page, body);
    await signIn(page);
    await page.getByRole('link', { name: /networking night/i }).click();

    await page.getByLabel(/search questions/i).fill('etiquette');

    await expect(page.getByRole('listitem').filter({ hasText: body })).toBeVisible();
    await expect(page.getByRole('listitem')).toHaveCount(1);
  });

  test('the dashboard explains the order it puts questions in', async ({ page }) => {
    // Ranking that cannot account for itself is ranking moderators work around.
    await signIn(page);
    await page.getByRole('link', { name: /networking night/i }).click();

    await page.getByRole('tab', { name: /everything/i }).click();

    const first = page.getByRole('listitem').first();
    await first.getByText(/why is this ranked here/i).click();

    await expect(first.getByText('Support')).toBeVisible();
    await expect(first.getByText('Recency')).toBeVisible();
  });

  test('has no detectable accessibility violations', async ({ page }) => {
    await signIn(page);
    await page.getByRole('link', { name: /networking night/i }).click();
    await expect(page.getByRole('tablist')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });
});
