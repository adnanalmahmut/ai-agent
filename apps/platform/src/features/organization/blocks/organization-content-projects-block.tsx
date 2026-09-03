'use client';

import { Badge, Button, Card, CardContent } from '@repo/ui';
import { FolderKanban, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';

import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { ORGANIZATION_DETAIL_ROUTES } from '@/features/auth/routes';
import { Link } from '@/i18n/navigation';
import {
  listContentProjects,
  type ContentProject,
} from '../organization-api';
import { useOrganizationContext } from '../organization-context';

/**
 * What the organization has decided to work on.
 *
 * Read-only, and deliberately so: a project is created by choosing an idea on
 * the ideas screen, which is the only place the provenance exists. A "new
 * project" button here would have nothing to attach a project to.
 *
 * Paging is append-on-demand rather than numbered. The list is a backlog read
 * newest first, and a reader who wants more wants the next few — not page
 * seven, which a cursor cannot address anyway.
 */

const PAGE_SIZE = 25;

type LoadState = 'idle' | 'loading' | 'error';

export function OrganizationContentProjectsBlock() {
  const t = useTranslations('ContentProjects');
  const { organization } = useOrganizationContext();
  const organizationId = organization.id;

  const [items, setItems] = useState<ContentProject[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [isAppending, setIsAppending] = useState(false);
  /**
   * Kept apart from `state`.
   *
   * A page that failed to append is not a list that failed to load: the rows
   * already on screen are still correct. Folding the two together would either
   * replace a good list with an error card, or — worse — offer a "try again"
   * that restarts from page one and silently drops everything already
   * accumulated.
   */
  const [appendFailed, setAppendFailed] = useState(false);
  /**
   * Bumped to ask for the first page again.
   *
   * A retry has to re-run the effect rather than call its body, because the
   * body owns the abort controller that makes an in-flight read cancellable.
   */
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;

    listContentProjects(
      organizationId,
      { limit: PAGE_SIZE },
      controller.signal,
    )
      .then((page) => {
        if (!current) return;

        setItems(page.items);
        setCursor(page.nextCursor);
        setState('idle');
      })
      .catch(() => {
        if (!current) return;

        setState('error');
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [organizationId, reloadToken]);

  /**
   * "Load more" appends rather than replacing, so the backlog grows downward
   * instead of jumping to the next page.
   */
  const loadMore = useCallback(async () => {
    if (cursor === null) return;

    setIsAppending(true);
    setAppendFailed(false);

    try {
      const page = await listContentProjects(organizationId, {
        limit: PAGE_SIZE,
        cursor,
      });

      setItems((previous) => [...previous, ...page.items]);
      setCursor(page.nextCursor);
    } catch {
      setAppendFailed(true);
    } finally {
      setIsAppending(false);
    }
  }, [cursor, organizationId]);

  const isLoading = state === 'loading' || isAppending;

  return (
    <div className="space-y-4">
      <PageHeader title={t('title')} description={t('description')} />

      {state === 'error' ? (
        <Card>
          <CardContent className="space-y-2 py-4 text-sm">
            <p className="text-destructive">{t('error.load')}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setReloadToken((token) => token + 1)}
            >
              {t('error.retry')}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {items.length === 0 && !isLoading && state !== 'error' ? (
        <EmptyState
          icon={<FolderKanban aria-hidden className="size-5" />}
          title={t('empty.title')}
          description={t('empty.description')}
        />
      ) : null}

      {items.length > 0 ? (
        <ul className="space-y-3">
          {items.map((project) => (
            <li key={project.id}>
              <Card>
                <CardContent className="space-y-2 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link
                      className="font-medium underline-offset-4 hover:underline"
                      href={ORGANIZATION_DETAIL_ROUTES.contentProject(
                        organizationId,
                        project.id,
                      )}
                    >
                      <bdi>{project.title}</bdi>
                    </Link>

                    <div className="flex items-center gap-2">
                      <Badge variant="outline">
                        {t(`format.${project.suggestedFormat}`)}
                      </Badge>
                      <Badge variant="secondary">
                        {t(`language.${project.language}`)}
                      </Badge>
                    </div>
                  </div>

                  <p className="text-sm font-medium">
                    <bdi>{project.hook}</bdi>
                  </p>

                  <p className="text-sm text-muted-foreground">
                    <bdi>{project.summary}</bdi>
                  </p>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}

      {isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 aria-hidden className="size-4 animate-spin" />
          {t('loading')}
        </p>
      ) : null}

      {cursor !== null && !isLoading ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void loadMore()}>
            {appendFailed ? t('error.retry') : t('loadMore')}
          </Button>

          {appendFailed ? (
            <span className="text-sm text-destructive">{t('error.more')}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}