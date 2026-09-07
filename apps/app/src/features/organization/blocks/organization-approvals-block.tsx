'use client';

import { Badge, Button, Card, CardContent, Textarea } from '@repo/ui';
import { Loader2, ShieldCheck } from 'lucide-react';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';

import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { useOrganizationRolePermission } from '@/features/authorization/use-permissions';
import { ApiError } from '@/lib/application-api';
import {
  approveAgentAction,
  listAgentActionApprovals,
  rejectAgentAction,
  TOOL_FAILURE_CODES,
  type AgentActionApproval,
  type AgentActionApprovalStatus,
} from '../organization-api';
import { useOrganizationContext } from '../organization-context';

const PAGE_SIZE = 25;

type Filter = AgentActionApprovalStatus | 'ALL';

const FILTERS: readonly Filter[] = ['PENDING', 'APPROVED', 'REJECTED', 'ALL'];

export function OrganizationApprovalsBlock() {
  const t = useTranslations('Approvals');
  const { organization, viewer } = useOrganizationContext();
  const organizationId = organization.id;

  const canDecide = useOrganizationRolePermission(viewer.member?.role, {
    agentActionApproval: ['decide'],
  });

  const [filter, setFilter] = useState<Filter>('PENDING');
  const approvals = useInfiniteQuery({
    queryKey: [
      'organizations',
      organizationId,
      'approvals',
      { filter, limit: PAGE_SIZE },
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      listAgentActionApprovals(
        organizationId,
        {
          limit: PAGE_SIZE,
          ...(filter === 'ALL' ? {} : { status: filter }),
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
        signal,
      ),
    getNextPageParam: (page) => page.nextCursor,
  });
  const items = approvals.data?.pages.flatMap((page) => page.items) ?? [];
  const isLoading = approvals.isFetching;
  const loadFailed = approvals.isError && !approvals.isFetchNextPageError;
  const appendFailed = approvals.isFetchNextPageError;

  return (
    <div className="space-y-4">
      <PageHeader title={t('title')} description={t('description')} />

      <div
        role="group"
        aria-label={t('filter.label')}
        className="inline-flex items-center gap-1 rounded-lg bg-secondary/70 p-1 border border-border/40"
      >
        {FILTERS.map((value) => (
          <Button
            key={value}
            size="sm"
            variant={filter === value ? 'default' : 'ghost'}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {t(`filter.${value}`)}
          </Button>
        ))}
      </div>

      {loadFailed ? (
        <Card>
          <CardContent className="space-y-2 py-4 text-sm">
            <p className="text-destructive">{t('error.load')}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void approvals.refetch()}
            >
              {t('error.retry')}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {items.length === 0 && !isLoading && !loadFailed ? (
        <EmptyState
          icon={<ShieldCheck aria-hidden className="size-5" />}
          title={t('empty.title')}
          description={t('empty.description')}
        />
      ) : null}

      {items.length > 0 ? (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={`${organizationId}:${filter}:${item.toolExecutionId}`}>
              <ApprovalCard
                item={item}
                organizationId={organizationId}
                canDecide={canDecide}
              />
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

      {approvals.hasNextPage && !isLoading ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void approvals.fetchNextPage({ cancelRefetch: false })
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

function isKnownFailure(
  code: string,
): code is (typeof TOOL_FAILURE_CODES)[number] {
  return (TOOL_FAILURE_CODES as readonly string[]).includes(code);
}

function ApprovalCard({
  item,
  organizationId,
  canDecide,
}: {
  item: AgentActionApproval;
  organizationId: string;
  canDecide: boolean;
}) {
  const t = useTranslations('Approvals');
  const [note, setNote] = useState('');
  const queryClient = useQueryClient();
  const decision = useMutation({
    mutationFn: ({
      which,
      note,
    }: {
      which: 'approve' | 'reject';
      note: string;
    }) =>
      which === 'approve'
        ? approveAgentAction(
            organizationId,
            item.toolExecutionId,
            note.trim() || undefined,
          )
        : rejectAgentAction(
            organizationId,
            item.toolExecutionId,
            note.trim() || undefined,
          ),
    onSuccess: async (decided) => {
      const queryKey = ['organizations', organizationId, 'approvals'] as const;
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueriesData<
        InfiniteData<Awaited<ReturnType<typeof listAgentActionApprovals>>>
      >(
        { queryKey },
        (data) =>
          data && {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              items: page.items.map((row) =>
                row.toolExecutionId === decided.toolExecutionId ? decided : row,
              ),
            })),
          },
      );
      // Keep the decided card visible in place. Revisit/refetch reads the
      // authoritative filtered list; all cached filters are now stale.
      await queryClient.invalidateQueries({ queryKey, refetchType: 'none' });
    },
  });
  const isPending = decision.isPending;
  const conflict =
    decision.error instanceof ApiError && decision.error.status === 409;

  const pendingDecision = item.approval.status === 'PENDING';

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              {t(
                item.toolId === 'notification.send'
                  ? 'tool.notificationSend'
                  : 'tool.unknown',
              )}
            </Badge>
            <Badge
              variant={
                item.approval.status === 'PENDING' ? 'default' : 'secondary'
              }
            >
              {t(`status.${item.approval.status}`)}
            </Badge>
            {item.approval.status === 'APPROVED' ? (
              <Badge variant="outline">
                {t(`effect.${item.executionStatus}`)}
              </Badge>
            ) : null}
          </div>
          <span className="text-xs text-muted-foreground">
            {t('requestedAt', { at: new Date(item.approval.requestedAt) })}
          </span>
        </div>

        {item.proposal ? (
          <div className="space-y-1 text-sm">
            <p>
              <span className="font-medium">{t('proposal.recipient')}</span>{' '}
              {item.proposal.recipient ? (
                <bdi>
                  {item.proposal.recipient.name} ·{' '}
                  {item.proposal.recipient.email}
                </bdi>
              ) : (
                <span className="text-destructive">
                  {t('proposal.recipientGone')}
                </span>
              )}
            </p>
            <p>
              <span className="font-medium">{t('proposal.subject')}</span>{' '}
              <bdi>{item.proposal.subject}</bdi>
            </p>
            <p className="whitespace-pre-wrap rounded-md border border-border/60 bg-muted/40 p-3">
              <bdi>{item.proposal.body}</bdi>
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('proposal.unreadable')}
          </p>
        )}

        {item.approval.decisionNote ? (
          <p className="text-sm text-muted-foreground">
            <span className="font-medium">{t('note.label')}</span>{' '}
            <bdi>{item.approval.decisionNote}</bdi>
          </p>
        ) : null}

        {item.effect.failureCode ? (
          <p className="text-sm text-destructive">
            {t(
              isKnownFailure(item.effect.failureCode)
                ? `failure.${item.effect.failureCode}`
                : 'effect.FAILED',
            )}
          </p>
        ) : null}

        {pendingDecision && canDecide ? (
          <div className="space-y-2">
            <Textarea
              aria-label={t('note.placeholder')}
              placeholder={t('note.placeholder')}
              value={note}
              maxLength={500}
              onChange={(event) => setNote(event.target.value)}
              disabled={isPending}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={() => decision.mutate({ which: 'approve', note })}
                disabled={isPending}
                aria-busy={isPending && decision.variables?.which === 'approve'}
              >
                {t('actions.approve')}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => decision.mutate({ which: 'reject', note })}
                disabled={isPending}
                aria-busy={isPending && decision.variables?.which === 'reject'}
              >
                {t('actions.reject')}
              </Button>
              {conflict ? (
                <span className="text-sm text-muted-foreground">
                  {t('error.conflict')}
                </span>
              ) : null}
              {decision.isError && !conflict ? (
                <span className="text-sm text-destructive">
                  {t('error.decide')}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {pendingDecision && !canDecide ? (
          <p className="text-sm text-muted-foreground">{t('readOnly')}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
