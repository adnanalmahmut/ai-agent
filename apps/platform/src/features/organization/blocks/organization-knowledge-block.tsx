import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@repo/ui';
import { FileText, Loader2, Trash2 } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';

import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { useOrganizationRolePermission } from '@/features/authorization/use-permissions';
import {
  ApiError,
  ApiUnavailableError,
  type ApiErrorDetails,
} from '@/lib/application-api';

import {
  createKnowledgeSpace,
  deleteKnowledgeDocument,
  deleteKnowledgeSpace,
  ingestKnowledgeDocument,
  listKnowledgeDocuments,
  listKnowledgeSpaces,
  type KnowledgeDocument,
  type KnowledgeSpace,
} from '../organization-api';
import { useOrganizationContext } from '../organization-context';

/**
 * One write, as a thunk.
 *
 * Written as a call signature rather than an arrow type on purpose. The
 * repository's architecture test finds untranslated text with a regex for a
 * word between `>` and `<`, and an arrow type's `=> Promise<` is exactly that
 * shape. This form says the same thing and leaves the check able to catch what
 * it is for.
 */
type Work = {
  (): Promise<unknown>;
};

type Failure = {
  kind:
    | 'unavailable'
    | 'unauthenticated'
    | 'forbidden'
    | 'disabled'
    | 'invalid'
    | 'failed';
  details: ApiErrorDetails;
};

const classify = (thrown: unknown): Failure => {
  const details = thrown instanceof ApiError ? thrown.details : {};

  if (thrown instanceof ApiUnavailableError) {
    return { kind: 'unavailable', details };
  }

  if (thrown instanceof ApiError) {
    if (thrown.status === 401) return { kind: 'unauthenticated', details };
    /**
     * The code, not the status alone. A disabled feature and a missing
     * permission are both 403, and telling an owner who holds every grant
     * that they lack permission sends them to change roles over something no
     * role can fix. Reads are not gated, so this only ever appears on a write
     * — which is exactly when it is confusing.
     */
    if (thrown.status === 403) {
      return {
        kind: thrown.code === 'FEATURE_DISABLED' ? 'disabled' : 'forbidden',
        details,
      };
    }
    if (thrown.status === 400 || thrown.status === 409) {
      return { kind: 'invalid', details };
    }
  }

  return { kind: 'failed', details };
};

/**
 * The organization's reference material: what an agent will answer from.
 *
 * Two levels, and only two. A space is chosen, its documents are listed, and a
 * document is submitted as text. There is no upload, no crawler and no
 * connector, because none of those is what makes retrieval work — the content
 * is — and each would be a moving part between the operator and the thing they
 * are trying to check.
 *
 * Every control is gated on the reader's membership **in this organization**,
 * and none of those gates is a boundary: the backend re-derives the same
 * decision from the database. Hiding a button only avoids showing someone a
 * door that opens onto a 403.
 */
export function OrganizationKnowledgeBlock() {
  const t = useTranslations('Knowledge');
  const format = useFormatter();
  const { organization, viewer } = useOrganizationContext();

  const canWrite = useOrganizationRolePermission(viewer.member?.role, {
    knowledge: ['write'],
  });

  const [spaces, setSpaces] = useState<KnowledgeSpace[]>([]);
  /**
   * Tagged with the space the rows were loaded for, rather than a bare list.
   *
   * The list and the chosen space arrive at different times, and an untagged
   * list renders whichever one landed last: choosing a second space would show
   * the first space's documents beneath the second space's heading until the
   * fetch returned. Carrying the space id makes that state unrepresentable —
   * rows are shown only to the space that asked for them.
   */
  const [documents, setDocuments] = useState<{
    spaceId: string;
    rows: KnowledgeDocument[];
  } | null>(null);
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const [slug, setSlug] = useState('');
  const [spaceName, setSpaceName] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  const organizationId = organization.id;

  useEffect(() => {
    const controller = new AbortController();
    let current = true;

    listKnowledgeSpaces(organizationId, controller.signal)
      .then((loaded) => {
        if (!current) return;

        setSpaces(loaded);
        setSelectedSpaceId((selected) =>
          selected !== null && loaded.some((space) => space.id === selected)
            ? selected
            : (loaded[0]?.id ?? null),
        );
        setFailure(null);
        setIsLoading(false);
      })
      .catch((thrown: unknown) => {
        if (!current) return;

        setFailure(classify(thrown));
        setIsLoading(false);
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [organizationId, reloadToken]);

  useEffect(() => {
    if (selectedSpaceId === null) return;

    const controller = new AbortController();
    let current = true;
    const spaceId = selectedSpaceId;

    listKnowledgeDocuments(organizationId, spaceId, controller.signal)
      .then((loaded) => {
        if (!current) return;

        setDocuments({ spaceId, rows: loaded });
        // Otherwise a banner from the space that failed outlives it, sitting
        // above the rows of the space that loaded fine.
        setFailure(null);
      })
      .catch((thrown: unknown) => {
        if (current) setFailure(classify(thrown));
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [organizationId, selectedSpaceId, reloadToken]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  /** Empty until this space's own rows have arrived. */
  const visibleDocuments =
    documents !== null && documents.spaceId === selectedSpaceId
      ? documents.rows
      : [];

  const act = async (work: Work) => {
    setBusy(true);
    setFailure(null);

    try {
      await work();
      reload();

      return true;
    } catch (thrown: unknown) {
      setFailure(classify(thrown));

      return false;
    } finally {
      setBusy(false);
    }
  };

  const submitSpace = async () => {
    const created = await act(() =>
      createKnowledgeSpace(organizationId, {
        slug: slug.trim(),
        name: spaceName.trim(),
      }),
    );

    if (created) {
      setSlug('');
      setSpaceName('');
    }
  };

  const submitDocument = async () => {
    if (selectedSpaceId === null) return;

    const stored = await act(() =>
      ingestKnowledgeDocument(organizationId, selectedSpaceId, {
        title: title.trim(),
        content,
      }),
    );

    /**
     * Cleared only on success. A refused document is often refused for
     * something the operator can fix — a title collision, a size limit — and
     * emptying a textarea they have just pasted into is the worst possible
     * response to a correctable error.
     */
    if (stored) {
      setTitle('');
      setContent('');
    }
  };

  const selected = spaces.find((space) => space.id === selectedSpaceId) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />

      {failure !== null ? (
        <Card>
          <CardContent className="space-y-1 py-4 text-sm text-destructive">
            <p>{t(`error.${failure.kind}`)}</p>
            {(
              failure.details.issues ??
              (failure.details.reason === undefined
                ? []
                : [failure.details.reason])
            ).map((reason) => (
              <p key={reason} className="text-xs">
                {reason}
              </p>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {isLoading ? (
        <Loader2 aria-label={t('loading')} className="size-5 animate-spin" />
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="text-sm font-semibold">{t('spaces.heading')}</h2>

            {spaces.length === 0 ? (
              <EmptyState
                icon={<FileText aria-hidden className="size-5" />}
                title={t('spaces.empty')}
                description={t('spaces.emptyHint')}
              />
            ) : (
              <div className="flex flex-wrap gap-2">
                {spaces.map((space) => (
                  <Button
                    key={space.id}
                    size="sm"
                    variant={
                      space.id === selectedSpaceId ? 'default' : 'outline'
                    }
                    onClick={() => setSelectedSpaceId(space.id)}
                  >
                    <bdi>{space.name}</bdi>
                    <Badge variant="secondary">{space.documentCount}</Badge>
                  </Button>
                ))}
              </div>
            )}

            {canWrite ? (
              <Card>
                <CardContent className="flex flex-wrap items-end gap-3 py-4">
                  <div className="space-y-1">
                    <Label htmlFor="knowledge-space-slug">
                      {t('spaces.slug')}
                    </Label>
                    <Input
                      id="knowledge-space-slug"
                      value={slug}
                      disabled={busy}
                      onChange={(event) => setSlug(event.target.value)}
                    />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="knowledge-space-name">
                      {t('spaces.name')}
                    </Label>
                    <Input
                      id="knowledge-space-name"
                      value={spaceName}
                      disabled={busy}
                      onChange={(event) => setSpaceName(event.target.value)}
                    />
                  </div>

                  <Button
                    size="sm"
                    disabled={
                      busy || slug.trim() === '' || spaceName.trim() === ''
                    }
                    onClick={() => void submitSpace()}
                  >
                    {t('spaces.create')}
                  </Button>

                  {selected !== null ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void act(() =>
                          deleteKnowledgeSpace(organizationId, selected.id),
                        )
                      }
                    >
                      <Trash2 aria-hidden className="size-4" />
                      {t('spaces.delete', { name: selected.name })}
                    </Button>
                  ) : null}
                </CardContent>
              </Card>
            ) : null}
          </section>

          {selected !== null ? (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold">
                {t('documents.heading', { space: selected.name })}
              </h2>

              {visibleDocuments.length === 0 ? (
                <EmptyState
                  icon={<FileText aria-hidden className="size-5" />}
                  title={t('documents.empty')}
                />
              ) : (
                <Card>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('documents.column.title')}</TableHead>
                        <TableHead>{t('documents.column.passages')}</TableHead>
                        <TableHead>{t('documents.column.revision')}</TableHead>
                        <TableHead>{t('documents.column.updated')}</TableHead>
                        <TableHead className="text-end">
                          {t('documents.column.actions')}
                        </TableHead>
                      </TableRow>
                    </TableHeader>

                    <TableBody>
                      {visibleDocuments.map((document) => (
                        <TableRow key={document.id}>
                          <TableCell>
                            <bdi>{document.title}</bdi>
                          </TableCell>
                          <TableCell>{document._count.chunks}</TableCell>
                          <TableCell>{document.revision}</TableCell>
                          <TableCell>
                            {format.dateTime(new Date(document.updatedAt), {
                              dateStyle: 'medium',
                            })}
                          </TableCell>
                          <TableCell className="text-end">
                            {canWrite ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                aria-label={t('documents.delete', {
                                  title: document.title,
                                })}
                                onClick={() =>
                                  void act(() =>
                                    deleteKnowledgeDocument(
                                      organizationId,
                                      document.id,
                                    ),
                                  )
                                }
                              >
                                <Trash2 aria-hidden className="size-4" />
                              </Button>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Card>
              )}

              {canWrite ? (
                <Card>
                  <CardContent className="space-y-3 py-4">
                    <div className="space-y-1">
                      <Label htmlFor="knowledge-document-title">
                        {t('documents.title')}
                      </Label>
                      <Input
                        id="knowledge-document-title"
                        value={title}
                        disabled={busy}
                        onChange={(event) => setTitle(event.target.value)}
                      />
                    </div>

                    <div className="space-y-1">
                      <Label htmlFor="knowledge-document-content">
                        {t('documents.content')}
                      </Label>
                      <Textarea
                        id="knowledge-document-content"
                        rows={8}
                        value={content}
                        disabled={busy}
                        onChange={(
                          event: React.ChangeEvent<HTMLTextAreaElement>,
                        ) => setContent(event.target.value)}
                      />
                    </div>

                    <p className="text-xs text-muted-foreground">
                      {t('documents.replaceHint')}
                    </p>

                    <Button
                      size="sm"
                      disabled={
                        busy || title.trim() === '' || content.trim() === ''
                      }
                      onClick={() => void submitDocument()}
                    >
                      {t('documents.store')}
                    </Button>
                  </CardContent>
                </Card>
              ) : null}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
