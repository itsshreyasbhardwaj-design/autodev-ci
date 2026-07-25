import { expect, test } from '@playwright/test';

/**
 * End-to-end coverage of the pages a user actually navigates.
 *
 * Assertions target visible text and roles rather than CSS classes, so a
 * design change does not break the suite but a broken page does.
 */

test.describe('landing page', () => {
  test('states the product thesis and links onward', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toContainText('shows its work');
    await expect(page.getByText('No API key required')).toBeVisible();

    // The hero shows the product's real output, including a severity finding.
    await expect(page.getByText('AWS access key ID committed to source')).toBeVisible();
    await expect(page.getByText('Possible N+1 query pattern')).toBeVisible();

    await page.getByRole('link', { name: 'Open the dashboard' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('lists every analyzer', async ({ page }) => {
    await page.goto('/');

    // Scoped to the analyzer list: several of these names also appear as
    // capability card headings further down the page.
    const analyzers = page.getByRole('list').filter({ hasText: 'Hardcoded secrets' });

    for (const analyzer of [
      'Hardcoded secrets',
      'Vulnerability patterns',
      'LLM safety',
      'Supply chain',
      'Documentation drift',
    ]) {
      await expect(analyzers.getByText(analyzer, { exact: true })).toBeVisible();
    }
  });

  test('shows a copyable workflow snippet', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('.github/workflows/autodev.yml')).toBeVisible();
    await expect(page.getByText('pull-requests: write')).toBeVisible();
  });
});

test.describe('dashboard', () => {
  test('renders the overview with an actionable empty state', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // An empty screen must invite an action, not just report emptiness.
    await expect(page.getByRole('heading', { name: 'No repositories connected' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Connect a repository' })).toBeVisible();
  });

  test('navigates between every section', async ({ page }) => {
    await page.goto('/dashboard');

    const sections: Array<[string, RegExp]> = [
      ['Repositories', /Connected repositories/],
      ['Reviews', /Review history/],
      ['Findings', /Security and quality findings/],
      ['Health', /Repository health/],
      ['Releases', /Generated release artifacts/],
      ['Documentation', /Documentation drift/],
      ['Settings', /Configuration/],
    ];

    for (const [label, heading] of sections) {
      await page
        .getByRole('navigation', { name: 'Dashboard' })
        .getByRole('link', { name: label })
        .click();
      await expect(page.getByRole('heading', { level: 1 })).toContainText(heading);
    }
  });

  test('settings shows live capabilities and the default configuration', async ({ page }) => {
    await page.goto('/dashboard/settings');

    await expect(page.getByText('Active capabilities')).toBeVisible();
    // Running with no DATABASE_URL, the storage adapter must say so honestly.
    await expect(page.getByText(/storage adapter: memory/)).toBeVisible();
    await expect(page.getByText('failOnSeverity')).toBeVisible();
  });

  test('findings page offers severity filters', async ({ page }) => {
    await page.goto('/dashboard/findings');

    const filters = page.getByRole('navigation', { name: 'Filter by severity' });
    await expect(filters).toBeVisible();
    await expect(filters.getByText('critical')).toBeVisible();
  });
});

test.describe('accessibility and responsiveness', () => {
  test('exposes a working skip link', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');

    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
  });

  test('every page has exactly one h1 and a document title', async ({ page }) => {
    for (const path of ['/', '/dashboard', '/dashboard/findings', '/dashboard/settings']) {
      await page.goto(path);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page).toHaveTitle(/AutoDev CI/);
    }
  });

  test('does not scroll horizontally on a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    // A couple of pixels is sub-pixel rounding; a real overflow is much larger.
    expect(overflow).toBeLessThanOrEqual(2);
  });

  test('renders without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto('/');
    await page.goto('/dashboard');

    expect(errors).toEqual([]);
  });

  test('serves a 404 page with a route back', async ({ page }) => {
    const response = await page.goto('/does-not-exist');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('link', { name: 'Open the dashboard' })).toBeVisible();
  });
});
