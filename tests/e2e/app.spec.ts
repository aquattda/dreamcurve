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

test('methodology states the model and proof limitations', async ({ page }) => {
  await page.goto('/methodology');
  await expect(page.getByRole('heading', { name: /Know the model/ })).toBeVisible();
  await expect(page.getByText(/not an on-chain timestamp commitment/)).toBeVisible();
  await expect(page.getByText(/does not learn weights or invoke an LLM/)).toBeVisible();
});
