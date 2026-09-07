'use client';

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
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';

import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { useOrganizationRolePermission } from '@/features/authorization/use-permissions';
import {
  ApiError,
  ApiUnavailableError,
  errorDetailLines,
  NO_ERROR_DETAILS,
  type ApiErrorDetails,
} from '@/lib/application-api';

import {
  clearKnowledgeSpace,
  deleteKnowledgeDocument,
  ingestKnowledgeDocument,
  listKnowledgeDocuments,
  listKnowledgeSpaces,
  type KnowledgeDocumentPage,
  type KnowledgeSpace,
  type KnowledgeSpaceSlug,
} from '../organization-api';
import { useOrganizationContext } from '../organization-context';

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
  const details =
    thrown instanceof ApiError ? thrown.details : NO_ERROR_DETAILS;

  if (thrown instanceof ApiUnavailableError) {
    return { kind: 'unavailable', details };
  }

  if (thrown instanceof ApiError) {
    if (thrown.status === 401) return { kind: 'unauthenticated', details };
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

export function OrganizationKnowledgeBlock() {
  const { organization } = useOrganizationContext();
  return <OrganizationKnowledge key={organization.id} />;
}

function OrganizationKnowledge() {
  const t = useTranslations('Knowledge');
  const format = useFormatter();
  const { organization, viewer } = useOrganizationContext();

  const canWrite = useOrganizationRolePermission(viewer.member?.role, {
    knowledge: ['write'],
  });

  const organizationId = organization.id;
  const queryClient = useQueryClient();
  const knowledgeKey = ['organizations', organizationId, 'knowledge'] as const;
  const spacesQuery = useQuery({
    queryKey: [...knowledgeKey, 'spaces'],
    queryFn: ({ signal }) => listKnowledgeSpaces(organizationId, signal),
  });
  const spaces = spacesQuery.data ?? [];
  const [selection, setSelection] = useState<KnowledgeSpaceSlug | null>(null);
  const selectedSlug =
    spaces.find((space) => space.slug === selection)?.slug ??
    spaces.find((space) => space.configured)?.slug ??
    spaces[0]?.slug ??
    null;
  // Remember the initial choice even if a later write changes space counts.
  if (selection === null && selectedSlug !== null) setSelection(selectedSlug);
  const documents = useInfiniteQuery({
    queryKey: [...knowledgeKey, 'documents', selectedSlug],
    enabled: selectedSlug !== null,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      listKnowledgeDocuments(organizationId, selectedSlug!, {
        signal,
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
      }),
    getNextPageParam: (page) => page.nextCursor,
  });
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const action = useMutation({
    mutationFn: async (
      write:
        | {
            kind: 'store';
            slug: KnowledgeSpaceSlug;
            title: string;
            content: string;
          }
        | { kind: 'clear'; slug: KnowledgeSpaceSlug }
        | { kind: 'delete'; slug: KnowledgeSpaceSlug; documentId: string },
    ) => {
      if (write.kind === 'store')
        return ingestKnowledgeDocument(organizationId, write.slug, {
          title: write.title.trim(),
          content: write.content,
        });
      if (write.kind === 'clear')
        return clearKnowledgeSpace(organizationId, write.slug);
      return deleteKnowledgeDocument(organizationId, write.documentId);
    },
    onSuccess: async (_data, write) => {
      const documentsKey = [...knowledgeKey, 'documents', write.slug];
      await queryClient.cancelQueries({ queryKey: documentsKey });
      // Writes previously reloaded the first page, resetting pagination.
      queryClient.setQueryData<InfiniteData<KnowledgeDocumentPage>>(
        documentsKey,
        (data) =>
          data && {
            pages: data.pages.slice(0, 1),
            pageParams: data.pageParams.slice(0, 1),
          },
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: [...knowledgeKey, 'spaces'],
        }),
        queryClient.invalidateQueries({ queryKey: documentsKey }),
      ]);
    },
  });
  const busy = action.isPending;
  const isLoading = spacesQuery.isFetching && spacesQuery.data === undefined;
  const isLoadingMore = documents.isFetchingNextPage;
  const visibleDocuments =
    documents.data?.pages.flatMap((page) => page.items) ?? [];
  const error = action.error ?? spacesQuery.error ?? documents.error;
  const failure = error === null ? null : classify(error);

  const submitDocument = () => {
    if (selectedSlug === null) return;
    action.mutate(
      { kind: 'store', slug: selectedSlug, title, content },
      {
        onSuccess: () => {
          setTitle('');
          setContent('');
        },
      },
    );
  };

  const selected = spaces.find((space) => space.slug === selectedSlug) ?? null;

  const nameOf = (space: KnowledgeSpace) => t(`spaces.name.${space.slug}`);

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />

      {failure !== null ? (
        <Card>
          <CardContent className="space-y-1 py-4 text-sm text-destructive">
            <p>{t(`error.${failure.kind}`)}</p>
            {errorDetailLines(failure.details).map((reason) => (
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
                  onClick={() => {
                    if (space.slug !== selectedSlug) {
                      action.reset();
                      setSelection(space.slug);
                    }
                  }}
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
                  action.mutate({ kind: 'clear', slug: selected.slug })
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
                                  action.mutate({
                                    kind: 'delete',
                                    slug: selected.slug,
                                    documentId: document.id,
                                  })
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
              {documents.hasNextPage ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={documents.isFetching || busy}
                  onClick={() =>
                    void documents.fetchNextPage({ cancelRefetch: false })
                  }
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
