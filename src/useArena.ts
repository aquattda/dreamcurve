import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ArenaState } from '../shared/domain';

export function useArena() {
  const [params] = useSearchParams();
  const mode = params.get('mode') === 'demo' ? 'demo' : 'live';
  const [state, setState] = useState<ArenaState | null>(null);
  const [error, setError] = useState('');
  const [retrying, setRetrying] = useState(false);
  const pending = useRef<AbortController | null>(null);

  const request = useCallback(async (retry = false) => {
    // Skip overlapping polls; an old mode's request is aborted on cleanup.
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    const timeout = setTimeout(() => controller.abort(), 12_000);
    if (retry) setRetrying(true);
    try {
      const response = await fetch(retry ? '/api/retry' : `/api/arena?mode=${mode}`, {
        method: retry ? 'POST' : 'GET', cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok) throw new Error(response.status === 429
        ? 'A retry is already scheduled. Please wait a few seconds.'
        : `Data service returned ${response.status}. Retrying automatically.`);
      const next = await response.json() as ArenaState;
      if (next.mode !== mode || !Array.isArray(next.markets) || !Array.isArray(next.forecasts)
        || !Array.isArray(next.scores) || !Array.isArray(next.proofs) || !next.histories) {
        throw new Error('The data service returned an unexpected response.');
      }
      if (pending.current !== controller) return;
      setState(next);
      setError('');
    } catch (e) {
      if (pending.current !== controller) return;
      setError(controller.signal.aborted ? 'The data request timed out. Retrying automatically.'
        : e instanceof Error ? e.message : 'Could not reach the data service.');
    } finally {
      clearTimeout(timeout);
      if (pending.current === controller) {
        pending.current = null;
        setRetrying(false);
      }
    }
  }, [mode]);
  const load = useCallback(() => request(), [request]);
  const retry = useCallback(() => mode === 'live' ? request(true) : request(), [mode, request]);
  useEffect(() => {
    setError('');
    setRetrying(false);
    void load();
    const timer = setInterval(() => { void load(); }, 5000);
    return () => {
      clearInterval(timer);
      const previous = pending.current;
      pending.current = null;
      previous?.abort();
    };
  }, [load]);
  // Never render synthetic data beneath the LIVE TESTNET banner, even during navigation.
  return { state: state?.mode === mode ? state : null, error, mode, load, retry, retrying };
}
