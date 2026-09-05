'use client';

import { Badge, Button, Card, CardContent } from '@repo/ui';
import { FolderKanban, Loader2 } from 'lucide-react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';

import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { ORGANIZATION_DETAIL_ROUTES } from '@/features/auth/routes';
import { Link } from '@/i18n/navigation';
import { listContentProjects } from '../organization-api';
import { useOrganizationContext } from '../organization-context';

const PAGE_SIZE = 25;

export function OrganizationContentProjectsBlock() {
  const t = useTranslations('ContentProjects');
  const { organization } = useOrganizationContext();
  const organizationId = organization.id;

  const projects = useInfiniteQuery({
    queryKey: [
      'organizations',
      organizationId,
      'content-projects',
      { limit: PAGE_SIZE },
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      listContentProjects(
        organizationId,
        {
          limit: PAGE_SIZE,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
        signal,
      ),
    getNextPageParam: (page) => page.nextCursor,
  });
  const items = projects.data?.pages.flatMap((page) => page.items) ?? [];
  const isLoading = projects.isFetching;
  const loadFailed = projects.isError && !projects.isFetchNextPageError;
  const appendFailed = projects.isFetchNextPageError;

  return (
    <div className="space-y-4">
      <PageHeader title={t('title')} description={t('description')} />

      {loadFailed ? (
        <Card>
          <CardContent className="space-y-2 py-4 text-sm">
            <p className="text-destructive">{t('error.load')}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void projects.refetch()}
            >
              {t('error.retry')}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {items.length === 0 && !isLoading && !loadFailed ? (
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

      {projects.hasNextPage && !isLoading ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void projects.fetchNextPage({ cancelRefetch: false })
            }
          >
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
