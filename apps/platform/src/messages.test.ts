import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SUPPORTED_LOCALES } from '@repo/i18n-core';

import arabic from '../messages/ar.json';
import english from '../messages/en.json';
import { AUTH_ERROR_CODES } from './features/auth/auth-errors';
import { INVITATION_FAILURES } from './features/organization/invitation-state';
import { organizationRoles } from './features/authorization/permissions';
import { CONTROL_PLANE_ERROR_KINDS } from './features/control-plane/use-control-plane-resource';
import { FEATURE_FLAG_SOURCES } from './lib/application-api';
import { CONTENT_IDEA_FAILURES } from './features/organization/content-idea-failures';
import { CONTENT_IDEA_STATUSES } from './features/organization/organization-api';

/**
 * Translation coverage.
 *
 * A missing key is not a compile error and often not a runtime one either —
 * next-intl renders the key path and moves on — so the failure mode is a
 * user reading `Auth.errors.RATE_LIMITED` in production. These tests are the
 * only thing standing between that and a shipped release.
 */
const DICTIONARIES = { ar: arabic, en: english } as const;

type Tree = { [key: string]: string | Tree };

function leafPaths(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;

    return typeof value === 'string'
      ? [path]
      : leafPaths(value as Tree, path);
  });
}

function valueAt(tree: Tree, path: string): string | undefined {
  const found = path
    .split('.')
    .reduce<string | Tree | undefined>(
      (node, key) =>
        typeof node === 'object' && node !== null
          ? (node as Tree)[key]
          : undefined,
      tree,
    );

  return typeof found === 'string' ? found : undefined;
}

/** `{name}` and `<tag>` — the parts a translator must not drop or rename. */
function placeholdersOf(message: string): string[] {
  return [...message.matchAll(/\{(\w+)[^}]*\}|<\/?(\w+)>/g)]
    .map((match) => match[1] ?? match[2] ?? '')
    .sort();
}

describe('every supported locale is covered', () => {
  it('has a dictionary for each locale the monorepo declares', () => {
    // The shared list is the source of truth. Adding a third locale must
    // fail here rather than silently rendering key paths.
    expect(Object.keys(DICTIONARIES).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it('defines exactly the same keys in every locale', () => {
    const [reference, ...others] = Object.values(DICTIONARIES).map((tree) =>
      leafPaths(tree as Tree).sort(),
    );

    for (const other of others) {
      expect(other).toEqual(reference);
    }
  });

  it('leaves no message empty', () => {
    for (const [locale, tree] of Object.entries(DICTIONARIES)) {
      for (const path of leafPaths(tree as Tree)) {
        expect(
          valueAt(tree as Tree, path),
          `${locale}: ${path}`,
        ).not.toBe('');
      }
    }
  });

  it('keeps the same placeholders across locales', () => {
    // A translation that drops `{name}` renders a sentence with a hole in it,
    // and one that renames a tag throws at render time.
    const reference = english as Tree;

    for (const path of leafPaths(reference)) {
      const source = valueAt(reference, path) ?? '';

      for (const [locale, tree] of Object.entries(DICTIONARIES)) {
        expect(
          placeholdersOf(valueAt(tree as Tree, path) ?? ''),
          `${locale}: ${path}`,
        ).toEqual(placeholdersOf(source));
      }
    }
  });
});

describe('every state the code can reach has copy', () => {
  it.each(AUTH_ERROR_CODES)('Auth.errors.%s', (code) => {
    for (const [locale, tree] of Object.entries(DICTIONARIES)) {
      expect(
        valueAt(tree as Tree, `Auth.errors.${code}`),
        `${locale}: ${code}`,
      ).toBeTruthy();
    }
  });

  it.each(INVITATION_FAILURES)(
    'Organization.invitation.failures.%s',
    (failure) => {
      for (const [locale, tree] of Object.entries(DICTIONARIES)) {
        expect(
          valueAt(tree as Tree, `Organization.invitation.failures.${failure}`),
          `${locale}: ${failure}`,
        ).toBeTruthy();
      }
    },
  );

  it.each(CONTROL_PLANE_ERROR_KINDS)('ControlPlane.error.%s', (kind) => {
    for (const [locale, tree] of Object.entries(DICTIONARIES)) {
      expect(
        valueAt(tree as Tree, `ControlPlane.error.${kind}`),
        `${locale}: ${kind}`,
      ).toBeTruthy();
    }
  });

  it.each(FEATURE_FLAG_SOURCES)('ControlPlane.flags.source.%s', (source) => {
    for (const [locale, tree] of Object.entries(DICTIONARIES)) {
      expect(
        valueAt(tree as Tree, `ControlPlane.flags.source.${source}`),
        `${locale}: ${source}`,
      ).toBeTruthy();
    }
  });

  it.each(CONTENT_IDEA_FAILURES)('ContentIdeas.error.%s', (kind) => {
    for (const [locale, tree] of Object.entries(DICTIONARIES)) {
      expect(
        valueAt(tree as Tree, `ContentIdeas.error.${kind}`),
        `${locale}: ${kind}`,
      ).toBeTruthy();
    }
  });

  /**
   * The statuses come from the backend's own `AgentRunStatus`, plus the one
   * this screen adds for a run it stopped watching. A status arriving with no
   * copy renders its own key path where a word should be.
   */
  it.each([...CONTENT_IDEA_STATUSES, 'ABANDONED'])(
    'ContentIdeas.status.%s',
    (status) => {
      for (const [locale, tree] of Object.entries(DICTIONARIES)) {
        expect(
          valueAt(tree as Tree, `ContentIdeas.status.${status}`),
          `${locale}: ${status}`,
        ).toBeTruthy();
      }
    },
  );

  it.each(Object.keys(organizationRoles))('Organization.roles.%s', (role) => {
    for (const [locale, tree] of Object.entries(DICTIONARIES)) {
      expect(
        valueAt(tree as Tree, `Organization.roles.${role}`),
        `${locale}: ${role}`,
      ).toBeTruthy();
    }
  });

  it('covers every validation key the schemas can produce', () => {
    // Scraped from the schemas rather than listed by hand, so a new rule
    // cannot be added without its message.
    const source = new Set(
      [
        ...io_validation().matchAll(/message: '([a-zA-Z]+)'/g),
      ].map((match) => match[1] as string),
    );

    expect(source.size).toBeGreaterThan(5);

    for (const key of source) {
      for (const [locale, tree] of Object.entries(DICTIONARIES)) {
        expect(
          valueAt(tree as Tree, `Auth.validation.${key}`),
          `${locale}: ${key}`,
        ).toBeTruthy();
      }
    }
  });
});

/**
 * Reads the validation modules as text; keeps the scrape honest.
 *
 * Both of them: the organization forms report their issues through the same
 * `FormField`, and therefore into the same `Auth.validation` namespace, so a
 * scrape that only looked at the authentication schemas would miss half the
 * messages it is supposed to be guarding.
 */
function io_validation(): string {
  return [
    'src/features/auth/validation.ts',
    'src/features/organization/organization-validation.ts',
  ]
    .map((path) => readFileSync(resolve(process.cwd(), path), 'utf8'))
    .join('\n');
}
