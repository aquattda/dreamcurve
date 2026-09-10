import { expect, test, type Page } from '@playwright/test';
import { safeFixtureIntent as fixtureIntent, fixtureFunding, wallet, operator } from '../execution-fixtures';
import { initialRecord } from '../../server/execution-service';
import { authorizationMessage, type ExecutionIntent, type ExecutionSafety } from '../../shared/execution';
import { limitStatus } from '../../server/execution-limits';
import { verifyMessage, type Hex } from 'viem';

async function mockSafety(page: Page, intent: ExecutionIntent, overrides: Partial<ExecutionSafety> = {}) {
  await page.route(`**/api/executions/${intent.id}/safety`, r => r.fulfill({ json: { funding: fixtureFunding(intent), limits: limitStatus('1', 0n), issues: [], readyToExecute: true, checkedAt: Date.now(), ...overrides } }));
}
async function testWallet(page: Page) {
  await page.exposeFunction('signTestAuthorization', async (raw: Hex) => operator.signMessage({ message: { raw } }));
  await page.addInitScript(({ address }) => {
    Object.defineProperty(window, 'ethereum', { value: { request: async ({ method, params }: { method: string; params?: string[] }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address];
      if (method === 'eth_chainId') return '0xc488';
      if (method === 'wallet_switchEthereumChain') return null;
      if (method === 'personal_sign') return (window as unknown as { signTestAuthorization: (raw: string) => Promise<string> }).signTestAuthorization(params![0]);
      return null;
    }, on: () => {}, removeListener: () => {} } });
  }, { address: operator.address });
}

test('execution history reports missing prerequisites without fabricating trades', async ({ page }) => {
  await page.route('**/api/executions', r => r.fulfill({json:[]}));
  await page.route('**/api/executions/health', r => r.fulfill({json:{ready:false,chainSupported:false,authenticated:false,walletAddress:null,operatorAddresses:[],checkedAt:Date.now(),issues:[{code:'NETWORK_UNSUPPORTED',message:'KeeperHub does not advertise enabled Somnia Shannon (50312).'}]}}));
  await page.goto('/app/executions');
  await expect(page.getByRole('heading',{name:'Every intent. An open record.'})).toBeVisible();
  await expect(page.getByText('No execution intents yet.')).toBeVisible();
  await expect(page.getByText(/KeeperHub does not advertise/)).toBeVisible();
  await expect(page.getByRole('link',{name:'View transaction'})).toHaveCount(0);
});

test('frozen intent survives page reload and never offers execute after expiry', async ({ page }) => {
  const createdAt=Date.now()-180000,expiresAt=Date.now()-60000;
  const intent=fixtureIntent({createdAt,expiresAt,expireTimestampNs:(BigInt(expiresAt)*1000000n).toString()});
  const record={...initialRecord(intent),authorizationMessage:authorizationMessage(intent)};
  await mockSafety(page, intent);
  await page.route(`**/api/executions/${intent.id}`,r=>r.fulfill({json:record}));
  await page.goto(`/app/executions/${intent.id}`);
  await expect(page.getByRole('status',{exact:false}).filter({hasText:'STALE'})).toBeVisible();
  await expect(page.getByText(wallet,{exact:true}).first()).toBeVisible();
  await expect(page.getByText(operator.address,{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Execute with KeeperHub'})).toHaveCount(0);
  await expect(page.getByText(intent.intentHash,{exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByText(intent.intentHash,{exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('mandatory simulation failure stays blocked and preserves frozen payload', async ({ page }) => {
  const intent=fixtureIntent();
  const record={...initialRecord(intent),authorizationMessage:authorizationMessage(intent)};
  await mockSafety(page, intent);
  await page.route(`**/api/executions/${intent.id}`,r=>r.fulfill({json:record}));
  let broadcasts=0;
  await page.route(`**/api/executions/${intent.id}/execute`,r=>{broadcasts++;return r.fulfill({status:500,json:{error:'Must not execute'}});});
  await page.route(`**/api/executions/${intent.id}/simulate`,r=>r.fulfill({json:{...record,status:'BLOCKED',failure:{code:'INSUFFICIENT_BALANCE',message:'Fund the KeeperHub executing wallet.'},preflight:{passed:false,at:Date.now(),checks:[]}}}));
  await page.goto(`/app/executions/${intent.id}`);
  await page.getByRole('button',{name:'Run KeeperHub dry run'}).click();
  await expect(page.getByText(/INSUFFICIENT_BALANCE:/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Execute with KeeperHub'})).toBeDisabled();
  await expect(page.getByText(intent.intentHash,{exact:true})).toBeVisible();
  expect(broadcasts).toBe(0);
});

test('explicit review signs the frozen intent and displays verified partial-fill proof', async ({ page }) => {
  const intent=fixtureIntent();
  const record={...initialRecord(intent),authorizationMessage:authorizationMessage(intent)};
  let executes=0,authorized=false;
  await testWallet(page);
  await mockSafety(page, intent);
  await page.route(`**/api/executions/${intent.id}`,r=>r.fulfill({json:record}));
  await page.route(`**/api/executions/${intent.id}/simulate`,r=>r.fulfill({json:{...record,status:'READY',preflight:{passed:true,at:Date.now(),checks:['Market verified']}}}));
  await page.route(`**/api/executions/${intent.id}/execute`,async r=>{
    executes++;
    authorized=await verifyMessage({address:operator.address,message:record.authorizationMessage,signature:r.request().postDataJSON().signature});
    await r.fulfill({json:{...record,status:'SUCCESS',broadcastAttemptedAt:Date.now(),keeperHubExecutionId:'explicit-test-fixture',keeperHubStatus:'completed',proof:{transactionHash:`0x${'aa'.repeat(32)}`,chainId:50312,blockNumber:'123',confirmedAt:Date.now(),orderId:'7',orderStatus:'PARTIALLY_FILLED',filledQuantity:'1000000',collateralMoved:'500000',verified:true}}});
  });
  await page.goto(`/app/executions/${intent.id}`);
  await page.getByRole('button',{name:'Connect operator wallet',exact:true}).click();
  await page.getByRole('button',{name:'Run KeeperHub dry run'}).click();
  await expect(page.getByRole('button',{name:'Execute with KeeperHub'})).toBeDisabled();
  await page.getByRole('checkbox').check();
  await page.getByRole('button',{name:'Execute with KeeperHub'}).click();
  await expect(page.getByText('PARTIALLY FILLED',{exact:true})).toBeVisible();
  await expect(page.getByText(intent.intentHash,{exact:true})).toBeVisible();
  expect(executes).toBe(1);expect(authorized).toBe(true);
});

for (const scenario of ['missing funds', 'exhausted demo budget'] as const) {
  test(`a reviewed READY intent cannot execute with ${scenario}`, async ({ page }) => {
    const intent = fixtureIntent(), funding = fixtureFunding(intent);
    const record = { ...initialRecord(intent), status: 'READY', preflight: { passed: true, at: Date.now(), checks: [] }, authorizationMessage: authorizationMessage(intent) };
    const limits = limitStatus('1', scenario === 'exhausted demo budget' ? 5n * 10n ** 18n : 0n);
    if (scenario === 'missing funds') {
      funding.gas.balance = '0'; funding.gas.balanceRaw = '0'; funding.gas.sufficient = false; funding.readyToExecute = false;
      funding.issues = [{ code: 'INSUFFICIENT_EXECUTOR_GAS', message: 'KeeperHub executor requires STT for gas.' }];
    }
    await testWallet(page);
    await mockSafety(page, intent, { funding, limits, readyToExecute: false, issues: [...funding.issues, ...limits.issues] });
    await page.route(`**/api/executions/${intent.id}`, r => r.fulfill({ json: record }));
    let broadcasts = 0;
    await page.route(`**/api/executions/${intent.id}/execute`, r => { broadcasts++; return r.fulfill({ status: 500, json: { error: 'Must not execute' } }); });
    await page.goto(`/app/executions/${intent.id}`);
    await page.getByRole('button', { name: 'Connect operator wallet', exact: true }).click();
    await page.getByRole('checkbox').check();
    await expect(page.getByText('Remaining demo budget', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Execute with KeeperHub' })).toBeDisabled();
    expect(broadcasts).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
