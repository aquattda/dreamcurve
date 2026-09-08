import { expect, test } from '@playwright/test';
import { demoState } from '../../shared/demo';

test('switching to live never displays synthetic markets while live data is pending', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/arena?mode=demo', route => route.fulfill({ json: demoState() }));
  await page.route('**/api/arena?mode=live', async route => {
    await pending;
    await route.fulfill({ json: { ...demoState(), mode: 'live', markets: [], forecasts: [], histories: {} } });
  });
  await page.goto('/app?mode=demo');
  await expect(page.getByRole('heading', { name: 'BTC above $97,400?' })).toBeVisible();
  await page.getByRole('link', { name: 'Try live testnet' }).click();
  await expect(page.getByRole('heading', { name: 'BTC above $97,400?' })).toHaveCount(0);
  await expect(page.getByText('Opening the arena…')).toBeVisible();
  release();
  await expect(page.getByRole('heading', { name: 'No active BTC or ETH windows' })).toBeVisible();
});

test('refresh failures retain the last chart and disclose the data error', async ({ page }) => {
  let fail = false;
  await page.route('**/api/arena?mode=demo', route => fail
    ? route.fulfill({ status: 503, json: { error: 'Unavailable' } })
    : route.fulfill({ json: demoState() }));
  await page.goto('/app?mode=demo');
  await expect(page.locator('.prob-chart')).toBeVisible();
  fail = true;
  await page.getByRole('button', { name: 'Refresh data' }).click();
  await expect(page.getByText(/Data service returned 503/)).toBeVisible();
  await expect(page.locator('.prob-chart')).toBeVisible();
});

test('live trade ticket closes when its exact market leaves the feed', async ({ page }) => {
  const state = demoState();
  state.mode = 'live';
  state.markets = state.markets.map(m => ({ ...m, source: 'live' as const, expiry: Date.now() + 900_000 }));
  await page.route('**/api/arena?mode=live', route => route.fulfill({ json: {
    ...state, markets: state.markets.map(m => ({ ...m, updatedAt: Date.now() })),
  } }));
  await page.goto('/app');
  await page.getByRole('button', { name: /Buy YES/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  state.markets = state.markets.slice(1);
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 9000 });
  await expect(page.getByRole('heading', { name: /ETH above/ })).toBeVisible();
});

test('trade ticket supports keyboard dismissal and restores focus', async ({ page }) => {
  const state = demoState(); state.mode = 'live';
  state.markets = state.markets.map(m => ({ ...m, source: 'live' as const, expiry: Date.now() + 900_000 }));
  await page.route('**/api/arena?mode=live', route => route.fulfill({ json: state }));
  await page.goto('/app');
  const buy = page.getByRole('button', { name: /Buy YES/ });
  await buy.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(buy).toBeFocused();
});

test('mobile navigation closes after choosing a destination', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app?mode=demo');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('link', { name: 'Agents', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Meet your second opinions.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close navigation' })).toHaveCount(0);
});

test('hover remains on the same timestamp when history receives older points', async ({ page }) => {
  const state = demoState();
  await page.route('**/api/arena?mode=demo', route => route.fulfill({ json: state }));
  await page.goto('/app?mode=demo');
  const chart = page.locator('.prob-chart');
  await chart.focus();
  await page.keyboard.press('Home');
  const time = await page.locator('.chart-tooltip time').textContent();
  const history = state.histories[state.markets[0].id];
  history.unshift({ ...history[0], at: history[0].at - 60_000, probability: 0.01 });
  await expect(page.getByText('Showing 81 of 81 chart points')).toBeVisible({ timeout: 9000 });
  await expect(page.locator('.chart-tooltip time')).toHaveText(time!);
});
