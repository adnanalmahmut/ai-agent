import { describe, expect, it } from '@jest/globals';

import { forwardedHeaders } from '../mcp-session.service';

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
