import { expect, test } from '@playwright/test';
import { demoState } from '../../shared/demo';

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
  await page.route('**/api/arena?mode=demo', route => route.fulfill({ json: demoState() }));
  await page.goto('/app?mode=demo');
  await expect(page.getByText('Implied YES probability')).toBeVisible();
  await expect(page.getByText('Mid price')).toBeVisible();
  await expect(page.getByRole('button', { name: 'ALL', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '1H', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '5MIN', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Buy YES/ })).toContainText('¢');
  await expect(page.getByRole('button', { name: /Buy NO/ })).toContainText('¢');

  await page.locator('.prob-chart').hover({ position: { x: 320, y: 120 } });
  const tooltip = page.getByRole('status');
  await expect(tooltip).toContainText('YES probability');
  await expect(tooltip).toContainText('NO probability');
  await expect(tooltip).toContainText('YES price');
  await expect(tooltip).toContainText('NO price');
  await expect(tooltip).toContainText('¢');

  const chart = page.locator('.prob-chart');
  const bounds = await chart.boundingBox();
  expect(bounds).not.toBeNull();
  await chart.hover({ position: { x: bounds!.width * 0.2, y: bounds!.height * 0.5 } });
  await expect(tooltip).toHaveClass(/place-right/);
  await chart.hover({ position: { x: bounds!.width * 0.8, y: bounds!.height * 0.5 } });
  await expect(tooltip).toHaveClass(/place-left/);
});

test('timeframes change the plotted history, preserve latest value, and reset on market switch', async ({ page }) => {
  const state = demoState();
  const market = state.markets[0];
  state.histories[market.id] = Array.from({ length: 181 }, (_, i) => ({
    at: state.updatedAt - (180 - i) * 60_000, spot: 100, probability: 0.2 + i / 1000,
    yesPrice: 0.4, noPrice: 0.62,
  }));
  await page.route('**/api/arena?mode=demo', route => route.fulfill({ json: state }));
  await page.goto('/app?mode=demo');
  const line = page.locator('.prob-line');
  const allPath = await line.getAttribute('d');
  const latest = await page.locator('.current-marker text').textContent();
  const allTicks = await page.locator('.x-tick text').allTextContents();
  await page.getByRole('button', { name: '1H', exact: true }).click();
  await expect(page.getByRole('button', { name: '1H', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Showing 61 of 181 chart points')).toBeVisible();
  expect(await line.getAttribute('d')).not.toBe(allPath);
  expect(await page.locator('.x-tick text').allTextContents()).not.toEqual(allTicks);
  await expect(page.locator('.current-marker text')).toHaveText(latest!);
  await page.getByRole('button', { name: 'ALL', exact: true }).click();
  await expect(line).toHaveAttribute('d', allPath!);
  await page.getByRole('button', { name: '1H', exact: true }).click();
  await page.locator('.market-row').nth(1).click();
  await expect(page.getByRole('button', { name: 'ALL', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '1H', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '5MIN', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '5MIN', exact: true }).click();
  await expect(page.getByText('Showing 61 of 80 chart points')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('methodology states the model and proof limitations', async ({ page }) => {
  await page.goto('/methodology');
  await expect(page.getByRole('heading', { name: /Know the model/ })).toBeVisible();
  await expect(page.getByText(/not an on-chain timestamp commitment/)).toBeVisible();
  await expect(page.getByText(/does not learn weights or invoke an LLM/)).toBeVisible();
});

test('an upstream timeout is not presented as an empty live market board', async ({ page }) => {
  await page.route('**/api/arena?mode=live', route => route.fulfill({ json: {
    mode: 'live', status: 'degraded', message: 'DreamDEX market data did not respond in time. Retrying automatically.',
    issue: 'INDEXER_TIMEOUT', retryable: true, updatedAt: 0, lastSuccessfulAt: null, retryAt: Date.now() + 5_000,
    markets: [], forecasts: [], histories: {}, scores: [], proofs: [],
  }}));
  await page.goto('/app');
  await expect(page.getByRole('heading', { name: 'Live market data is temporarily unavailable' })).toBeVisible();
  await expect(page.getByText('No live snapshot has been received yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Retry live data/ })).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'No active BTC or ETH windows' })).toHaveCount(0);
});

test('a successful empty discovery shows the genuine no-active-windows state', async ({ page }) => {
  await page.route('**/api/arena?mode=live', route => route.fulfill({ json: {
    mode: 'live', status: 'healthy', message: 'Connected, but no active BTC/ETH contracts were found.',
    issue: null, retryable: false, updatedAt: Date.now(), lastSuccessfulAt: Date.now(), retryAt: null,
    markets: [], forecasts: [], histories: {}, scores: [], proofs: [],
  }}));
  await page.goto('/app');
  await expect(page.getByRole('heading', { name: 'No active BTC or ETH windows' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Live market data is temporarily unavailable' })).toHaveCount(0);
});
