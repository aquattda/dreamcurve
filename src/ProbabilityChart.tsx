import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Activity } from 'lucide-react';
import type { Snapshot } from '../shared/domain';
import { historyDuration, prepareHistory, selectChartRange, type Timeframe } from './chart-history';

const WIDTH = 760;
const HEIGHT = 300;
const PLOT = { top: 18, right: 20, bottom: 42, left: 52 };
const PLOT_WIDTH = WIDTH - PLOT.left - PLOT.right;
const PLOT_HEIGHT = HEIGHT - PLOT.top - PLOT.bottom;
const Y_TICKS = [1, 0.75, 0.5, 0.25, 0];
type ChartPoint = Snapshot & { probability: number; x: number; y: number };

const tooltipTime = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const shortTime = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
const preciseTime = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit' });
const probability = (value: number) => `${(value * 100).toFixed(1)}%`;
const contractPrice = (value: number | null | undefined) => value == null ? '—' : `${(value * 100).toFixed(1)}¢`;

export function ProbabilityChart({ history }: { history: Snapshot[] }) {
  const [timeframe, setTimeframe] = useState<Timeframe>('ALL');
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const gradientId = `probfill-${useId().replace(/:/g, '')}`;
  const validHistory = useMemo(
    () => prepareHistory(history),
    [history],
  );
  const range = useMemo(() => selectChartRange(validHistory, timeframe), [validHistory, timeframe]);

  const points = useMemo<ChartPoint[]>(() => {
    if (range.points.length < 2) return [];
    const firstAt = range.start;
    const lastAt = range.end;
    const span = Math.max(1, lastAt - firstAt);
    return range.points.map(point => ({
      ...point,
      probability: point.probability,
      x: PLOT.left + ((point.at - firstAt) / span) * PLOT_WIDTH,
      y: PLOT.top + (1 - point.probability) * PLOT_HEIGHT,
    }));
  }, [range]);

  function selectNearest(clientX: number, currentTarget: SVGSVGElement) {
    if (!points.length) return;
    const bounds = currentTarget.getBoundingClientRect();
    const chartX = ((clientX - bounds.left) / bounds.width) * WIDTH;
    let nearest = 0;
    let distance = Infinity;
    points.forEach((point, index) => {
      const nextDistance = Math.abs(point.x - chartX);
      if (nextDistance < distance) { nearest = index; distance = nextDistance; }
    });
    setHoverIndex(nearest);
  }

  function handlePointer(event: PointerEvent<SVGSVGElement>) {
    selectNearest(event.clientX, event.currentTarget);
  }

  function handleKeyboard(event: KeyboardEvent<SVGSVGElement>) {
    if (!points.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') setHoverIndex(0);
    else if (event.key === 'End') setHoverIndex(points.length - 1);
    else setHoverIndex(index => Math.min(points.length - 1, Math.max(0, (index ?? points.length - 1) + (event.key === 'ArrowLeft' ? -1 : 1))));
  }

  const firstAt = range.start;
  const lastAt = range.end;
  const timeSpan = lastAt - firstAt;
  const xTicks = points.length ? Array.from({ length: 5 }, (_, index) => ({
    x: PLOT.left + (index / 4) * PLOT_WIDTH,
    at: firstAt + (index / 4) * timeSpan,
  })) : [];
  const path = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
  const latest = points.at(-1);
  const selected = hoverIndex === null ? null : points[hoverIndex];
  const currentLabelY = latest ? Math.min(PLOT.top + PLOT_HEIGHT - 6, Math.max(PLOT.top + 16, latest.y)) : 0;
  const tooltipSide = selected && selected.x > WIDTH / 2 ? 'place-left' : 'place-right';

  return <div className="interactive-chart">
    <div className="chart-history-summary">
      <span>Available history: {historyDuration(range.end - (validHistory[0]?.at ?? range.end))}</span>
      <span>Showing {range.points.length} of {validHistory.length} chart points</span>
    </div>
    <div className="timeframe-bar" aria-label="Chart timeframe">
      {range.options.map(option => <button
        type="button"
        key={option.label}
        className={range.selected.label === option.label ? 'active' : ''}
        aria-pressed={range.selected.label === option.label}
        title={option.label === 'ALL' ? 'All available recorded history' : `Last ${historyDuration(option.duration)} of recorded history`}
        onClick={() => { setTimeframe(option.label); setHoverIndex(null); }}
      >{option.label}</button>)}
    </div>
    {points.length < 2 ? <div className="empty-chart"><Activity/><span>No probability history in this range.</span></div> : <div className="chart-stage">
      <svg
        className="prob-chart"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="Interactive YES probability chart. Use arrow keys to inspect data points."
        tabIndex={0}
        onPointerMove={handlePointer}
        onPointerDown={handlePointer}
        onPointerLeave={() => setHoverIndex(null)}
        onFocus={() => setHoverIndex(index => index ?? points.length - 1)}
        onBlur={() => setHoverIndex(null)}
        onKeyDown={handleKeyboard}
      >
        <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#b9f568" stopOpacity=".34"/><stop offset="1" stopColor="#b9f568" stopOpacity="0"/></linearGradient></defs>
        {Y_TICKS.map(tick => {
          const y = PLOT.top + (1 - tick) * PLOT_HEIGHT;
          return <g key={tick} className={tick === 0.5 ? 'midline' : ''}>
            <line x1={PLOT.left} y1={y} x2={WIDTH - PLOT.right} y2={y}/>
            <text x={PLOT.left - 10} y={y + 4} textAnchor="end">{tick * 100}%</text>
          </g>;
        })}
        {xTicks.map((tick, index) => <g key={index} className="x-tick">
          <line x1={tick.x} y1={PLOT.top} x2={tick.x} y2={PLOT.top + PLOT_HEIGHT}/>
          <text x={tick.x} y={HEIGHT - 13} textAnchor={index === 0 ? 'start' : index === 4 ? 'end' : 'middle'}>
            {(timeSpan <= 2 * 60_000 ? preciseTime : timeSpan <= 24 * 60 * 60_000 ? shortTime : shortDate).format(tick.at)}
          </text>
        </g>)}
        <path d={`${path} L ${latest!.x} ${PLOT.top + PLOT_HEIGHT} L ${points[0].x} ${PLOT.top + PLOT_HEIGHT} Z`} fill={`url(#${gradientId})`}/>
        <path d={path} className="prob-line"/>
        <g className="current-marker">
          <circle cx={latest!.x} cy={latest!.y} r="8" className="marker-halo"/>
          <circle cx={latest!.x} cy={latest!.y} r="4"/>
          <rect x={latest!.x - 70} y={currentLabelY - 14} width="62" height="27" rx="7"/>
          <text x={latest!.x - 39} y={currentLabelY + 4} textAnchor="middle">{probability(latest!.probability)}</text>
        </g>
        {selected ? <g className="crosshair" aria-hidden="true">
          <line x1={selected.x} y1={PLOT.top} x2={selected.x} y2={PLOT.top + PLOT_HEIGHT}/>
          <line x1={PLOT.left} y1={selected.y} x2={WIDTH - PLOT.right} y2={selected.y}/>
          <circle cx={selected.x} cy={selected.y} r="5"/>
        </g> : null}
      </svg>
      {selected ? <div
        className={`chart-tooltip ${tooltipSide}`}
        role="status"
        style={{ left: `${(selected.x / WIDTH) * 100}%`, top: `${Math.min(70, Math.max(30, (selected.y / HEIGHT) * 100))}%` }}
      >
        <time>{tooltipTime.format(selected.at)}</time>
        <div><span>YES probability</span><strong>{probability(selected.probability)}</strong></div>
        <div><span>NO probability</span><strong>{probability(1 - selected.probability)}</strong></div>
        <div><span>YES price</span><strong>{contractPrice(selected.yesPrice)}</strong></div>
        <div><span>NO price</span><strong>{contractPrice(selected.noPrice)}</strong></div>
      </div> : null}
    </div>}
    <p className="chart-history-note">Ranges appear as history grows. ALL shows this contract’s recorded history (up to 7 days); older points may be sampled.</p>
  </div>;
}
