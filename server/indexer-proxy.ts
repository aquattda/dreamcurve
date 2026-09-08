import { Resolver, lookup as systemLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';

const DEFAULT_INDEXER_URL = 'https://dev.smk.somnia.host/v1/graphql';
const MAX_QUERY_BYTES = 14_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const REQUEST_DEADLINES_MS = [10_000, 8_000] as const;
const resolver = new Resolver();
resolver.setServers(['8.8.8.8', '1.1.1.1']);

export type IndexerPayload = {
  query: string;
  variables: Record<string, unknown>;
  operationName?: string;
};

export type IndexerResponse = {
  status: number;
  contentType: string;
  body: Buffer;
};

function queryOperation(query: string) {
  return query.match(/\bquery\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? 'anonymous';
}

export function validateIndexerPayload(value: unknown): IndexerPayload {
  if (!value || typeof value !== 'object') throw new Error('GraphQL request body must be an object.');
  const body = value as Record<string, unknown>;
  if (typeof body.query !== 'string' || !body.query.trim()) throw new Error('GraphQL query is required.');
  if (Buffer.byteLength(body.query, 'utf8') > MAX_QUERY_BYTES) throw new Error('GraphQL query is too large.');
  if (/\b(?:mutation|subscription)\b/i.test(body.query)) throw new Error('Only read-only GraphQL queries are allowed.');
  if (body.variables !== undefined && (!body.variables || typeof body.variables !== 'object' || Array.isArray(body.variables))) {
    throw new Error('GraphQL variables must be an object.');
  }
  if (body.operationName !== undefined && typeof body.operationName !== 'string') throw new Error('GraphQL operationName must be a string.');
  return {
    query: body.query,
    variables: (body.variables ?? {}) as Record<string, unknown>,
    ...(typeof body.operationName === 'string' ? { operationName: body.operationName } : {}),
  };
}

const resilientLookup: LookupFunction = (hostname, options, callback) => {
  systemLookup(hostname, options, (error, address, family) => {
    if (!error) { callback(null, address, family); return; }
    resolver.resolve4(hostname, (fallbackError, addresses) => {
      if (fallbackError || !addresses.length) { callback(error, '', 4); return; }
      if ((options as LookupOptions).all) {
        const rows: LookupAddress[] = addresses.map(item => ({ address: item, family: 4 }));
        callback(null, rows);
      } else callback(null, addresses[0], 4);
    });
  });
};

function requestIndexer(payload: IndexerPayload, upstream: URL, deadlineMs: number): Promise<IndexerResponse> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    let timer: NodeJS.Timeout;
    const request = httpsRequest(upstream, {
      method: 'POST',
      lookup: resilientLookup,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': body.byteLength,
      },
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(new Error('Indexer response exceeded the safety limit.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        clearTimeout(timer);
        resolve({
          status: response.statusCode ?? 502,
          contentType: String(response.headers['content-type'] ?? 'application/json'),
          body: Buffer.concat(chunks),
        });
      });
    });
    timer = setTimeout(() => request.destroy(new Error('Indexer proxy request timed out.')), deadlineMs);
    request.on('error', error => { clearTimeout(timer); reject(error); });
    request.end(body);
  });
}

export async function proxyIndexerRequest(value: unknown, configuredUrl = process.env.DREAMDEX_INDEXER_URL): Promise<IndexerResponse> {
  const payload = validateIndexerPayload(value);
  const upstream = new URL(configuredUrl || DEFAULT_INDEXER_URL);
  if (upstream.protocol !== 'https:') throw new Error('The configured indexer URL must use HTTPS.');
  const startedAt = Date.now();
  let lastError: unknown;
  for (let attempt = 0; attempt < REQUEST_DEADLINES_MS.length; attempt += 1) {
    try {
      const response = await requestIndexer(payload, upstream, REQUEST_DEADLINES_MS[attempt]);
      if (response.status < 500 || attempt === REQUEST_DEADLINES_MS.length - 1) return response;
      lastError = new Error(`Indexer returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    console.warn('[portfolio-indexer] retrying upstream read', { operation: queryOperation(payload.query), attempt: attempt + 1, durationMs: Date.now() - startedAt, error: lastError instanceof Error ? lastError.message : String(lastError) });
  }
  console.warn('[portfolio-indexer] request failed', { operation: queryOperation(payload.query), durationMs: Date.now() - startedAt, error: lastError instanceof Error ? lastError.message : String(lastError) });
  throw lastError;
}
