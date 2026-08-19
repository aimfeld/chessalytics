/**
 * Covers `axiosErrorExtra` — the Sentry `extra` payload every TanStack
 * query/mutation failure carries (FLAWCHESS-64). Without it, an
 * `AxiosError: Request failed with status code 422` reached Sentry with no
 * indication of WHICH endpoint rejected the request or why, so every
 * rejection of a given status grouped into one indistinguishable issue.
 */

import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it } from 'vitest';

import { axiosErrorExtra } from '../queryClient';

const MAX_CAPTURED_DETAIL_LENGTH = 500;

function makeAxiosError(status: number, data: unknown): AxiosError {
  const config = { method: 'post', url: '/bots/games', headers: new AxiosHeaders() };
  const error = new AxiosError('Request failed with status code ' + status, undefined, config);
  error.response = {
    status,
    statusText: '',
    data,
    headers: {},
    config,
  } as AxiosError['response'];
  return error;
}

describe('axiosErrorExtra', () => {
  it('captures status, method, path, and a dict detail (the /bots/games 422 shape)', () => {
    const extra = axiosErrorExtra(
      makeAxiosError(422, {
        detail: { reason: 'missing_clk', message: 'Invalid PGN or missing [%clk] annotations' },
      }),
    );

    expect(extra).toMatchObject({ httpStatus: 422, httpMethod: 'POST', httpUrl: '/bots/games' });
    // Stringified so the reason code survives into the Sentry event.
    expect(extra.responseDetail).toContain('missing_clk');
  });

  it('captures a plain string detail unchanged', () => {
    const extra = axiosErrorExtra(makeAxiosError(409, { detail: 'Session already active' }));
    expect(extra.responseDetail).toBe('Session already active');
  });

  it('never copies anything but `detail` out of the response body', () => {
    const extra = axiosErrorExtra(makeAxiosError(500, { email: 'user@example.com', games: [1, 2] }));
    expect(extra.responseDetail).toBeUndefined();
    expect(JSON.stringify(extra)).not.toContain('user@example.com');
  });

  it('truncates an oversized detail', () => {
    const extra = axiosErrorExtra(makeAxiosError(502, { detail: 'x'.repeat(5000) }));
    expect((extra.responseDetail as string).length).toBe(MAX_CAPTURED_DETAIL_LENGTH);
  });

  it('returns an empty object for a non-axios error, so it is safe to spread', () => {
    expect(axiosErrorExtra(new Error('boom'))).toEqual({});
  });
});
