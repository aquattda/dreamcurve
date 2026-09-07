import { describe, expect, it } from 'vitest';
import { demoState } from '../shared/demo';
import type { Snapshot } from '../shared/domain';
import { createStore } from '../server/store';
import { HISTORY_RETENTION_MS } from '../server/chart-history';
import { prepareHistory, selectChartRange } from '../src/chart-history';

const now = 1_800_000_000_000;
const samples = (count: number, interval = 5000): Snapshot[] => Array.from({ length: count }, (_, i) => ({
  at: now - (count - 1 - i) * interval, spot: 100 + i, probability: 0.1 + (i % 80) / 100,
  yesPrice: 0.4, noPrice: 0.62,
}));

describe('chart ranges', () => {
  it('offers useful minute ranges for short contracts and defaults to ALL', () => {
    const history = prepareHistory(samples(193)); // 16 minutes
    const all = selectChartRange(history, 'ALL');
    expect(all.options.map(o => o.label)).toEqual(['1MIN', '5MIN', '15MIN', 'ALL']);
    expect(all.points).toEqual(history);
    const five = selectChartRange(history, '5MIN');
    expect(five.points).toHaveLength(61);
    expect(five.start).toBe(now - 300_000);
    expect(five.points.at(-1)).toEqual(all.points.at(-1));
    expect(selectChartRange(history, '1H').selected.label).toBe('ALL');
  });

  it('exposes hour ranges only when they trim history and fixes the axis to the chosen duration', () => {
    const history = prepareHistory(samples(30, 17 * 60_000));
    const range = selectChartRange(history, '1H');
    expect(range.options.map(o => o.label)).toEqual(['30MIN', '1H', '6H', 'ALL']);
    expect(range.end - range.start).toBe(3_600_000);
    expect(range.points[0].at).toBeGreaterThan(range.start); // no invented boundary point
    expect(range.points).toHaveLength(4);
  });

  it('handles missing, invalid, unordered and duplicate samples without misleading controls', () => {
    expect(selectChartRange([], '1H').options.map(o => o.label)).toEqual(['ALL']);
    const source = samples(5);
    const history = prepareHistory([
      ...source.toReversed(), { ...source[0], probability: null },
      { at: NaN, spot: null, probability: 0.5 },
      { at: now + 1, spot: null, probability: 2 },
      { ...source[4], probability: 0.75 },
    ]);
    expect(history).toHaveLength(5);
    expect(history[0].at).toBe(source[0].at);
    expect(history.at(-1)?.probability).toBe(0.75);
    expect(selectChartRange(history, '5MIN').selected.label).toBe('ALL');
  });
});

describe('recorded chart history', () => {
  it('retains old and latest data, bounds payloads, and leaves the model window unchanged', () => {
    const store = createStore(':memory:');
    try {
      const market = demoState(now).markets[0];
      const history = samples(5000, 60_000);
      for (const point of history) store.snapshot(market, point);
      store.snapshot(market, { ...history[0], at: now - HISTORY_RETENTION_MS - 1 });
      store.snapshot({ ...market, id: 'other' }, { ...history[0], probability: 0.99 });
      const chart = store.chartHistory(market.id, now);
      expect(chart.length).toBeGreaterThan(180);
      expect(chart.length).toBeLessThanOrEqual(781);
      expect(chart[0]).toEqual(history[0]);
      expect(chart.at(-1)).toEqual(history.at(-1));
      expect(chart.slice(-180)).toEqual(history.slice(-180));
      expect(store.history(market.id)).toEqual(history.slice(-180));
      expect(chart.every((point, i) => !i || point.at > chart[i - 1].at)).toBe(true);
      expect(store.chartHistory('missing', now)).toEqual([]);
    } finally { store.close(); }
  });

  it('preserves a small history exactly and excludes snapshots outside retention or in the future', () => {
    const store = createStore(':memory:');
    try {
      const market = demoState(now).markets[0];
      const history = samples(80);
      for (const point of history) store.snapshot(market, point);
      store.snapshot(market, { ...history[0], at: now - HISTORY_RETENTION_MS - 1 });
      store.snapshot(market, { ...history[0], at: now + 1 });
      expect(store.chartHistory(market.id, now)).toEqual(history);
    } finally { store.close(); }
  });
});
