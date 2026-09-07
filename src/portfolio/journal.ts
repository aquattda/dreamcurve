import type { Activity } from './types';
import { isTxHash } from './format';

// Recovery aid only, never a source of balances, cost basis or chain authority.
// Account + chain isolate wallets; the indexer remains the durable cross-device history.
const key = (account: string) => `dreamcurve:transactions:v1:50312:${account.toLowerCase()}`;
const memory = new Map<string, Activity[]>();
export const PORTFOLIO_CHANGED = 'dreamcurve:portfolio-changed';
export function readJournal(account: string): Activity[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key(account)) ?? '[]');
    if (Array.isArray(raw)) {
      const stored = raw.filter((r): r is Activity => !!r && typeof r === 'object' && isTxHash(r.txHash) && typeof r.id === 'string' && ['Pending', 'Confirmed', 'Failed'].includes(r.status) && ['Trades', 'Orders', 'Redeems', 'Wallet'].includes(r.kind) && typeof r.marketTitle === 'string' && typeof r.action === 'string');
      const session = memory.get(key(account)) ?? [];
      return [...session, ...stored.filter(r => !session.some(s => s.id === r.id))];
    }
  } catch { /* Private browsing / quota: retain session memory without failing a trade. */ }
  return memory.get(key(account)) ?? [];
}
export function saveActivity(account: string, row: Activity): boolean {
  if (!isTxHash(row.txHash)) return false;
  const rows = [row, ...readJournal(account).filter(r => r.id !== row.id && !(r.txHash?.toLowerCase() === row.txHash?.toLowerCase() && r.kind === 'Wallet'))].slice(0, 500);
  memory.set(key(account), rows);
  let persisted = true;
  try { localStorage.setItem(key(account), JSON.stringify(rows)); } catch { persisted = false; }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new Event(PORTFOLIO_CHANGED));
  return persisted;
}
export function mergeActivity(indexed: Activity[], local: Activity[]): Activity[] {
  // Prefer indexed fills individually; local receipts are per-transaction aggregates.
  const hashes = new Set(indexed.map(r => `${r.kind}:${r.txHash?.toLowerCase()}`));
  const anyHashes = new Set(indexed.map(r => r.txHash?.toLowerCase()));
  return [...indexed, ...local.filter(r => !hashes.has(`${r.kind}:${r.txHash?.toLowerCase()}`) && !(r.kind === 'Wallet' && anyHashes.has(r.txHash?.toLowerCase())))].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}
