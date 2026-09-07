import type { Snapshot } from '../shared/domain';

const TIMEFRAMES = [
  { label: '1MIN', duration: 60_000 },
  { label: '5MIN', duration: 5 * 60_000 },
  { label: '15MIN', duration: 15 * 60_000 },
  { label: '30MIN', duration: 30 * 60_000 },
  { label: '1H', duration: 60 * 60_000 },
  { label: '6H', duration: 6 * 60 * 60_000 },
  { label: '1D', duration: 24 * 60 * 60_000 },
  { label: '1W', duration: 7 * 24 * 60 * 60_000 },
  { label: 'ALL', duration: Infinity },
] as const;
export type Timeframe = (typeof TIMEFRAMES)[number]['label'];
export type ProbabilityPoint = Snapshot & { probability: number };

export function prepareHistory(history: Snapshot[]): ProbabilityPoint[] {
  return [...new Map(history.filter((point): point is ProbabilityPoint =>
    Number.isFinite(point.at) && point.probability !== null && Number.isFinite(point.probability)
    && point.probability >= 0 && point.probability <= 1,
  ).map(point => [point.at, point])).values()].sort((a, b) => a.at - b.at);
}

export function selectChartRange(history: ProbabilityPoint[], requested: Timeframe) {
  const end = history.at(-1)?.at ?? 0;
  const first = history[0]?.at ?? end;
  // Do not offer ranges that display the same samples as ALL or each other.
  const seenCounts = new Set([history.length]);
  const options = TIMEFRAMES.filter(option => {
    if (option.duration === Infinity) return true;
    if (option.duration >= end - first) return false;
    const count = history.filter(point => point.at >= end - option.duration).length;
    if (count < 2 || seenCounts.has(count)) return false;
    seenCounts.add(count);
    return true;
  });
  const selected = options.find(option => option.label === requested) ?? TIMEFRAMES[TIMEFRAMES.length - 1];
  const start = selected.duration === Infinity ? first : end - selected.duration;
  return { options, selected, start, end, points: history.filter(point => point.at >= start) };
}

export function historyDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} days ${hours % 24} hr`;
}
