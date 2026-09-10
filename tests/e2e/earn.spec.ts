import { expect, test, type Page } from '@playwright/test';
import { earnAuthorization, type EarnOverview } from '../../shared/earn';
import { initialEarn } from '../../server/earn-service';
import { earnFixture, earnHash, earnOperator, earnSnapshot, earnWallet } from '../earn-fixtures';
import type { EarnView } from '../../src/earn/api';

// All network results and signatures below are TEST FIXTURES, never live writes.
async function wallet(page: Page) {
  await page.exposeFunction('earnTestSign',async (raw: string) => earnOperator.signMessage({ message: { raw: raw as `0x${string}` } }));
  await page.addInitScript(({ address }) => {
    Object.defineProperty(window,'ethereum',{ value: { request: async ({ method,params }: { method: string; params?: string[] }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address];
      if (method === 'eth_chainId') return '0xaa36a7';
      if (method === 'wallet_switchEthereumChain') return null;
      if (method === 'personal_sign') return (window as unknown as { earnTestSign: (raw: string) => Promise<string> }).earnTestSign(params![0]);
      throw new Error(`Unexpected wallet method ${method}; test must not broadcast.`);
    }, on: () => {}, removeListener: () => {} } });
  },{ address: earnOperator.address });
}
const overview = (free = false): EarnOverview => ({ snapshot: { ...earnSnapshot('LINK'), gasBalance: '0', tokenBalance: '0', aTokenBalance: '0' }, issues: [], chainSupported: true, authenticated: true, freeTierConfirmed: free, usedSupply: '0', usedWithdraw: '0', walletAddress: earnWallet, operators: [earnOperator.address], checkedAt: Date.now() });
async function recordRoutes(page: Page, r: EarnView, ready: boolean) {
  await page.route(`**/api/earn/intents/${r.intent.id}`,route => route.fulfill({ json: r }));
  await page.route(`**/api/earn/intents/${r.intent.id}/safety`,route => route.fulfill({ json: { ready, issues: ready ? [] : [{ message: 'Free quota not confirmed or Sepolia funding missing.' }], checkedAt: Date.now() } }));
}
test('Earn is separate from Shannon and shows funding/billing blockers on mobile',async ({ page }) => {
  await page.route('**/api/earn/overview',r => r.fulfill({ json: overview() }));
  await page.route('**/api/earn/intents',r => r.fulfill({ json: [] }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app/earn');
  await expect(page.getByRole('heading',{ name: 'Put control before execution.' })).toBeVisible();
  await expect(page.getByText('Not confirmed — writes locked')).toBeVisible();
  await expect(page.getByRole('button',{ name: 'Prepare Earn intent' })).toBeDisabled();
  await expect(page.getByRole('link',{ name: 'View Sepolia transaction' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('link',{ name: 'DreamDEX Arena (Somnia)' }).click();
  await expect(page.locator('.network-chip')).toContainText('Shannon');
});
test('prepare sends only fixed-chain action/amount/operator and persists a frozen review',async ({ page }) => {
  await wallet(page);
  await page.route('**/api/earn/overview',r => r.fulfill({ json: overview() }));
  const intent = earnFixture('SUPPLY','earn-test','LINK'), r = { ...initialEarn(intent), authorizationMessage: earnAuthorization(intent) };
  await recordRoutes(page,r,false);
  await page.route('**/api/earn/intents',route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    expect(route.request().postDataJSON()).toEqual({ chainId: 11155111, asset: 'LINK', action: 'SUPPLY', amount: '0.5', operatorAddress: earnOperator.address });
    return route.fulfill({ status: 201, json: r });
  });
  await page.goto('/app/earn'); await page.getByRole('button',{ name: 'Connect Sepolia operator' }).click();
  await page.getByRole('button',{ name: 'Prepare Earn intent' }).click();
  await expect(page.getByText(intent.intentHash,{ exact: true })).toBeVisible();
  await expect(page.getByRole('button',{ name: 'Authorize & execute with KeeperHub' })).toBeDisabled();
});
test('expired Earn intent survives reload and cannot simulate or execute',async ({ page }) => {
  const intent = earnFixture(); intent.expiresAt = Date.now() - 1;
  const r = { ...initialEarn(intent), authorizationMessage: earnAuthorization(intent) };
  await recordRoutes(page,r,false); await page.goto(`/app/earn/${intent.id}`);
  await expect(page.getByText(/Status:.*EXPIRED/)).toBeVisible();
  await expect(page.getByRole('button',{ name: 'Run KeeperHub dry run' })).toBeDisabled();
  await page.reload(); await expect(page.getByRole('button',{ name: 'Authorize & execute with KeeperHub' })).toBeDisabled();
});
test('READY never bypasses missing funding or free-tier confirmation',async ({ page }) => {
  await wallet(page); const intent = earnFixture();
  const r: EarnView = { ...initialEarn(intent), status: 'READY', preflight: { passed: true, at: Date.now(), checks: [] }, authorizationMessage: earnAuthorization(intent) };
  await recordRoutes(page,r,false); await page.goto(`/app/earn/${intent.id}`);
  await page.getByRole('button',{ name: 'Connect Sepolia operator' }).click();
  await page.getByLabel('I reviewed the exact action, token, amount, executor, network and expiry.').check();
  await expect(page.getByRole('button',{ name: 'Authorize & execute with KeeperHub' })).toBeDisabled();
});
test('signed Earn fixture uses KeeperHub endpoint and renders verified proof',async ({ page }) => {
  await wallet(page); const intent = earnFixture();
  const r: EarnView = { ...initialEarn(intent), status: 'READY', preflight: { passed: true, at: Date.now(), checks: [] }, authorizationMessage: earnAuthorization(intent) };
  await recordRoutes(page,r,true); let broadcasts = 0;
  await page.route(`**/api/earn/intents/${intent.id}/execute`,async route => {
    broadcasts++;
    const { verifyMessage } = await import('viem');
    expect(await verifyMessage({ address: earnOperator.address, message: earnAuthorization(intent), signature: route.request().postDataJSON().signature })).toBe(true);
    Object.assign(r,{ status: 'SUCCESS', broadcastAttemptedAt: Date.now(), keeperHubExecutionId: 'explicit-test-fixture', txHash: earnHash, proof: { transactionHash: earnHash, chainId: 11155111, blockNumber: '10', action: 'SUPPLY', amount: '500000', verified: true, confirmedAt: Date.now() } });
    return route.fulfill({ json: r });
  });
  await page.goto(`/app/earn/${intent.id}`); await page.getByRole('button',{ name: 'Connect Sepolia operator' }).click();
  await page.getByLabel('I reviewed the exact action, token, amount, executor, network and expiry.').check();
  await page.getByRole('button',{ name: 'Authorize & execute with KeeperHub' }).click();
  await expect(page.getByText('Independent Aave proof: Verified event and token movement')).toBeVisible();
  await expect(page.getByRole('link',{ name: 'View Sepolia transaction' })).toHaveAttribute('href',`https://sepolia.etherscan.io/tx/${earnHash}`);
  expect(broadcasts).toBe(1);
});
