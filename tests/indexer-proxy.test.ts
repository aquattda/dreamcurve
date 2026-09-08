import { describe, expect, it } from 'vitest';
import { validateIndexerPayload } from '../server/indexer-proxy';

describe('portfolio indexer proxy boundary', () => {
  it('accepts SDK-shaped read queries and preserves variables', () => {
    expect(validateIndexerPayload({ query: 'query Portfolio($acct: String!) { OutcomeBalance(where: {owner: {_eq: $acct}}) { id } }', variables: { acct: '0xabc' } })).toEqual({
      query: 'query Portfolio($acct: String!) { OutcomeBalance(where: {owner: {_eq: $acct}}) { id } }',
      variables: { acct: '0xabc' },
    });
  });

  it('rejects mutations, subscriptions and malformed variables', () => {
    expect(() => validateIndexerPayload({ query: 'mutation Change { update_x { id } }', variables: {} })).toThrow(/read-only/);
    expect(() => validateIndexerPayload({ query: 'subscription Watch { x { id } }', variables: {} })).toThrow(/read-only/);
    expect(() => validateIndexerPayload({ query: 'query Read { x { id } }', variables: [] })).toThrow(/variables/);
  });
});
