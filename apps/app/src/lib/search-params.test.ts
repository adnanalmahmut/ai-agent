import { describe, expect, it } from 'vitest';

import { firstParam, firstParamOf } from './search-params';

describe('firstParam', () => {
  it('passes a single value through', () => {
    expect(firstParam(new URLSearchParams('a=abc'), 'a')).toBe('abc');
  });

  it('takes the first of a repeated parameter', () => {
    const params = new URLSearchParams(
      'returnTo=%2Fsafe&returnTo=https%3A%2F%2Fevil.example',
    );

    expect(firstParam(params, 'returnTo')).toBe('/safe');
  });

  it('reports an absent parameter as undefined', () => {
    expect(firstParam(new URLSearchParams(''), 'missing')).toBeUndefined();
  });

  it('treats a present-but-blank parameter as absent', () => {
    expect(firstParam(new URLSearchParams('token='), 'token')).toBeUndefined();
    expect(
      firstParam(new URLSearchParams('token=%20%20'), 'token'),
    ).toBeUndefined();
  });

  it('trims surrounding whitespace', () => {
    expect(firstParam(new URLSearchParams('id=%20abc%20'), 'id')).toBe('abc');
  });
});

describe('firstParamOf', () => {
  it('reads from a full URL', () => {
    const url = new URL('https://example.test/en/sign-in?returnTo=%2Freports');

    expect(firstParamOf(url, 'returnTo')).toBe('/reports');
  });

  it('decodes before returning', () => {
    const url = new URL('https://example.test/x?id=a%2Fb%20c');

    expect(firstParamOf(url, 'id')).toBe('a/b c');
  });
});
