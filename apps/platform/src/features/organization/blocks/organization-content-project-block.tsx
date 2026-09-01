import { Badge, Button, Card, CardContent } from '@repo/ui';
import { ArrowLeft, FileText, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslations } from 'use-intl';

import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { ORGANIZATION_ROUTES } from '@/features/auth/routes';
import {
  getContentProject,
  type ContentProjectDetail,
} from '../organization-api';
import { useOrganizationContext } from '../organization-context';

/**
 * One content project and the draft it is aiming at.
 *
 * The idea half is immutable by construction — it is a snapshot of what the
 * agent produced — so nothing here is editable. The draft half is where a
 * writer will eventually put something; until then it shows the target rather
 * than pretending to hold content.
 */

type LoadState = 'loading' | 'loaded' | 'missing' | 'error';

export function OrganizationContentProjectBlock() {
  const t = useTranslations('ContentProjects');
  const { organization } = useOrganizationContext();
  const { projectId } = useParams<{ projectId: string }>();
  const organizationId = organization.id;

  const [project, setProject] = useState<ContentProjectDetail | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  /** Bumped to retry; the effect owns the abort controller. */
  const [reloadToken, setReloadToken] = useState(0);

  /**
   * Derived rather than stored.
   *
   * The route is `content-projects/:projectId`, so this is never actually
   * undefined — but narrowing it here keeps the impossible case honest without
   * writing state from an effect for a value that was already known at render.
   */
  const resolved: LoadState = projectId === undefined ? 'missing' : state;

  useEffect(() => {
    if (projectId === undefined) return;

    const controller = new AbortController();
    let current = true;

    getContentProject(organizationId, projectId, controller.signal)
      .then((found) => {
        if (!current) return;

        setProject(found);
        setState('loaded');
      })
      .catch((error: unknown) => {
        if (!current) return;

        /**
         * A project that is absent and one that belongs to another
         * organization are the same answer from the API, and the same answer
         * here. Anything else would turn this screen into a way to probe for
         * ids.
         */
        const status = (error as { status?: number } | null)?.status;

        setState(status === 404 ? 'missing' : 'error');
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [organizationId, projectId, reloadToken]);

  const backLink = (
    <Link
      className="inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline"
      to={ORGANIZATION_ROUTES.contentProjects(organizationId)}
    >
      <ArrowLeft aria-hidden className="size-4 rtl:rotate-180" />
      {t('detail.back')}
    </Link>
  );

  if (resolved === 'loading') {
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

  if (resolved === 'missing') {
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

  if (resolved === 'error' || project === null) {
    return (
      <div className="space-y-4">
        {backLink}
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
