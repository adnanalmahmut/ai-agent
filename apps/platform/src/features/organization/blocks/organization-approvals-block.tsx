import { Badge, Button, Card, CardContent, Textarea } from '@repo/ui';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
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

/**
 * Human approval of proposed agent actions.
 *
 * One list, filtered by decision state, and two buttons per pending proposal.
 * There is deliberately nothing else: no editing of what the agent wrote, no
 * choosing a different recipient, no "send now". A person reads the proposal
 * as it stands and decides on it; the effect itself happens in the worker
 * after every precondition is checked again, which is why the row keeps
 * showing state after the decision.
 *
 * The decide buttons render only for a role the server would allow, read from
 * the viewer's membership in *this* organization. That is a courtesy — the
 * backend refuses a member's click regardless — and the 409 that a second
 * decider receives is shown as what it is: somebody else got there first.
 */

const PAGE_SIZE = 25;

type LoadState = 'idle' | 'loading' | 'error';

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
  /**
   * The filter the list currently belongs to, readable after an `await`.
   *
   * `loadMore` appends into whatever list is on screen when its request
   * resolves. If the reader switched filters while it was in flight, that
   * list is a different one, and the page must be dropped rather than
   * appended onto it.
   */
  const currentFilter = useRef<Filter>(filter);

  useEffect(() => {
    currentFilter.current = filter;
  }, [filter]);
  const [items, setItems] = useState<AgentActionApproval[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [isAppending, setIsAppending] = useState(false);
  const [appendFailed, setAppendFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  /**
   * The two things that restart the first page also put the block back into
   * its loading state, here rather than inside the effect: the state change
   * belongs to the event that caused it, and an effect that set state on
   * every run would render twice for every fetch.
   */
  const changeFilter = (next: Filter) => {
    setFilter(next);
    setItems([]);
    setCursor(null);
    setAppendFailed(false);
    setState('loading');
  };

  const reload = () => {
    setReloadToken((token) => token + 1);
    setState('loading');
  };

  useEffect(() => {
    const controller = new AbortController();
    let current = true;

    listAgentActionApprovals(
      organizationId,
      { limit: PAGE_SIZE, ...(filter === 'ALL' ? {} : { status: filter }) },
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
  }, [organizationId, filter, reloadToken]);

  const loadMore = useCallback(async () => {
    if (cursor === null) return;

    const requested = filter;
    setIsAppending(true);
    setAppendFailed(false);

    try {
      const page = await listAgentActionApprovals(organizationId, {
        limit: PAGE_SIZE,
        cursor,
        ...(requested === 'ALL' ? {} : { status: requested }),
      });

      // A page for a filter the reader has since left belongs to nobody.
      if (currentFilter.current !== requested) return;

      setItems((previous) => [...previous, ...page.items]);
      setCursor(page.nextCursor);
    } catch {
      if (currentFilter.current === requested) setAppendFailed(true);
    } finally {
      setIsAppending(false);
    }
  }, [cursor, filter, organizationId]);

  /** A decided row replaces its previous self in place; nothing is refetched. */
  const replace = useCallback((decided: AgentActionApproval) => {
    setItems((previous) =>
      previous.map((item) =>
        item.toolExecutionId === decided.toolExecutionId ? decided : item,
      ),
    );
  }, []);

  const isLoading = state === 'loading' || isAppending;

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
            onClick={() => changeFilter(value)}
          >
            {t(`filter.${value}`)}
          </Button>
        ))}
      </div>

      {state === 'error' ? (
        <Card>
          <CardContent className="space-y-2 py-4 text-sm">
            <p className="text-destructive">{t('error.load')}</p>
            <Button size="sm" variant="outline" onClick={reload}>
              {t('error.retry')}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {items.length === 0 && !isLoading && state !== 'error' ? (
        <EmptyState
          icon={<ShieldCheck aria-hidden className="size-5" />}
          title={t('empty.title')}
          description={t('empty.description')}
        />
      ) : null}

      {items.length > 0 ? (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.toolExecutionId}>
              <ApprovalCard
                item={item}
                organizationId={organizationId}
                canDecide={canDecide}
                onDecided={replace}
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

function isKnownFailure(
  code: string,
): code is (typeof TOOL_FAILURE_CODES)[number] {
  return (TOOL_FAILURE_CODES as readonly string[]).includes(code);
}

type DecisionState =
  | { kind: 'idle' }
  | { kind: 'pending'; decision: 'approve' | 'reject' }
  | { kind: 'conflict' }
  | { kind: 'error' };

function ApprovalCard({
  item,
  organizationId,
  canDecide,
  onDecided,
}: {
  item: AgentActionApproval;
  organizationId: string;
  canDecide: boolean;
  onDecided: (decided: AgentActionApproval) => void;
}) {
  const t = useTranslations('Approvals');
  const [note, setNote] = useState('');
  const [decision, setDecision] = useState<DecisionState>({ kind: 'idle' });

  const decide = async (which: 'approve' | 'reject') => {
    setDecision({ kind: 'pending', decision: which });

    try {
      const trimmed = note.trim();
      const decided =
        which === 'approve'
          ? await approveAgentAction(
              organizationId,
              item.toolExecutionId,
              trimmed || undefined,
            )
          : await rejectAgentAction(
              organizationId,
              item.toolExecutionId,
              trimmed || undefined,
            );

      setDecision({ kind: 'idle' });
      onDecided(decided);
    } catch (thrown) {
      setDecision({
        kind:
          thrown instanceof ApiError && thrown.status === 409
            ? 'conflict'
            : 'error',
      });
    }
  };

  const isPending = decision.kind === 'pending';
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
          <p className="text-sm text-muted-foreground">{t('proposal.unreadable')}</p>
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
                onClick={() => void decide('approve')}
                disabled={isPending}
                aria-busy={isPending && decision.decision === 'approve'}
              >
                {t('actions.approve')}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => void decide('reject')}
                disabled={isPending}
                aria-busy={isPending && decision.decision === 'reject'}
              >
                {t('actions.reject')}
              </Button>
              {decision.kind === 'conflict' ? (
                <span className="text-sm text-muted-foreground">
                  {t('error.conflict')}
                </span>
              ) : null}
              {decision.kind === 'error' ? (
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
