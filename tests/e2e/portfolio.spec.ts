import { expect, test, type Page } from '@playwright/test';

const account = `0x${'12'.repeat(20)}`;
const hash = `0x${'34'.repeat(32)}`;
const marketId = `0x${'56'.repeat(32)}`;
// Browser-only deterministic fixtures. No request can sign or send a transaction.
async function mockWalletAndPortfolio(page: Page) {
  await page.addInitScript(({ account }) => {
    const listeners = new Map<string, (() => void)[]>();
    const state = window as unknown as { __pfAccount: string; __pfFail: boolean; __pfSwitch: () => void; ethereum: unknown };
    state.__pfAccount = account;
    state.__pfSwitch = () => { state.__pfAccount = `0x${'ab'.repeat(20)}`; listeners.get('accountsChanged')?.forEach(fn => fn()); };
    state.ethereum = {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [state.__pfAccount];
        if (method === 'eth_chainId') return '0xc488';
        if (method === 'wallet_switchEthereumChain') return null;
        throw new Error(`Test provider forbids ${method}`);
      },
      on: (event: string, fn: () => void) => listeners.set(event, [...listeners.get(event) ?? [], fn]),
      removeListener: (event: string, fn: () => void) => listeners.set(event, (listeners.get(event) ?? []).filter(x => x !== fn)),
    };
  }, { account });
  await page.route(/\/src\/wallet-bridge\.ts(\?.*)?$/, async route => {
    const market = { id: marketId, question: 'BTC closes at or above its opening price', asset: 'BTC', collateral: '0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E', expiry: String(Math.floor(Date.now() / 1000) + 300), tradingStart: String(Math.floor(Date.now() / 1000) - 300), status: 'Trading', winningOutcome: null, voided: false, quoteDecimals: 6, resolvedAtTimestamp: null };
    const fixture = { account, updatedAt: Date.now(), balance: 9990.76, complete: true, holdingCount: 1, unavailableHoldings: [], warnings: [], realized: 0, claimable: { count: 0, value: 0 }, orders: [],
      positions: [{ id: `${marketId}:0`, market, side: 'YES', shares: 40, heldShares: 40, avgEntry: .231, price: .253, cost: 9.24, value: 10.12, unrealized: .88, realized: 0, payout: null, redeemed: false, closed: false }],
      activity: [{ id: '100_1', kind: 'Trades', action: 'BUY YES', side: 'YES', marketId, marketTitle: market.question, shares: 40, price: .231, total: 9.24, fee: null, timestamp: Date.now(), txHash: hash, orderId: '456', status: 'Confirmed', source: 'Indexer' }],
    };
    await route.fulfill({ contentType: 'text/javascript', body: `
      const fixture=${JSON.stringify(fixture)};
      export async function connectWallet(){return (await window.ethereum.request({method:'eth_requestAccounts'}))[0]}
      export async function loadTestUsdcBalance(){return {raw:9990760000n,decimals:6,formatted:'9990.76'}}
      export async function fetchPortfolioData(account){if(window.__pfFail)throw new Error('Portfolio indexer unavailable. Retry to refresh your holdings.');return account===fixture.account?{...fixture,updatedAt:Date.now()}:{...fixture,account,balance:0,holdingCount:0,positions:[],activity:[],updatedAt:Date.now()}}
      export async function claimTestUsdc(){throw new Error('Signing disabled in tests')}
      export async function placeStake(){throw new Error('Signing disabled in tests')}
      export async function cancelOrder(){throw new Error('Signing disabled in tests')}
      export async function redeemAll(){throw new Error('Signing disabled in tests')}
    ` });
  });
  await page.goto('/app/portfolio');
  await page.locator('main').getByRole('button', { name: 'Connect wallet' }).click();
  await expect(page.locator('.pf-summary')).toContainText('9,990.76');
}

test('portfolio P0: real-shaped fill, details, explorer and desktop layout', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await mockWalletAndPortfolio(page);
  await expect(page.locator('.pf-summary')).toContainText('10,000.88 tUSDC');
  await expect(page.locator('.pf-position').first()).toContainText('23.1¢');
  await expect(page.locator('.pf-position').first()).toContainText('+0.88 tUSDC');
  await expect(page.getByRole('link', { name: 'View on explorer' })).toHaveAttribute('href', `https://shannon-explorer.somnia.network/address/${account}`);
  await expect(page.getByRole('button', { name: 'Redeem winnings', exact: true })).toBeDisabled();
  await page.locator('.pf-activity').getByRole('button', { name: /Details/ }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('9.24 tUSDC'); await expect(dialog).toContainText('456'); await expect(dialog).toContainText('not exposed');
  await expect(dialog.getByRole('link', { name: 'View transaction' })).toHaveAttribute('href', `https://shannon-explorer.somnia.network/tx/${hash}`);
  await expect(dialog.getByRole('link', { name: 'View transaction' })).toHaveAttribute('rel', 'noopener noreferrer');
  await page.screenshot({ path: 'test-results/portfolio-desktop-detail.png', fullPage: true });
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
  await page.screenshot({ path: 'test-results/portfolio-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('retains the last snapshot on failure and isolates a switched wallet', async ({ page }) => {
  await mockWalletAndPortfolio(page);
  await page.evaluate(() => { (window as unknown as { __pfFail: boolean }).__pfFail = true; });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Showing last synced data');
  await expect(page.locator('.pf-summary')).toContainText('9,990.76');
  await expect(page.locator('.pf-activity')).toHaveCount(1);
  await page.evaluate(() => { (window as unknown as { __pfSwitch: () => void }).__pfSwitch(); });
  await expect(page.locator('.pf-summary')).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { __pfFail: boolean }).__pfFail = false; });
  await page.locator('main').getByRole('button', { name: 'Connect wallet' }).click();
  await expect(page.locator('.pf-summary')).toContainText('0.00');
  await expect(page.locator('.pf-activity')).toHaveCount(0);
});

test('mobile cards and details remain readable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWalletAndPortfolio(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/portfolio-mobile.png', fullPage: true });
  await page.locator('.pf-activity').getByRole('button', { name: /Details/ }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/portfolio-mobile-detail.png' });
  await dialog.getByRole('button', { name: 'Close trade details' }).click();
});
