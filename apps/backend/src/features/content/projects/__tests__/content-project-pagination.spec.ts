import { describe, expect, it } from '@jest/globals';

import { AppException } from '../../../../core/errors';
import {
  beforePosition,
  decodeCursor,
  encodeCursor,
  pageSize,
  CONTENT_PROJECT_PAGE_SIZE,
  MAX_CONTENT_PROJECT_PAGE_SIZE,
} from '../content-project-pagination';

/**
 * The refusal branches an end-to-end test cannot reach.
 *
 * A cursor arrives as one opaque string, so the six ways it can be malformed
 * are all the same request over HTTP. They are six different bugs here.
 */

const encoded = (value: unknown) =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error as AppException;
  }

  throw new Error('expected a refusal');
};

describe('content-project pagination', () => {
  describe('pageSize', () => {
    it('defaults when the caller asked for nothing', () => {
      expect(pageSize(undefined)).toBe(CONTENT_PROJECT_PAGE_SIZE);
    });

    it('accepts both ends of the range', () => {
      expect(pageSize(1)).toBe(1);
      expect(pageSize(MAX_CONTENT_PROJECT_PAGE_SIZE)).toBe(
        MAX_CONTENT_PROJECT_PAGE_SIZE,
      );
    });

    it.each([
      ['zero', 0],
      ['negative', -1],
      ['fractional', 1.5],
      ['above the ceiling', MAX_CONTENT_PROJECT_PAGE_SIZE + 1],
      ['not a number', Number.NaN],
    ])('refuses %s', (_label, requested) => {
      const error = refusal(() => pageSize(requested));

      expect(error).toBeInstanceOf(AppException);
      expect(error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('cursor round trip', () => {
    it('survives encoding', () => {
      const cursor = {
        createdAt: new Date('2026-02-01T10:11:12.345Z'),
        id: 'proj_1',
      };

      const decoded = decodeCursor(encodeCursor(cursor));

      // Millisecond precision matters: the column is TIMESTAMP(3) and the
      // tiebreak only works if the boundary compares exactly.
      expect(decoded.createdAt.toISOString()).toBe(
        cursor.createdAt.toISOString(),
      );
      expect(decoded.id).toBe(cursor.id);
    });
  });

  describe('decodeCursor refuses', () => {
    it.each([
      ['text that is not base64 JSON', 'not-a-cursor'],
      ['a JSON scalar', encoded('nope')],
      ['null', encoded(null)],
      ['a missing id', encoded({ at: '2026-02-01T00:00:00.000Z' })],
      ['an empty id', encoded({ at: '2026-02-01T00:00:00.000Z', id: '' })],
      [
        'an oversized id',
        encoded({ at: '2026-02-01T00:00:00.000Z', id: 'x'.repeat(121) }),
      ],
      ['a non-string id', encoded({ at: '2026-02-01T00:00:00.000Z', id: 7 })],
      ['a missing timestamp', encoded({ id: 'proj_1' })],
      ['an unparseable timestamp', encoded({ at: 'garbage', id: 'proj_1' })],
    ])('%s', (_label, value) => {
      const error = refusal(() => decodeCursor(value));

      expect(error).toBeInstanceOf(AppException);
      expect(error.code).toBe('VALIDATION_ERROR');
    });

    /**
     * The one that would not throw on its own.
     *
     * `new Date('garbage')` is a Date, so without the explicit NaN check this
     * decodes cleanly and produces `WHERE createdAt < Invalid Date` — a query
     * that returns nothing and looks like an empty page rather than a refusal.
     */
    it('an invalid date rather than passing it to the query', () => {
      expect(() =>
        decodeCursor(encoded({ at: 'garbage', id: 'proj_1' })),
      ).toThrow(AppException);
    });
  });

  describe('beforePosition', () => {
    /**
     * The tiebreak is the half that is easy to lose.
     *
     * Without the second disjunct, every project sharing the boundary's
     * timestamp is skipped — and because pages stay disjoint, a test that only
     * checks for duplicates still passes while rows go missing.
     */
    it('takes strictly older rows, and same-instant rows by id', () => {
      const at = new Date('2026-02-01T00:00:00.000Z');

      expect(beforePosition({ createdAt: at, id: 'proj_5' })).toEqual({
        OR: [
          { createdAt: { lt: at } },
          { createdAt: at, id: { lt: 'proj_5' } },
        ],
      });
    });
  });
});
