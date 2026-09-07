export const HISTORY_RETENTION_MS = 7 * 86_400_000;

// Return actual snapshots, not averaged prices: <=600 older time buckets,
// the first point, and all of the newest 180 samples used by the models.
// Integer arithmetic is shared by SQLite and PostgreSQL (at is INTEGER/BIGINT).
export function chartHistoryQuery(dialect: 'sqlite' | 'postgres') {
  const param = (index: number) => dialect === 'sqlite' ? `?${index}` : `$${index}`;
  return `WITH bounds AS (
    SELECT MIN(at) AS first_at, MAX(at) AS last_at FROM snapshots
    WHERE market_id=${param(1)} AND at BETWEEN ${param(2)} AND ${param(3)}
  ), ranked AS (
    SELECT s.at, s.payload, b.first_at,
      ROW_NUMBER() OVER (ORDER BY s.at DESC) AS recent_rank,
      ROW_NUMBER() OVER (
        PARTITION BY (s.at-b.first_at) / CASE
          WHEN (b.last_at-b.first_at)/600+1 < 5000 THEN 5000
          ELSE (b.last_at-b.first_at)/600+1 END
        ORDER BY s.at DESC
      ) AS bucket_rank
    FROM snapshots s CROSS JOIN bounds b
    WHERE s.market_id=${param(1)} AND s.at BETWEEN ${param(2)} AND ${param(3)}
  ) SELECT payload FROM ranked
    WHERE recent_rank <= 180 OR bucket_rank=1 OR at=first_at
    ORDER BY at`;
}
