import { describe, expect, it } from '@jest/globals';

import {
  forwardedHeaders,
  refusedMethod,
  validateExactOriginHeader,
  withoutConsoleWarnings,
} from '../../../../../src/features/agent-management/mcp/mcp-session.service';

/**
 * What the protocol SDK is allowed to see of an incoming request.
 *
 * The MCP endpoint is authenticated by this application's own session cookie,
 * so the request that reaches the adapter carries a credential. Forwarding
 * headers wholesale would put that cookie inside a third-party SDK, its
 * transports, and anything either of them logs — for no benefit, because
 * nothing in the protocol reads it.
 *
 * Asserted directly rather than inferred from a working request, because the
 * failure mode is silent: an exchange that forwards the cookie behaves exactly
 * like one that does not.
 */
describe('the headers handed to the protocol SDK', () => {
  it('forwards content negotiation and every protocol header', () => {
    expect(
      forwardedHeaders({
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'knowledge_search_v1',
      }),
    ).toEqual({
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'knowledge_search_v1',
    });
  });

  it('withholds the session cookie and every other credential', () => {
    const forwarded = forwardedHeaders({
      accept: 'application/json',
      cookie: 'better-auth.session_token=a-real-looking-session-value',
      authorization: 'Bearer a-real-looking-token',
      'x-api-key': 'another-credential',
    });

    expect(forwarded).toEqual({ accept: 'application/json' });

    const rendered = JSON.stringify(forwarded);
    for (const secret of [
      'session_token',
      'a-real-looking-session-value',
      'Bearer',
      'a-real-looking-token',
      'another-credential',
    ]) {
      expect(rendered).not.toContain(secret);
    }
  });

  /** Case is not part of the allowlist decision; HTTP header names are not. */
  it('matches header names case-insensitively', () => {
    expect(
      forwardedHeaders({
        Accept: 'application/json',
        'MCP-Method': 'tools/list',
      }),
    ).toEqual({ accept: 'application/json', 'mcp-method': 'tools/list' });
  });

  /** Express represents a repeated header as an array; the SDK wants one value. */
  it('joins a repeated header rather than dropping it', () => {
    expect(
      forwardedHeaders({ accept: ['application/json', 'text/event-stream'] }),
    ).toEqual({ accept: 'application/json, text/event-stream' });
  });

  it('drops an absent header instead of forwarding undefined', () => {
    expect(
      forwardedHeaders({ accept: undefined, 'mcp-method': undefined }),
    ).toEqual({});
  });
});

describe('refused protocol methods', () => {
  it('detects subscriptions/listen in a single message', () => {
    expect(
      refusedMethod({ jsonrpc: '2.0', id: 1, method: 'subscriptions/listen' }),
    ).toBe('subscriptions/listen');
  });

  it('detects subscriptions/listen inside a batch array', () => {
    expect(
      refusedMethod([
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { jsonrpc: '2.0', id: 2, method: 'subscriptions/listen' },
      ]),
    ).toBe('subscriptions/listen');
  });

  it('returns undefined for permitted methods', () => {
    expect(
      refusedMethod({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    ).toBeUndefined();
    expect(
      refusedMethod({ jsonrpc: '2.0', id: 1, method: 'tools/call' }),
    ).toBeUndefined();
  });

  it('returns undefined for malformed or empty payloads', () => {
    expect(refusedMethod(null)).toBeUndefined();
    expect(refusedMethod(undefined)).toBeUndefined();
    expect(refusedMethod('string')).toBeUndefined();
    expect(refusedMethod(42)).toBeUndefined();
    expect(refusedMethod({})).toBeUndefined();
    expect(refusedMethod([])).toBeUndefined();
    expect(refusedMethod([{ method: 123 }])).toBeUndefined();
  });
});

describe('withoutConsoleWarnings', () => {
  it('suppresses console.warn during synchronous execution and restores it', () => {
    const originalWarn = console.warn;
    let warnCalls = 0;
    const testWarn = () => {
      warnCalls += 1;
    };
    console.warn = testWarn;

    try {
      const result = withoutConsoleWarnings(() => {
        console.warn('this should be suppressed');
        return 'success';
      });

      expect(result).toBe('success');
      expect(warnCalls).toBe(0);
      expect(console.warn).toBe(testWarn);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('restores console.warn even if the callback throws', () => {
    const originalWarn = console.warn;
    const testWarn = () => undefined;
    console.warn = testWarn;

    try {
      expect(() =>
        withoutConsoleWarnings(() => {
          throw new Error('boom');
        }),
      ).toThrow('boom');

      expect(console.warn).toBe(testWarn);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('validateExactOriginHeader', () => {
  const allowed = new Set([
    'http://localhost:3000',
    'https://app.example.test',
  ]);

  it('allows trusted exact origins', () => {
    expect(validateExactOriginHeader('http://localhost:3000', allowed)).toEqual(
      { ok: true },
    );
    expect(
      validateExactOriginHeader('https://app.example.test', allowed),
    ).toEqual({ ok: true });
  });

  it('allows an absent, null, or empty Origin header', () => {
    expect(validateExactOriginHeader(undefined, allowed)).toEqual({ ok: true });
    expect(validateExactOriginHeader(null, allowed)).toEqual({ ok: true });
    expect(validateExactOriginHeader('', allowed)).toEqual({ ok: true });
  });

  it('refuses same hostname with wrong scheme', () => {
    expect(
      validateExactOriginHeader('https://localhost:3000', allowed),
    ).toEqual({
      ok: false,
      errorCode: 'origin_not_allowed',
    });
    expect(
      validateExactOriginHeader('http://app.example.test', allowed),
    ).toEqual({
      ok: false,
      errorCode: 'origin_not_allowed',
    });
  });

  it('refuses same hostname with wrong port', () => {
    expect(validateExactOriginHeader('http://localhost:3001', allowed)).toEqual(
      {
        ok: false,
        errorCode: 'origin_not_allowed',
      },
    );
    expect(
      validateExactOriginHeader('https://app.example.test:8443', allowed),
    ).toEqual({
      ok: false,
      errorCode: 'origin_not_allowed',
    });
  });

  it('refuses foreign hostnames', () => {
    expect(
      validateExactOriginHeader('https://attacker.example', allowed),
    ).toEqual({
      ok: false,
      errorCode: 'origin_not_allowed',
    });
  });

  it('refuses malformed or opaque origins', () => {
    expect(validateExactOriginHeader('null', allowed)).toEqual({
      ok: false,
      errorCode: 'invalid_origin_header',
    });
    expect(validateExactOriginHeader('not-a-url', allowed)).toEqual({
      ok: false,
      errorCode: 'invalid_origin_header',
    });
    expect(validateExactOriginHeader('file:///etc/passwd', allowed)).toEqual({
      ok: false,
      errorCode: 'invalid_origin_header',
    });
  });
});
