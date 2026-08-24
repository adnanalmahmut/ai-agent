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
  clearKnowledgeSpace,
  deleteKnowledgeDocument,
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
   * fetch returned. Carrying the slug makes that state unrepresentable — rows
   * are shown only to the space that asked for them.
   *
   * `nextCursor` rides along for the same reason: a cursor is a position in one
   * space's ordering and means nothing in another's.
   */
  const [documents, setDocuments] = useState<{
    slug: string;
    rows: KnowledgeDocument[];
    nextCursor: string | null;
  } | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

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
        setSelectedSlug((selected) =>
          selected !== null && loaded.some((space) => space.slug === selected)
            ? selected
            : /**
               * The first space that already holds something, falling back to
               * the first in the taxonomy.
               *
               * Every organization gets all eight, so "the first one" would
               * always be the same space regardless of what they use — and an
               * operator who has only written brand notes would land on an
               * empty organization profile every time.
               */
              (loaded.find((space) => space.configured)?.slug ??
              loaded[0]?.slug ??
              null),
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
    if (selectedSlug === null) return;

    const controller = new AbortController();
    let current = true;
    const slug = selectedSlug;

    listKnowledgeDocuments(organizationId, slug, { signal: controller.signal })
      .then((page) => {
        if (!current) return;

        setDocuments({ slug, rows: page.items, nextCursor: page.nextCursor });
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
  }, [organizationId, selectedSlug, reloadToken]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  /** Empty until this space's own rows have arrived. */
  const visible =
    documents !== null && documents.slug === selectedSlug ? documents : null;
  const visibleDocuments = visible?.rows ?? [];

  /**
   * Appends the next page rather than replacing the list.
   *
   * The cursor is checked against the space it belongs to before it is used: a
   * position in one space's ordering means nothing in another's, and a stale
   * click after switching spaces would otherwise page the wrong collection.
   */
  const loadMore = useCallback(async () => {
    if (visible === null || visible.nextCursor === null) return;

    const slug = visible.slug;
    const cursor = visible.nextCursor;

    setIsLoadingMore(true);

    try {
      const page = await listKnowledgeDocuments(organizationId, slug, {
        cursor,
      });

      setDocuments((previous) =>
        previous === null || previous.slug !== slug
          ? previous
          : {
              slug,
              rows: [...previous.rows, ...page.items],
              nextCursor: page.nextCursor,
            },
      );
      setFailure(null);
    } catch (thrown: unknown) {
      setFailure(classify(thrown));
    } finally {
      setIsLoadingMore(false);
    }
  }, [organizationId, visible]);

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

  const submitDocument = async () => {
    if (selectedSlug === null) return;

    const stored = await act(() =>
      ingestKnowledgeDocument(organizationId, selectedSlug, {
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

  const selected = spaces.find((space) => space.slug === selectedSlug) ?? null;

  /**
   * The space's name in the reader's language, not the server's.
   *
   * The taxonomy is code-owned on both sides, so the slug is the join and the
   * label is a translation — an operator reading Arabic should not be shown an
   * English taxonomy just because the column happens to hold one. The slug's
   * dots are already `use-intl`'s path separator, so `brand.voice` addresses
   * the nested message without any transformation.
   *
   * There is deliberately no fallback to `space.name`. A space with no
   * translation is a mistake in this repository rather than a state to render
   * around, and `messages.test.ts` asserts every mirrored slug has copy in both
   * dictionaries.
   */
  const nameOf = (space: KnowledgeSpace) => t(`spaces.name.${space.slug}`);

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
            <p className="text-xs text-muted-foreground">
              {t('spaces.taxonomyHint')}
            </p>

            {/*
              Every space, always. The taxonomy is the application's, so there
              is no empty state and no create form — what varies between
              organizations is what is stored in each, which the badge shows.
            */}
            <div className="flex flex-wrap gap-2">
              {spaces.map((space) => (
                <Button
                  key={space.slug}
                  size="sm"
                  variant={space.slug === selectedSlug ? 'default' : 'outline'}
                  onClick={() => setSelectedSlug(space.slug)}
                >
                  <bdi>{nameOf(space)}</bdi>
                  <Badge variant="secondary">{space.documentCount}</Badge>
                </Button>
              ))}
            </div>

            {canWrite && selected !== null && selected.documentCount > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    clearKnowledgeSpace(organizationId, selected.slug),
                  )
                }
              >
                <Trash2 aria-hidden className="size-4" />
                {t('spaces.clear', { name: nameOf(selected) })}
              </Button>
            ) : null}
          </section>

          {selected !== null ? (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold">
                {t('documents.heading', { space: nameOf(selected) })}
              </h2>
              <p className="text-xs text-muted-foreground">
                <bdi>{selected.description}</bdi>
              </p>

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

              {/*
                A cursor, not a page number. The server hands back the position
                of the last row it returned, so a document ingested while
                somebody is reading cannot make the next page skip or repeat
                one — which is exactly what an offset would do.
              */}
              {visible?.nextCursor !== null && visible !== null ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isLoadingMore || busy}
                  onClick={() => void loadMore()}
                >
                  {isLoadingMore ? (
                    <Loader2 aria-hidden className="size-4 animate-spin" />
                  ) : null}
                  {t('documents.more')}
                </Button>
              ) : null}

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
