'use client';

import { Badge, Button, Card, CardContent } from '@repo/ui';
import { ArrowLeft, FileText, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';

import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { ORGANIZATION_ROUTES } from '@/features/auth/routes';
import { Link } from '@/i18n/navigation';
import { getContentProject } from '../organization-api';
import { useOrganizationContext } from '../organization-context';

export function OrganizationContentProjectBlock({
  projectId,
}: {
  projectId: string;
}) {
  const t = useTranslations('ContentProjects');
  const { organization } = useOrganizationContext();
  const organizationId = organization.id;

  const detail = useQuery({
    queryKey: ['organizations', organizationId, 'content-projects', projectId],
    queryFn: ({ signal }) =>
      getContentProject(organizationId, projectId, signal),
    enabled: projectId !== undefined,
  });
  const project = detail.data;
  const missing =
    projectId === undefined ||
    (detail.error as { status?: number } | null)?.status === 404;

  const backLink = (
    <Link
      className="inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline"
      href={ORGANIZATION_ROUTES.contentProjects(organizationId)}
    >
      <ArrowLeft aria-hidden className="size-4 rtl:rotate-180" />
      {t('detail.back')}
    </Link>
  );

  if (!missing && detail.isFetching && project === undefined) {
    return (
      <div className="space-y-4">
        {backLink}
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 aria-hidden className="size-4 animate-spin" />
          {t('loading')}
        </p>
      </div>
    );
  }

  if (missing) {
    return (
      <div className="space-y-4">
        {backLink}
        <EmptyState
          icon={<FileText aria-hidden className="size-5" />}
          title={t('detail.missing')}
        />
      </div>
    );
  }

  if (detail.isError || project === undefined) {
    return (
      <div className="space-y-4">
        {backLink}
        <Card>
          <CardContent className="space-y-2 py-4 text-sm">
            <p className="text-destructive">{t('error.load')}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void detail.refetch()}
            >
              {t('error.retry')}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {backLink}

      <PageHeader title={project.title} description={project.hook} />

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">
          {t(`format.${project.suggestedFormat}`)}
        </Badge>
        <Badge variant="secondary">{t(`language.${project.language}`)}</Badge>
      </div>

      {/*
        The brief first, then the idea.
        A reader deciding whether this is the right project needs what it is
        for before what it says.
      */}
      <Card>
        <CardContent className="space-y-3 py-4">
          <h2 className="text-sm font-semibold">{t('detail.brief')}</h2>

          <dl className="space-y-1 text-sm">
            <div className="flex flex-wrap gap-1">
              <dt className="font-medium">{t('detail.topic')}</dt>
              <dd className="text-muted-foreground">
                <bdi>{project.brief.topic}</bdi>
              </dd>
            </div>
            <div className="flex flex-wrap gap-1">
              <dt className="font-medium">{t('detail.goal')}</dt>
              <dd className="text-muted-foreground">
                <bdi>{project.brief.goal}</bdi>
              </dd>
            </div>
            {/*
              Rendered only when the original request said something. An empty
              row would read as "no audience" where the truth is "not stated".

              Truthiness rather than a null check: `guidance` is optional with
              no minimum length, so a direct API caller can store `''`, and a
              label with nothing after it is the same misreading in a different
              disguise.
            */}
            {project.brief.audience ? (
              <div className="flex flex-wrap gap-1">
                <dt className="font-medium">{t('detail.audience')}</dt>
                <dd className="text-muted-foreground">
                  <bdi>{project.brief.audience}</bdi>
                </dd>
              </div>
            ) : null}
            {project.brief.guidance ? (
              <div className="flex flex-wrap gap-1">
                <dt className="font-medium">{t('detail.guidance')}</dt>
                <dd className="text-muted-foreground">
                  <bdi>{project.brief.guidance}</bdi>
                </dd>
              </div>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 py-4">
          <h2 className="text-sm font-semibold">{t('detail.idea')}</h2>

          <div className="space-y-1 text-sm text-muted-foreground">
            <p>
              <span className="font-medium">{t('detail.angle')}</span>{' '}
              <bdi>{project.angle}</bdi>
            </p>
            <p>
              <bdi>{project.summary}</bdi>
            </p>
          </div>

          <p className="text-xs text-muted-foreground">
            {t('detail.provenance')}
          </p>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t('detail.drafts')}</h2>

        {project.drafts.map((draft) => (
          <Card key={draft.id}>
            <CardContent className="space-y-2 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">
                  <bdi>{draft.title}</bdi>
                </p>
                <Badge variant="outline">
                  {t('detail.revision', { revision: draft.revision })}
                </Badge>
              </div>

              {draft.body === null ? (
                // Not an error and not an empty state: the draft exists and is
                // waiting for a writer that this release does not ship.
                <p className="text-sm text-muted-foreground">
                  {t('detail.unwritten')}
                </p>
              ) : (
                <p className="whitespace-pre-wrap text-sm">
                  <bdi>{draft.body}</bdi>
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
