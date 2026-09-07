import { describe, expect, it } from 'vitest';

import { localeSwitchHref } from './locale-switch-href';

describe('localeSwitchHref', () => {
  it('preserves both the query string and the fragment', () => {
    expect(
      localeSwitchHref('/settings', {
        search: '?tab=x',
        hash: '#formatting',
      }),
    ).toBe('/settings?tab=x#formatting');
  });

  it('keeps the query when there is no fragment', () => {
    expect(localeSwitchHref('/search', { search: '?q=design&page=2' })).toBe(
      '/search?q=design&page=2',
    );
  });

  it('keeps the fragment when there is no query', () => {
    expect(localeSwitchHref('/', { hash: '#formatting' })).toBe('/#formatting');
  });

  it('leaves a bare path untouched', () => {
    expect(localeSwitchHref('/about', { search: '', hash: '' })).toBe('/about');
  });

  it('adds no punctuation when nothing was captured', () => {
    expect(localeSwitchHref('/about')).toBe('/about');
  });

  it('does not emit a dangling marker for an empty query or fragment', () => {
    expect(localeSwitchHref('/about', { search: '?', hash: '#' })).toBe(
      '/about',
    );
  });

  it('accepts parts without their leading marker', () => {
    expect(
      localeSwitchHref('/settings', { search: 'tab=x', hash: 'top' }),
    ).toBe('/settings?tab=x#top');
  });

  it('carries no locale prefix of its own', () => {
    expect(localeSwitchHref('/settings', { search: '?tab=x' })).not.toMatch(
      /^\/(ar|en)\//,
    );
  });
});
