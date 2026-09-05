'use client';

import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Label,
  Textarea,
} from '@repo/ui';
import { Check, Lightbulb, Loader2, RefreshCw } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';

import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { useOrganizationRolePermission } from '@/features/authorization/use-permissions';
import {
  classifyContentIdeaFailure as classify,
  isDecided,
  isUnreadable,
  type ContentIdeaFailure,
} from '../content-idea-failures';
import {
  clearPendingSubmission,
  keyForSubmission,
  writePendingSubmission,
  type PendingSubmission,
} from '../content-idea-submission';

import {
  ORGANIZATION_DETAIL_ROUTES,
  ORGANIZATION_ROUTES,
} from '@/features/auth/routes';
import { Link, useRouter } from '@/i18n/navigation';
import {
  CONTENT_IDEA_LANGUAGES,
  createContentProjectFromIdea,
  getContentIdeaAvailability,
  getContentIdeaOperation,
  requestContentIdeas,
  type ContentIdeaAvailability,
  type ContentIdeaLanguage,
  type ContentIdeaOperation,
  type ContentIdeaRequest,
} from '../organization-api';
import { useOrganizationContext } from '../organization-context';

const POLL_INTERVAL_MS = 2_000;

const POLL_TIMEOUT_MS = 180_000;

const OPERATION_PARAM = 'operation';

type Stopped = 'timeout' | 'refused';

const TERMINAL: ReadonlyArray<ContentIdeaOperation['status']> = [
  'SUCCEEDED',
  'FAILED',
];

const LIMITS = {
  topic: 200,
  goal: 300,
  audience: 200,
  guidance: 1_000,
  numberOfIdeas: 10,
};

type FormState = {
  topic: string;
  goal: string;
  language: ContentIdeaLanguage;
  audience: string;
  guidance: string;
  numberOfIdeas: number;
};

const EMPTY_FORM: FormState = {
  topic: '',
  goal: '',
  language: 'en',
  audience: '',
  guidance: '',
  numberOfIdeas: 5,
};

const promoteMessage = (
  failure: ContentIdeaFailure | null,
): 'forbidden' | 'unavailable' | 'failed' => {
  if (failure === null) return 'failed';
  if (failure.kind === 'forbidden') return 'forbidden';
  if (failure.kind === 'unavailable') return 'unavailable';

  return 'failed';
};

const isSubmittable = (form: FormState) =>
  within(form.topic, 3, LIMITS.topic) &&
  within(form.goal, 3, LIMITS.goal) &&
  (form.audience.trim() === '' || within(form.audience, 3, LIMITS.audience)) &&
  within(form.guidance, 0, LIMITS.guidance) &&
  isCount(form.numberOfIdeas);

const within = (value: string, least: number, most: number) => {
  const length = value.trim().length;

  return length >= least && most >= length;
};

const isCount = (value: number) =>
  Number.isInteger(value) && value >= 1 && LIMITS.numberOfIdeas >= value;

/**
 * Server state for this screen hangs off one prefix, so an organization's
 * availability and its runs are cached, scoped and dropped together.
 */
const contentIdeasKey = (organizationId: string) =>
  ['organizations', organizationId, 'content-ideas'] as const;

const operationKeyFor = (organizationId: string, operationId: string | null) =>
  [...contentIdeasKey(organizationId), 'operation', operationId] as const;

const toRequest = (form: FormState): ContentIdeaRequest => ({
  topic: form.topic.trim(),
  goal: form.goal.trim(),
  language: form.language,
  ...(form.audience.trim() === '' ? {} : { audience: form.audience.trim() }),
  ...(form.guidance.trim() === '' ? {} : { guidance: form.guidance.trim() }),
  numberOfIdeas: form.numberOfIdeas,
});

export function OrganizationContentIdeasBlock({
  pollIntervalMs = POLL_INTERVAL_MS,
  pollTimeoutMs = POLL_TIMEOUT_MS,
}: { pollIntervalMs?: number; pollTimeoutMs?: number } = {}) {
  const t = useTranslations('ContentIdeas');
  const { organization, viewer } = useOrganizationContext();
  const searchParams = useSearchParams();
  const router = useRouter();

  const canCreate = useOrganizationRolePermission(viewer.member?.role, {
    contentIdea: ['create'],
  });

  const canPromote = useOrganizationRolePermission(viewer.member?.role, {
    contentProject: ['create'],
  });

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const field = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) =>
      setForm((previous) => ({ ...previous, [key]: value })),
    [],
  );

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [failure, setFailure] = useState<ContentIdeaFailure | null>(null);
  const [stopped, setStopped] = useState<Stopped | null>(null);
  // The run this screen has just been given, so it is watched in the moment
  // between the server accepting it and the address catching up.
  const [accepted, setAccepted] = useState<{
    organizationId: string;
    operationId: string;
  } | null>(null);

  const pendingKey = useRef<PendingSubmission | null>(null);

  const organizationId = organization.id;
  const queryClient = useQueryClient();

  const routeOperationId = searchParams.get(OPERATION_PARAM);

  // The address is authoritative whenever it names a run: a reader can put a
  // different operation into it without leaving the screen. The accepted run
  // covers only the gap before the rewrite lands.
  const watchedId =
    routeOperationId ??
    (accepted !== null && accepted.organizationId === organizationId
      ? accepted.operationId
      : null);

  const putOperationInRoute = useCallback(
    (operationId: string | null) => {
      const next = new URLSearchParams(searchParams.toString());

      if (operationId === null) next.delete(OPERATION_PARAM);
      else next.set(OPERATION_PARAM, operationId);

      // `URLSearchParams` is carried forward whole rather than rebuilt as an
      // object, so a repeated key the page arrived with survives the rewrite.
      const query = next.toString();
      const path = ORGANIZATION_ROUTES.contentIdeas(organizationId);

      router.replace(query ? `${path}?${query}` : path);
    },
    [organizationId, router, searchParams],
  );

  const availabilityQuery = useQuery({
    queryKey: [...contentIdeasKey(organizationId), 'availability'],
    queryFn: ({ signal }) => getContentIdeaAvailability(organizationId, signal),
  });

  const availability: ContentIdeaAvailability | null =
    availabilityQuery.data ?? null;

  const operationKey = operationKeyFor(organizationId, watchedId);

  /**
   * One read of one run, asked for again while that run is unfinished.
   *
   * The organization is part of the key, so a reader who moves to another
   * organization is never shown the run they left behind, and the request for
   * it is abandoned through the signal rather than raced.
   *
   * What a read *means* is decided here rather than in an effect, because
   * here is where both the answer and what the screen already held are in
   * hand at the same time.
   */
  const run = useQuery({
    queryKey: operationKey,
    queryFn: async ({ signal }) => {
      // `enabled` keeps this unreachable while the screen watches nothing.
      if (watchedId === null) return null;

      const held = queryClient.getQueryData<ContentIdeaOperation | null>(
        operationKey,
      );

      try {
        const next = await getContentIdeaOperation(
          organizationId,
          watchedId,
          signal,
        );

        // A read the reader has moved on from still arrives here when the
        // request did not honour the signal, or when it settled inside the
        // race with its own cancellation. Query drops the answer, but nothing
        // outside Query would stop it speaking for the run now on screen, so
        // it says nothing at all past this point.
        if (signal.aborted) return next;

        // First sight of this run: whatever the last one refused or outlasted
        // is not what the reader is looking at any more.
        if (held == null) {
          setFailure(null);
          setStopped(null);
        }

        // A finished run is the last word on itself. Query already refuses to
        // let an older read land after a newer one — it deduplicates fetches
        // for a key and abandons the one in flight when the screen moves on —
        // so this states the rule rather than being the only thing enforcing
        // it, and keeps it true of the data whatever the scheduling does.
        const settled = queryClient.getQueryData<ContentIdeaOperation | null>(
          operationKey,
        );

        return settled != null && TERMINAL.includes(settled.status)
          ? settled
          : next;
      } catch (thrown: unknown) {
        // A read that was abandoned refuses on its way out; that refusal
        // belongs to the run the reader left, not to the one in front of
        // them. Anything else the screen cannot read a verdict from — a rate
        // limit, a broken server, a request that never arrived — is left to
        // the next poll rather than shown to the reader.
        if (signal.aborted || !isUnreadable(thrown)) throw thrown;

        setFailure(classify(thrown));

        // A run that was being watched keeps its place in the address and
        // simply stops being followed. One that could never be read at all is
        // not this screen's to show, and leaves the address so a reload does
        // not land on it again.
        if (held == null) putOperationInRoute(null);
        else setStopped('refused');

        throw thrown;
      }
    },
    enabled: watchedId !== null,
    // Polling is what this query is for: it follows an unfinished run until
    // the run finishes, the wait is given up on, or the server refuses it.
    refetchInterval: ({ state }) => {
      const current = state.data;
      const unfinished = current != null && !TERMINAL.includes(current.status);

      return unfinished && stopped === null ? pollIntervalMs : false;
    },
    // A run is followed whether or not the tab is in front, and whether or
    // not the browser believes it is online — which is what the interval this
    // replaced did. Somebody who switches tabs while an agent works comes
    // back to the answer rather than to a stalled spinner.
    refetchIntervalInBackground: true,
    networkMode: 'always',
  });

  const operation = run.data ?? null;
  const runId = operation?.id ?? null;

  const isUnfinished =
    operation !== null && !TERMINAL.includes(operation.status);

  const isPending = isUnfinished && stopped === null;
  const isAbandoned = isUnfinished && stopped === 'timeout';

  useEffect(() => {
    if (!isPending) return;

    // The watch has a deadline rather than running for as long as the tab is
    // open. It is measured from when this run started being followed, so a
    // reader who asks to keep waiting is given the whole of it again.
    const timer = setTimeout(() => setStopped('timeout'), pollTimeoutMs);

    return () => clearTimeout(timer);
  }, [isPending, watchedId, pollTimeoutMs]);

  const submit = useCallback(async () => {
    if (!isSubmittable(form)) return;

    setIsSubmitting(true);
    setFailure(null);
    setStopped(null);
    setAccepted(null);
    putOperationInRoute(null);

    const request = toRequest(form);

    try {
      const pending = await keyForSubmission(
        organizationId,
        request,
        () => crypto.randomUUID(),
        pendingKey.current,
      );

      pendingKey.current = pending;
      writePendingSubmission(organizationId, pending);

      const accepted = await requestContentIdeas(
        organizationId,
        request,
        pending.idempotencyKey,
      );

      pendingKey.current = null;
      clearPendingSubmission(organizationId);

      // The accepted run is put where a read of it would have landed, so the
      // screen shows it queued without asking for what it was just handed.
      queryClient.setQueryData(
        operationKeyFor(organizationId, accepted.id),
        accepted,
      );
      setAccepted({ organizationId, operationId: accepted.id });
      putOperationInRoute(accepted.id);
    } catch (thrown: unknown) {
      if (isDecided(thrown)) {
        pendingKey.current = null;
        clearPendingSubmission(organizationId);
      }

      const classified = classify(thrown);

      setFailure(classified);

      if (classified.kind === 'disabled') {
        void queryClient.invalidateQueries({
          queryKey: [...contentIdeasKey(organizationId), 'availability'],
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [organizationId, form, queryClient, putOperationInRoute]);

  const [promoting, setPromoting] = useState<number | null>(null);
  const [promoted, setPromoted] = useState<Record<number, string>>({});
  const [promoteFailed, setPromoteFailed] = useState<number | null>(null);
  const [promotedFor, setPromotedFor] = useState<string | null>(null);
  const [promoteFailure, setPromoteFailure] =
    useState<ContentIdeaFailure | null>(null);

  const promote = useCallback(
    async (index: number) => {
      if (runId === null) return;

      setPromoting(index);
      setPromoteFailed(null);
      setPromoteFailure(null);
      // Recorded up front, so a *failure* is attributed to this run too. Set
      // only on success, the outcome would be discarded by the scope check
      // below and nothing would render.
      setPromotedFor(runId);

      try {
        const project = await createContentProjectFromIdea(
          organizationId,
          { sourceRunId: runId, ideaIndex: index },
          `promote:${runId}:${index}`,
        );

        setPromoted((previous) => ({ ...previous, [index]: project.id }));
      } catch (thrown) {
        setPromoteFailed(index);
        setPromoteFailure(classify(thrown));
      } finally {
        setPromoting(null);
      }
    },
    [runId, organizationId],
  );

  const promotedNow =
    promotedFor !== null && promotedFor === runId ? promoted : {};
  const promoteFailedNow = promotedFor === runId ? promoteFailed : null;
  const promoteFailureNow = promotedFor === runId ? promoteFailure : null;

  const ideas = operation?.output?.ideas ?? [];
  const sources = operation?.output?.sources ?? [];
  const isBusy = isSubmitting || isPending;
  const isUnavailable = availability !== null && !availability.available;
  const canSubmit = canCreate && !isUnavailable;

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />

      {isUnavailable ? (
        <Card>
          <CardContent className="space-y-1 py-4 text-sm">
            <p>{t('unavailable.title')}</p>
            <p className="text-xs text-muted-foreground">
              {t(`unavailable.${availability.reason ?? 'agents_disabled'}`)}
            </p>
          </CardContent>
        </Card>
      ) : null}

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

      {canSubmit ? (
        <Card>
          <CardContent className="space-y-4 py-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="content-idea-topic">{t('form.topic')}</Label>
                <Input
                  id="content-idea-topic"
                  maxLength={LIMITS.topic}
                  value={form.topic}
                  disabled={isBusy}
                  onChange={(event) => field('topic', event.target.value)}
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="content-idea-goal">{t('form.goal')}</Label>
                <Input
                  id="content-idea-goal"
                  maxLength={LIMITS.goal}
                  value={form.goal}
                  disabled={isBusy}
                  onChange={(event) => field('goal', event.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="content-idea-language">
                  {t('form.language')}
                </Label>
                <select
                  id="content-idea-language"
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-2xs outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                  value={form.language}
                  disabled={isBusy}
                  onChange={(event) =>
                    field('language', event.target.value as ContentIdeaLanguage)
                  }
                >
                  {CONTENT_IDEA_LANGUAGES.map((language) => (
                    <option key={language} value={language}>
                      {t(`language.${language}`)}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  {t('form.languageHint')}
                </p>
              </div>

              <div className="space-y-1">
                <Label htmlFor="content-idea-audience">
                  {t('form.audience')}
                </Label>
                <Input
                  id="content-idea-audience"
                  maxLength={LIMITS.audience}
                  value={form.audience}
                  disabled={isBusy}
                  onChange={(event) => field('audience', event.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="content-idea-guidance">
                {t('form.guidance')}
              </Label>
              <Textarea
                id="content-idea-guidance"
                maxLength={LIMITS.guidance}
                value={form.guidance}
                disabled={isBusy}
                onChange={(event) => field('guidance', event.target.value)}
              />
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor="content-idea-count">{t('form.count')}</Label>
                <Input
                  id="content-idea-count"
                  type="number"
                  min={1}
                  max={LIMITS.numberOfIdeas}
                  className="w-24"
                  value={form.numberOfIdeas}
                  disabled={isBusy}
                  onChange={(event) =>
                    field('numberOfIdeas', Number(event.target.value))
                  }
                />
              </div>

              <Button
                size="sm"
                disabled={isBusy || !isSubmittable(form)}
                onClick={() => void submit()}
              >
                {isBusy ? (
                  <Loader2 aria-hidden className="size-4 animate-spin" />
                ) : (
                  <Lightbulb aria-hidden className="size-4" />
                )}
                {t('form.submit')}
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">{t('form.hint')}</p>
          </CardContent>
        </Card>
      ) : null}

      {operation !== null ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{t('result.heading')}</h2>
            <Badge variant="secondary">
              {t(`status.${isAbandoned ? 'ABANDONED' : operation.status}`)}
            </Badge>
            {isPending ? (
              <Loader2
                aria-label={t('result.working')}
                className="size-4 animate-spin"
              />
            ) : null}
          </div>

          {isAbandoned ? (
            <Card>
              <CardContent className="space-y-2 py-4 text-sm">
                <p>{t('result.abandoned')}</p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setStopped(null);
                    setFailure(null);
                    // A resumed watch reads at once rather than waiting out an
                    // interval first, so a run that finished while the screen
                    // had given up shows straight away — and so a deadline of
                    // nothing still buys one read.
                    void run.refetch();
                  }}
                >
                  <RefreshCw aria-hidden className="size-4" />
                  {t('result.resume')}
                </Button>
              </CardContent>
            </Card>
          ) : null}

          {operation.status === 'FAILED' ? (
            <Card>
              <CardContent className="py-4 text-sm text-destructive">
                {t('result.failed')}
              </CardContent>
            </Card>
          ) : null}

          {operation.status === 'SUCCEEDED' && ideas.length === 0 ? (
            <EmptyState
              icon={<Lightbulb aria-hidden className="size-5" />}
              title={t('result.empty')}
            />
          ) : null}

          {ideas.length > 0 ? (
            <div className="space-y-3">
              {ideas.map((idea, index) => (
                <Card key={`${index}-${idea.title}`}>
                  <CardContent className="space-y-2 py-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium">
                        <bdi>{idea.title}</bdi>
                      </p>
                      <Badge variant="outline">
                        {t(`format.${idea.suggestedFormat}`)}
                      </Badge>
                    </div>

                    <p className="text-sm font-medium">
                      <bdi>{idea.hook}</bdi>
                    </p>

                    <div className="space-y-1 text-sm text-muted-foreground">
                      <p>
                        <span className="font-medium">{t('result.angle')}</span>{' '}
                        <bdi>{idea.angle}</bdi>
                      </p>
                      <p>
                        <bdi>{idea.summary}</bdi>
                      </p>
                    </div>

                    {/*
                      The selection action.

                      Only the text the agent produced is ever sent: the request
                      carries this operation's id and this card's index, and the
                      server reads the idea back off the run.
                    */}
                    {canPromote ? (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        {promotedNow[index] === undefined ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={promoting !== null}
                            onClick={() => void promote(index)}
                          >
                            {promoting === index ? (
                              <Loader2
                                aria-hidden
                                className="size-4 animate-spin"
                              />
                            ) : (
                              <Check aria-hidden className="size-4" />
                            )}
                            {t('promote.action')}
                          </Button>
                        ) : (
                          <Link
                            className="text-sm underline-offset-4 hover:underline"
                            href={ORGANIZATION_DETAIL_ROUTES.contentProject(
                              organizationId,
                              promotedNow[index] ?? '',
                            )}
                          >
                            {t('promote.done')}
                          </Link>
                        )}

                        {promoteFailedNow === index ? (
                          <span className="text-sm text-destructive">
                            {t(`promote.${promoteMessage(promoteFailureNow)}`)}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              ))}

              {sources.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t('result.sources', { spaces: sources.join(', ') })}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t('result.ungrounded')}
                </p>
              )}
            </div>
          ) : null}
        </section>
      ) : (
        <EmptyState
          icon={<Lightbulb aria-hidden className="size-5" />}
          title={t('result.none')}
          description={canSubmit ? t('result.noneHint') : t('result.readOnly')}
        />
      )}
    </div>
  );
}
