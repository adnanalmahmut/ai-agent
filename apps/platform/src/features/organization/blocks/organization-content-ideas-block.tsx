import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Label,
  Textarea,
} from '@repo/ui';
import { Lightbulb, Loader2, RefreshCw } from 'lucide-react';
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
  getContentIdeaOperation,
  requestContentIdeas,
  type ContentIdeaOperation,
} from '../organization-api';
import { useOrganizationContext } from '../organization-context';

/**
 * How often the operation is re-read while it is still running.
 *
 * A generation takes seconds, so a slower interval would leave a finished
 * answer sitting unread and a faster one would spend requests to learn nothing
 * — and every poll is a rate-limited call against the same route budget as the
 * request itself.
 */
const POLL_INTERVAL_MS = 2_000;

/**
 * When to stop polling and say so.
 *
 * A run that has not finished in three minutes is not going to finish while
 * this screen watches: the backend gives it a wall-clock budget well under
 * that, and retries are BullMQ's business rather than something a browser tab
 * should be waiting through.
 *
 * Giving up is not cancelling — the run continues and is paid for — but it is
 * not recoverable either. The operation id lives only in this component's
 * state: there is no URL parameter, nothing stored, and no list endpoint to
 * find it again from. Leaving the screen loses it, which is what the copy now
 * says.
 */
const POLL_TIMEOUT_MS = 180_000;

/**
 * Why polling stopped, when it stopped early.
 *
 * A single boolean conflated two different situations that want different
 * screens. Waiting too long leaves a run that is still going and worth
 * resuming; a refusal means the server will not answer about this operation
 * again, and offering to keep waiting for it would be a button that cannot
 * work.
 */
type Stopped = 'timeout' | 'refused';

const TERMINAL: ReadonlyArray<ContentIdeaOperation['status']> = [
  'SUCCEEDED',
  'FAILED',
];

/**
 * The schema's own bounds, restated where the form can enforce them.
 *
 * Duplication with `contentIdeaInput`, and deliberately so: a 400 from this
 * endpoint is a dead end for the operator. The global validation pipe answers
 * with a field-error array, which this application's error reader does not
 * accept — it takes a list of sentences or one sentence — so the screen can
 * only say "that request could not be accepted" without naming the field or
 * the limit. Keeping the request inside the bounds is what makes that
 * unreachable, rather than teaching the shared client a third details shape
 * for a case a form should not produce.
 */
const LIMITS = { topic: 200, audience: 200, guidance: 1_000, count: 10 };

/**
 * A form the request schema would accept, before the server is asked.
 *
 * `count` is checked too: the number input's `min` and `max` bound the
 * stepper's arrows and nothing else, so a typed `0` or an emptied field would
 * otherwise be submitted and come back a 400 the operator has to read.
 */
const isSubmittable = (input: {
  topic: string;
  audience: string;
  guidance: string;
  count: number;
}) =>
  within(input.topic, 3, LIMITS.topic) &&
  within(input.audience, 3, LIMITS.audience) &&
  within(input.guidance, 0, LIMITS.guidance) &&
  isCount(input.count);

/**
 * Both bounds are written with `>=` rather than one of each.
 *
 * The repository's architecture test finds untranslated copy by looking for
 * text between `>` and `<`, and an arrow function whose body reaches a `<=`
 * before the next brace is exactly that shape — the same false positive the
 * knowledge block documents. Flipping the comparison says the same thing and
 * leaves the check able to catch what it is for.
 */
const within = (value: string, least: number, most: number) => {
  const length = value.trim().length;

  return length >= least && most >= length;
};

const isCount = (value: number) =>
  Number.isInteger(value) && value >= 1 && LIMITS.count >= value;

/**
 * Asking the organization's agent for content ideas.
 *
 * The screen is a form, a status line, and a list. What it is really about is
 * the middle one: generation is asynchronous, so the honest thing to show is
 * an operation that is queued, then running, then either an answer or a
 * failure — never a spinner that implies the answer is one moment away when it
 * is a provider call that might not come back.
 *
 * Every control is gated on the reader's membership **in this organization**,
 * and none of those gates is a boundary: the backend re-derives the same
 * decision from the database. Hiding the form only avoids showing someone a
 * door that opens onto a 403.
 */
export function OrganizationContentIdeasBlock({
  /**
   * The polling cadence, defaulted to the product value.
   *
   * A parameter rather than a constant read from module scope because the
   * behavior worth testing is the sequence — queued, running, answered, or
   * abandoned — and pinning that against a two-second clock means a suite that
   * spends half a minute waiting. Fake timers are not an option here:
   * `userEvent` awaits a real delay that a faked clock never reaches, so every
   * interaction in the test would hang. Nothing in the application passes this.
   */
  pollIntervalMs = POLL_INTERVAL_MS,
  /**
   * How long to keep polling before reporting the run as still running.
   *
   * A parameter for the same reason the interval is: the give-up screen is
   * real behavior, and a default of three minutes is not something a test can
   * wait for. Nothing in the application passes either.
   */
  pollTimeoutMs = POLL_TIMEOUT_MS,
}: { pollIntervalMs?: number; pollTimeoutMs?: number } = {}) {
  const t = useTranslations('ContentIdeas');
  const { organization, viewer } = useOrganizationContext();

  const canCreate = useOrganizationRolePermission(viewer.member?.role, {
    contentIdea: ['create'],
  });

  const [topic, setTopic] = useState('');
  const [audience, setAudience] = useState('');
  const [guidance, setGuidance] = useState('');
  const [count, setCount] = useState(5);

  /**
   * Tagged with the organization it belongs to, rather than a bare operation.
   *
   * An operation id is organization-scoped: reading one under a different
   * organization is a 404, and rendering one under a different organization's
   * heading is a lie. Carrying the organization makes that state
   * unrepresentable instead of something an effect has to clean up after the
   * fact — the route already keys this block on the organization so it
   * remounts, and this is what holds when some future caller forgets to.
   */
  const [held, setHeld] = useState<{
    organizationId: string;
    run: ContentIdeaOperation;
  } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [failure, setFailure] = useState<ContentIdeaFailure | null>(null);
  const [stopped, setStopped] = useState<Stopped | null>(null);

  /**
   * The key for the submission in flight, kept across a retry.
   *
   * Generation is billed and is not naturally idempotent. A request that fails
   * in transport may or may not have been accepted, so retrying it with a new
   * key would buy a second answer to the same question; retrying with the same
   * key gets whichever run the server already has. It is cleared once the
   * server has *decided* — a success or a refusal both mean this submission is
   * over — so the next ask is a new purchase rather than a duplicate of the
   * last one.
   */
  const pendingKey = useRef<string | null>(null);

  const organizationId = organization.id;

  /** Only ever this organization's. */
  const operation =
    held !== null && held.organizationId === organizationId ? held.run : null;

  const setOperation = useCallback(
    (
      next:
        | ContentIdeaOperation
        | ((held: ContentIdeaOperation | null) => ContentIdeaOperation),
    ) =>
      setHeld((previous) => {
        const held =
          previous !== null && previous.organizationId === organizationId
            ? previous.run
            : null;

        return {
          organizationId,
          run: typeof next === 'function' ? next(held) : next,
        };
      }),
    [organizationId],
  );

  const operationId = operation?.id ?? null;

  /** The run's own state, before this screen's decision to stop watching. */
  const isUnfinished =
    operation !== null && !TERMINAL.includes(operation.status);

  const isPending = isUnfinished && stopped === null;
  const isAbandoned = isUnfinished && stopped === 'timeout';

  useEffect(() => {
    if (operationId === null || !isPending) return;

    const controller = new AbortController();
    let current = true;
    const startedAt = Date.now();

    const read = () => {
      if (Date.now() - startedAt > pollTimeoutMs) {
        if (current) setStopped('timeout');

        return;
      }

      getContentIdeaOperation(organizationId, operationId, controller.signal)
        .then((next) => {
          if (!current) return;

          /**
           * Never backwards. Two reads can be in flight when a response
           * outruns the interval, and a slow `QUEUED` landing after a fast
           * `SUCCEEDED` would put the run back to pending — restarting the
           * effect, and with it the clock the give-up timeout is measured from.
           *
           * Belt and braces, and knowingly so: `current` is already false by
           * the time a stale read lands in every sequence a test can produce,
           * because storing a terminal status tears this effect down. The
           * window this closes is the one between that store and React running
           * the cleanup, which no test can open deterministically. Removing it
           * costs a flicker and a reset deadline rather than a wrong answer.
           */
          setOperation((held) =>
            held !== null && TERMINAL.includes(held.status) ? held : next,
          );
        })
        .catch((thrown: unknown) => {
          if (!current || controller.signal.aborted) return;

          /**
           * A poll that fails is not the same event as a request that fails.
           * Only the server answering about this operation ends the watch;
           * anything transient is ridden out, because the next tick recovers
           * and the give-up timeout is the backstop.
           */
          if (!isUnreadable(thrown)) return;

          setFailure(classify(thrown));
          setStopped('refused');
        });
    };

    /**
     * Read once before waiting. Acceptance answers `QUEUED` by construction,
     * and by the time that response has been rendered the run may already be
     * running or finished — so the first interval would otherwise be spent
     * showing a status that is already stale.
     */
    read();

    const timer = setInterval(read, pollIntervalMs);

    return () => {
      current = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [
    organizationId,
    operationId,
    isPending,
    pollIntervalMs,
    pollTimeoutMs,
    setOperation,
  ]);

  const submit = useCallback(async () => {
    if (!isSubmittable({ topic, audience, guidance, count })) return;

    setIsSubmitting(true);
    setFailure(null);
    setStopped(null);
    /**
     * The previous operation is superseded the moment a new one is asked for.
     *
     * Not only tidiness. Clearing `stopped` above restarts the poll, and while
     * this request is in flight the only operation it could poll is the old
     * one — whose read may fail again and set `stopped` back, so the run this
     * call is about would be stored already-stopped and never watched. It
     * would still be billed, and its ideas would never be shown.
     */
    setHeld(null);

    try {
      /**
       * Inside the try, because `crypto.randomUUID` is absent outside a secure
       * context. Thrown out here it would escape the click handler before
       * anything could be shown, leaving a button that does nothing and says
       * nothing.
       */
      pendingKey.current ??= crypto.randomUUID();

      const accepted = await requestContentIdeas(
        organizationId,
        {
          topic: topic.trim(),
          audience: audience.trim(),
          ...(guidance.trim() === '' ? {} : { guidance: guidance.trim() }),
          count,
        },
        pendingKey.current,
      );

      pendingKey.current = null;
      setOperation(accepted);
    } catch (thrown: unknown) {
      /**
       * The key survives everything that leaves acceptance unknown.
       *
       * A refusal the server *chose* — a validation error, a disabled feature,
       * a permission — means no run was created and the next attempt is a new
       * request. A 5xx or a gateway timeout means no such thing: acceptance
       * commits the run and its outbox event in one transaction, so a proxy
       * timing out or an instance being rolled after that commit returns a
       * failure for work that was accepted and will be billed. Minting a fresh
       * key there buys the same ideas twice; keeping it is safe either way,
       * because the durable key finds the run if there is one and creates it
       * once if there is not.
       */
      if (isDecided(thrown)) pendingKey.current = null;

      setFailure(classify(thrown));
    } finally {
      setIsSubmitting(false);
    }
  }, [organizationId, topic, audience, guidance, count, setOperation]);

  const ideas = operation?.output?.ideas ?? [];
  const sources = operation?.output?.sources ?? [];
  const isBusy = isSubmitting || isPending;

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

      {canCreate ? (
        <Card>
          <CardContent className="space-y-4 py-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="content-idea-topic">{t('form.topic')}</Label>
                <Input
                  id="content-idea-topic"
                  maxLength={LIMITS.topic}
                  value={topic}
                  disabled={isBusy}
                  onChange={(event) => setTopic(event.target.value)}
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="content-idea-audience">
                  {t('form.audience')}
                </Label>
                <Input
                  id="content-idea-audience"
                  maxLength={LIMITS.audience}
                  value={audience}
                  disabled={isBusy}
                  onChange={(event) => setAudience(event.target.value)}
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
                value={guidance}
                disabled={isBusy}
                onChange={(event) => setGuidance(event.target.value)}
              />
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor="content-idea-count">{t('form.count')}</Label>
                <Input
                  id="content-idea-count"
                  type="number"
                  min={1}
                  max={LIMITS.count}
                  className="w-24"
                  value={count}
                  disabled={isBusy}
                  onChange={(event) => setCount(Number(event.target.value))}
                />
              </div>

              <Button
                size="sm"
                disabled={
                  isBusy || !isSubmittable({ topic, audience, guidance, count })
                }
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
                        <bdi>{idea.format}</bdi>
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      <bdi>{idea.angle}</bdi>
                    </p>
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
          description={canCreate ? t('result.noneHint') : t('result.readOnly')}
        />
      )}
    </div>
  );
}
