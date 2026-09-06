import { describe, expect, it } from '@jest/globals';

import { AppException } from '../../../../src/core/errors';
import {
  DOCUMENT_PAGE_SIZE,
  MAX_DOCUMENT_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  pageSize,
} from '../../../../src/features/knowledge/knowledge-pagination';

describe('knowledge pagination', () => {
  describe('pageSize', () => {
    it('defaults when the caller says nothing', () => {
      expect(pageSize(undefined)).toBe(DOCUMENT_PAGE_SIZE);
    });

    it('accepts the bounds themselves', () => {
      expect(pageSize(1)).toBe(1);
      expect(pageSize(MAX_DOCUMENT_PAGE_SIZE)).toBe(MAX_DOCUMENT_PAGE_SIZE);
    });

    it.each([0, -1, 1.5, MAX_DOCUMENT_PAGE_SIZE + 1, Number.NaN])(
      'refuses %p rather than clamping it',
      (requested) => {
        expect(() => pageSize(requested)).toThrow(AppException);
      },
    );

    it('names the limit in the refusal so a client can correct itself', () => {
      try {
        pageSize(5_000);
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as AppException).code).toBe('VALIDATION_ERROR');
        expect(String((error as AppException).publicDetails?.reason)).toContain(
          String(MAX_DOCUMENT_PAGE_SIZE),
        );
      }
    });
  });

  describe('cursors', () => {
    it('round-trips a position', () => {
      const cursor = { title: 'Brand voice', id: 'doc_1' };

      expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    });

    it('produces a value that survives a query string unescaped', () => {
      const cursor = encodeCursor({
        title: 'Sûre / Titre ?? avec «ponctuation» ~ 1+1',
        id: 'doc_2',
      });

      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(encodeURIComponent(cursor)).toBe(cursor);
    });

    it('round-trips titles that are not ASCII', () => {
      const cursor = { title: 'صوت العلامة التجارية', id: 'doc_3' };

      expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    });

    it.each([
      ['not base64 at all', '!!!!'],
      [
        'base64 of something that is not JSON',
        Buffer.from('nope').toString('base64url'),
      ],
      ['JSON that is not an object', Buffer.from('42').toString('base64url')],
      [
        'an object missing its id',
        Buffer.from('{"title":"a"}').toString('base64url'),
      ],
      [
        'an object whose id is not a string',
        Buffer.from('{"title":"a","id":7}').toString('base64url'),
      ],
      ['null', Buffer.from('null').toString('base64url')],
    ])('refuses %s', (unusedName, value) => {
      expect(() => decodeCursor(value)).toThrow(AppException);
    });

    it('encodes a position and nothing else', () => {
      const decoded: unknown = JSON.parse(
        Buffer.from(
          encodeCursor({ title: 'Brand voice', id: 'doc_1' }),
          'base64url',
        ).toString('utf8'),
      );

      expect(Object.keys(decoded as object).sort()).toEqual(['id', 'title']);
    });
  });
});
