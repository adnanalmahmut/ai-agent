import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SUPPORTED_LOCALES } from '@repo/i18n-core';

import arabic from '../messages/ar.json';
import english from '../messages/en.json';
import { AUTH_ERROR_CODES } from './features/auth/auth-errors';
import { INVITATION_FAILURES } from './features/organization/invitation-state';
import { organizationRoles } from './features/authorization/permissions';
import { CONTROL_PLANE_ERROR_KINDS } from './features/control-plane/control-plane-errors';
import {
  CONTROL_PLANE_AUDIT_ACTIONS,
  FEATURE_FLAG_SOURCES,
} from './lib/application-api';
import { CONTENT_IDEA_FAILURES } from './features/organization/content-idea-failures';
import {
  AGENT_ACTION_APPROVAL_STATUSES,
  CONTENT_IDEA_FORMATS,
  CONTENT_IDEA_LANGUAGES,
  CONTENT_IDEA_STATUSES,
  CONTENT_IDEA_UNAVAILABLE_REASONS,
  KNOWLEDGE_SPACE_SLUGS,
  TOOL_EXECUTION_STATUSES,
  TOOL_FAILURE_CODES,
} from './features/organization/organization-api';

const DICTIONARIES = { ar: arabic, en: english } as const;

type Tree = { [key: string]: string | Tree };

function leafPaths(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;

    return typeof value === 'string' ? [path] : leafPaths(value as Tree, path);
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

function placeholdersOf(message: string): string[] {
  return [...message.matchAll(/\{(\w+)[^}]*\}|<\/?(\w+)>/g)]
    .map((match) => match[1] ?? match[2] ?? '')
    .sort();
}

describe('every supported locale is covered', () => {
  it('has a dictionary for each locale the monorepo declares', () => {
    expect(Object.keys(DICTIONARIES).sort()).toEqual(
      [...SUPPORTED_LOCALES].sort(),
    );
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
        expect(valueAt(tree as Tree, path), `${locale}: ${path}`).not.toBe('');
      }
    }
  });

  it('keeps the same placeholders across locales', () => {
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
  it.each(AGENT_ACTION_APPROVAL_STATUSES)('Approvals.status.%s', (status) => {
    for (const [locale, tree] of Object.entries(DICTIONARIES)) {
      expect(
        valueAt(tree as Tree, `Approvals.status.${status}`),
        `${locale}: ${status}`,
      ).toBeTruthy();
      expect(
        valueAt(tree as Tree, `Approvals.filter.${status}`),
        `${locale}: filter ${status}`,
      ).toBeTruthy();
    }
  });

  it.each(TOOL_EXECUTION_STATUSES)('Approvals.effect.%s', (status) => {
    for (const [locale, tree] of Object.entries(DICTIONARIES)) {
      expect(
        valueAt(tree as Tree, `Approvals.effect.${status}`),
        `${locale}: ${status}`,
      ).toBeTruthy();
    }
  });

  it.each(TOOL_FAILURE_CODES)('Approvals.failure.%s', (code) => {
    for (const [locale, tree] of Object.entries(DICTIONARIES)) {
      expect(
        valueAt(tree as Tree, `Approvals.failure.${code}`),
        `${locale}: ${code}`,
      ).toBeTruthy();
    }
  });

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

  it.each([...CONTROL_PLANE_AUDIT_ACTIONS, 'unknown'])(
    'ControlPlane.audit.action.%s',
    (action) => {
      for (const [locale, tree] of Object.entries(DICTIONARIES)) {
        expect(
          valueAt(tree as Tree, `ControlPlane.audit.action.${action}`),
          `${locale}: ${action}`,
        ).toBeTruthy();
      }
    },
  );

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

  it.each(CONTENT_IDEA_FORMATS)('ContentIdeas.format.%s', (format) => {
    for (const [locale, tree] of Object.entries(DICTIONARIES)) {
      expect(
        valueAt(tree as Tree, `ContentIdeas.format.${format}`),
        `${locale}: ${format}`,
      ).toBeTruthy();
    }
  });

  it.each(CONTENT_IDEA_FORMATS)('ContentProjects.format.%s', (format) => {
    for (const [locale, tree] of Object.entries(DICTIONARIES)) {
      expect(
        valueAt(tree as Tree, `ContentProjects.format.${format}`),
        `${locale}: ${format}`,
      ).toBeTruthy();
    }
  });

  it.each(CONTENT_IDEA_LANGUAGES)('ContentProjects.language.%s', (language) => {
    for (const [locale, tree] of Object.entries(DICTIONARIES)) {
      expect(
        valueAt(tree as Tree, `ContentProjects.language.${language}`),
        `${locale}: ${language}`,
      ).toBeTruthy();
    }
  });

  it.each(CONTENT_IDEA_LANGUAGES)('ContentIdeas.language.%s', (language) => {
    for (const [locale, tree] of Object.entries(DICTIONARIES)) {
      expect(
        valueAt(tree as Tree, `ContentIdeas.language.${language}`),
        `${locale}: ${language}`,
      ).toBeTruthy();
    }
  });

  it.each(CONTENT_IDEA_UNAVAILABLE_REASONS)(
    'ContentIdeas.unavailable.%s',
    (reason) => {
      for (const [locale, tree] of Object.entries(DICTIONARIES)) {
        expect(
          valueAt(tree as Tree, `ContentIdeas.unavailable.${reason}`),
          `${locale}: ${reason}`,
        ).toBeTruthy();
      }
    },
  );

  it.each(KNOWLEDGE_SPACE_SLUGS)('Knowledge.spaces.name.%s', (slug) => {
    for (const [locale, tree] of Object.entries(DICTIONARIES)) {
      expect(
        valueAt(tree as Tree, `Knowledge.spaces.name.${slug}`),
        `${locale}: ${slug}`,
      ).toBeTruthy();
    }
  });

  it.each(Object.keys(organizationRoles))('Organization.roles.%s', (role) => {
    for (const [locale, tree] of Object.entries(DICTIONARIES)) {
      expect(
        valueAt(tree as Tree, `Organization.roles.${role}`),
        `${locale}: ${role}`,
      ).toBeTruthy();
    }
  });

  it('covers every validation key the schemas can produce', () => {
    const source = new Set(
      [...io_validation().matchAll(/message: '([a-zA-Z]+)'/g)].map(
        (match) => match[1] as string,
      ),
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

function io_validation(): string {
  return [
    'src/features/auth/validation.ts',
    'src/features/organization/organization-validation.ts',
  ]
    .map((path) => readFileSync(resolve(process.cwd(), path), 'utf8'))
    .join('\n');
}
