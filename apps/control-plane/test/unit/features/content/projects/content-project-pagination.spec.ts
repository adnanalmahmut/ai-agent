import { describe, expect, it } from '@jest/globals';

import { AppException } from '../../../../../src/core/errors';
import {
  beforePosition,
  decodeCursor,
  encodeCursor,
  pageSize,
  CONTENT_PROJECT_PAGE_SIZE,
  MAX_CONTENT_PROJECT_PAGE_SIZE,
} from '../../../../../src/features/content/projects/content-project-pagination';

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

    it('an invalid date rather than passing it to the query', () => {
      expect(() =>
        decodeCursor(encoded({ at: 'garbage', id: 'proj_1' })),
      ).toThrow(AppException);
    });
  });

  describe('beforePosition', () => {
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
