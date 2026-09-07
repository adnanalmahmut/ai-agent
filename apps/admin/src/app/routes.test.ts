import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const appDirectory = join(process.cwd(), 'src/app');
const sourceDirectory = join(process.cwd(), 'src');

const pages = [
  '[locale]/(protected)/page.tsx',
  '[locale]/login/page.tsx',
  '[locale]/forbidden/page.tsx',
  'health/route.ts',
] as const;

function filesUnder(root: string, keep: (name: string) => boolean): string[] {
  const found: string[] = [];
  const queue = [root];

  while (queue.length > 0) {
    const directory = queue.pop() as string;

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (keep(entry.name)) found.push(path);
    }
  }

  return found.sort();
}

describe('the App Router contract', () => {
  it.each(pages)('declares %s', (page) => {
    expect(existsSync(join(appDirectory, page))).toBe(true);
  });

  it('puts exactly one gate over the protected group', () => {
    expect(
      existsSync(join(appDirectory, '[locale]/(protected)/layout.tsx')),
    ).toBe(true);
  });

  it('is only this shell', () => {
    // The screens this workspace will eventually own have not moved yet, so a
    // route appearing here before its migration would be a claim that is not
    // true. Growing the shell means growing this list on purpose.
    const routes = filesUnder(appDirectory, (name) =>
      /^(page|layout|route)\.tsx?$/.test(name),
    ).map((file) => relative(appDirectory, file));

    expect(routes).toEqual([
      '[locale]/(protected)/layout.tsx',
      '[locale]/(protected)/page.tsx',
      '[locale]/forbidden/page.tsx',
      '[locale]/layout.tsx',
      '[locale]/login/page.tsx',
      'api/auth/[...all]/route.ts',
      'health/route.ts',
    ]);
  });
});

describe('there is no way to create an account here', () => {
  const ACCOUNT_CREATION = /sign-?up|register|create-account/i;

  it('declares no account-creation route', () => {
    const routes = filesUnder(appDirectory, () => true).map((file) =>
      relative(appDirectory, file),
    );

    expect(routes.filter((route) => ACCOUNT_CREATION.test(route))).toEqual([]);
  });

  it('names no account-creation path anywhere in the source', () => {
    // Staff are provisioned through the existing account administration. A
    // route, a link or a button here would be a second, public way in.
    const offenders = filesUnder(
      sourceDirectory,
      (name) => /\.tsx?$/.test(name) && !name.includes('.test.'),
    ).filter((file) => ACCOUNT_CREATION.test(readFileSync(file, 'utf8')));

    expect(offenders.map((file) => relative(process.cwd(), file))).toEqual([]);
  });

  it('ships no message inviting somebody to make one', () => {
    for (const locale of ['ar', 'en']) {
      const messages = readFileSync(
        join(process.cwd(), `messages/${locale}.json`),
        'utf8',
      );

      expect(messages).not.toMatch(
        /sign ?up|register|create an account|إنشاء حساب/i,
      );
    }
  });
});
