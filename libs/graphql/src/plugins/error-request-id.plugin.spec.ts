import type { GraphQLResponse } from '@apollo/server';
import { describe, expect, it } from 'vitest';
import { attachRequestId } from './error-request-id.plugin.js';

function single(
  errors?: { message: string; extensions?: Record<string, unknown> }[],
): GraphQLResponse {
  return {
    http: { headers: new Map() as never, status: undefined },
    body: { kind: 'single', singleResult: errors === undefined ? { data: {} } : { errors } },
  };
}

describe('attachRequestId', () => {
  it('adds the request id to every error, keeping existing extensions', () => {
    const response = single([
      { message: 'a', extensions: { code: 'NOT_FOUND' } },
      { message: 'b' },
    ]);

    attachRequestId(response, 'req-1');

    expect(response.body.kind === 'single' && response.body.singleResult.errors).toEqual([
      { message: 'a', extensions: { code: 'NOT_FOUND', requestId: 'req-1' } },
      { message: 'b', extensions: { requestId: 'req-1' } },
    ]);
  });

  it('leaves successful responses and unknown request ids untouched', () => {
    const ok = single();
    const failed = single([{ message: 'a' }]);

    attachRequestId(ok, 'req-1');
    attachRequestId(failed, undefined);

    expect(ok.body).toEqual({ kind: 'single', singleResult: { data: {} } });
    expect(failed.body).toEqual({ kind: 'single', singleResult: { errors: [{ message: 'a' }] } });
  });
});
