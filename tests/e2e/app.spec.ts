import { expect, test } from '@playwright/test';

test('landing page leads into a clearly labelled example arena', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Less guesswork/ })).toBeVisible();
  await page.getByRole('link', { name: /Find your edge/ }).click();
  await expect(page).toHaveURL(/\/app$/);
  await page.getByRole('link', { name: /Explore with example data/ }).click();
  await expect(page).toHaveURL(/mode=demo/);
  await expect(page.getByText('ILLUSTRATIVE MODE')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Where the agents stand/ })).toBeVisible();
});

test('demo scorecard labels synthetic results', async ({ page }) => {
  await page.goto('/app/leaderboard?mode=demo');
  await expect(page.getByRole('heading', { name: 'The open scorecard.' })).toBeVisible();
  await expect(page.getByText('Synthetic examples')).toBeVisible();
  await expect(page.getByText(/Illustrative data/)).toBeVisible();
});

test('illustrative markets cannot create wallet trades', async ({ page }) => {
  await page.goto('/app?mode=demo');
  await expect(page.getByText('ILLUSTRATIVE MODE')).toBeVisible();
  await expect(page.getByRole('button', { name: /Buy YES/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Buy NO/ })).toBeDisabled();
  const agentActions = page.getByRole('button', { name: 'Illustration only' });
  await expect(agentActions).toHaveCount(4);
  for (let index = 0; index < 4; index += 1) {
    await expect(agentActions.nth(index)).toBeDisabled();
  }
});

test('probability chart exposes timeframes, exact hover data, and contract prices in cents', async ({ page }) => {
  await page.goto('/app?mode=demo');
  await expect(page.getByText('Implied YES probability')).toBeVisible();
  await expect(page.getByText('Mid price')).toBeVisible();
  await expect(page.getByRole('button', { name: '1H', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'ALL', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Buy YES/ })).toContainText('¢');
  await expect(page.getByRole('button', { name: /Buy NO/ })).toContainText('¢');

  await page.locator('.prob-chart').hover({ position: { x: 320, y: 120 } });
  const tooltip = page.getByRole('status');
  await expect(tooltip).toContainText('YES probability');
  await expect(tooltip).toContainText('NO probability');
  await expect(tooltip).toContainText('YES price');
  await expect(tooltip).toContainText('NO price');
  await expect(tooltip).toContainText('¢');
});

test('methodology states the model and proof limitations', async ({ page }) => {
  await page.goto('/methodology');
  await expect(page.getByRole('heading', { name: /Know the model/ })).toBeVisible();
  await expect(page.getByText(/not an on-chain timestamp commitment/)).toBeVisible();
  await expect(page.getByText(/does not learn weights or invoke an LLM/)).toBeVisible();
});
