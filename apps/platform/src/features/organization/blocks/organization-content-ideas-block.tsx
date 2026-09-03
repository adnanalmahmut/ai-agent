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
import {
  Link,
  useAppNavigate,
  useAppSearchParams,
} from '@/i18n/navigation';
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
 * Giving up is no longer losing it. The operation id is in the URL, so the run
 * is recoverable by reloading, by returning to the link, or by pressing resume
 * — which is what the copy now says.
 */
const POLL_TIMEOUT_MS = 180_000;

/** The query parameter the operation is carried in. */
const OPERATION_PARAM = 'operation';

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
  /**
   * English by default, and *not* the reader's UI locale.
   *
   * The content language and the language somebody reads menus in are
   * different questions. Defaulting one from the other would make an
   * Arabic-reading marketer who plans English campaigns fight the form on every
   * request — and would make the default invisible, since the field would
   * appear to have been chosen when it had only been inherited.
   */
  language: 'en',
  audience: '',
  guidance: '',
  numberOfIdeas: 5,
};

/**
 * A form the request schema would accept, before the server is asked.
 *
 * `audience` is optional and bounded only when present, matching the contract:
 * an organization that has described its audience in its knowledge base should
 * not have to retype it, while a one-character answer is a slip rather than an
 * answer.
 */
/**
 * Which of the three promotion messages to show.
 *
 * The generic `error.*` strings belong to generation — `error.forbidden` says
 * "request content ideas" — so reusing them here would tell somebody the wrong
 * thing about the wrong action. Only the two distinctions worth making are
 * made: a permission they do not hold, which retrying cannot fix, and a server
 * they could not reach, which retrying might.
 */
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
  Number.isInteger(value) && value >= 1 && LIMITS.numberOfIdeas >= value;

/** The form as the request contract wants it: trimmed, with blanks omitted. */
const toRequest = (form: FormState): ContentIdeaRequest => ({
  topic: form.topic.trim(),
  goal: form.goal.trim(),
  language: form.language,
  ...(form.audience.trim() === '' ? {} : { audience: form.audience.trim() }),
  ...(form.guidance.trim() === '' ? {} : { guidance: form.guidance.trim() }),
  numberOfIdeas: form.numberOfIdeas,
});

/**
 * Asking the organization's agent for content ideas.
 *
 * The screen is a form, a status line, and a list. What it is really about is
 * the middle one: generation is asynchronous, so the honest thing to show is
 * an operation that is queued, then running, then either an answer or a
 * failure — never a spinner that implies the answer is one moment away when it
 * is a provider call that might not come back.
 *
 * ## The operation lives in the URL
 *
 * `?operation=<id>` rather than component state. A billed run whose id existed
 * only in a closure was lost by a reload, a navigation, or a crash — and the
 * only recovery a reader would think of is asking again, which buys the answer
 * twice. In the URL it survives all three, it can be sent to a colleague, and
 * the back button does what it looks like it does.
 *
 * ## Availability is advisory
 *
 * The screen asks whether generation is switched on so it can say so before
 * somebody fills a form in. Acceptance re-evaluates both flags regardless, and
 * a `FEATURE_DISABLED` answer refreshes this reading — the server decides, the
 * screen only avoids wasting the reader's time.
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
  const searchParams = useAppSearchParams();
  const navigate = useAppNavigate();

  const canCreate = useOrganizationRolePermission(viewer.member?.role, {
    contentIdea: ['create'],
  });

  /**
   * A separate gate, because it is a separate authority.
   *
   * Generating spends the platform's provider credential; promoting commits the
   * organization to a piece of work everybody will see. The two happen to be
   * held by the same roles today, so reusing `canCreate` would look right and
   * would quietly put an enabled button in front of the first role that holds
   * one without the other — which is precisely the role the split exists to
   * make possible.
   */
  const canPromote = useOrganizationRolePermission(viewer.member?.role, {
    contentProject: ['create'],
  });

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const field = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) =>
      setForm((previous) => ({ ...previous, [key]: value })),
    [],
  );

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
  const [availability, setAvailability] =
    useState<ContentIdeaAvailability | null>(null);

  /**
   * The key for the submission in flight, kept across a retry *and* a reload.
   *
   * The ref is the fast path within one page view; `content-idea-submission.ts`
   * is what makes it survive the tab being reloaded, which is the case that
   * matters — a request that failed in transport may or may not have been
   * accepted, and the reader's instinct after a failure is to reload and try
   * again.
   */
  const pendingKey = useRef<PendingSubmission | null>(null);

  const organizationId = organization.id;

  /** The operation this screen is about, named by the URL. */
  const routeOperationId = searchParams.get(OPERATION_PARAM);

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
        const current =
          previous !== null && previous.organizationId === organizationId
            ? previous.run
            : null;

        return {
          organizationId,
          run: typeof next === 'function' ? next(current) : next,
        };
      }),
    [organizationId],
  );

  /**
   * Puts the operation in the URL, replacing rather than pushing.
   *
   * Replace, because a generation is not a place somebody navigated to — a
   * push would make the back button step through every request they made in
   * this session before leaving the screen.
   */
  const putOperationInRoute = useCallback(
    (operationId: string | null) => {
      const next = new URLSearchParams(searchParams.toString());

      if (operationId === null) next.delete(OPERATION_PARAM);
      else next.set(OPERATION_PARAM, operationId);

      const query = next.toString();
      navigate(
        `${ORGANIZATION_ROUTES.contentIdeas(organizationId)}${query ? `?${query}` : ''}`,
        { replace: true },
      );
    },
    [navigate, organizationId, searchParams],
  );

  /**
   * Whether generation is switched on, read once per organization.
   *
   * Not gated on the reader's permission: a member who may not spend still
   * needs the screen to explain why nothing is being generated.
   */
  useEffect(() => {
    const controller = new AbortController();
    let current = true;

    getContentIdeaAvailability(organizationId, controller.signal)
      .then((next) => {
        if (current) setAvailability(next);
      })
      .catch(() => {
        /**
         * A readiness check that cannot be read is not a reason to block the
         * screen. The form stays available and the backend decides, which is
         * the same outcome as before this endpoint existed.
         */
        if (current) setAvailability(null);
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [organizationId]);

  /**
   * Recovers the operation named by the URL.
   *
   * This is what makes a reload return to the same run rather than to an empty
   * form. It reads once per id: the polling effect below takes over while the
   * run is unfinished, and re-reading here on every render would double the
   * request rate for no new information.
   *
   * A 404 — no such operation, or one belonging to another organization — is
   * both reported and *corrected*: the stale id is taken out of the URL, so a
   * reload does not reproduce the same failure forever.
   */
  useEffect(() => {
    if (routeOperationId === null) return;
    if (operation?.id === routeOperationId) return;

    const controller = new AbortController();
    let current = true;

    getContentIdeaOperation(organizationId, routeOperationId, controller.signal)
      .then((next) => {
        if (!current) return;

        setFailure(null);
        setStopped(null);
        setHeld({ organizationId, run: next });
      })
      .catch((thrown: unknown) => {
        if (!current || controller.signal.aborted) return;

        if (!isUnreadable(thrown)) return;

        setFailure(classify(thrown));
        putOperationInRoute(null);
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [organizationId, routeOperationId, operation?.id, putOperationInRoute]);

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
          setOperation((previous) =>
            previous !== null && TERMINAL.includes(previous.status)
              ? previous
              : next,
          );
        })
        .catch((thrown: unknown) => {
          if (!current || controller.signal.aborted) return;

          /**
           * A poll that fails is not the same event as a request that fails.
           * Only the server answering about this operation ends the watch;
           * anything transient — a 429 from this tab's own polling, a 5xx from
           * an instance being rolled — is ridden out, because the next tick
           * recovers and the give-up timeout is the backstop.
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
    if (!isSubmittable(form)) return;

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
    putOperationInRoute(null);

    const request = toRequest(form);

    try {
      /**
       * Inside the try, because `crypto.randomUUID` and `crypto.subtle` are
       * both absent outside a secure context. Thrown out here either would
       * escape the click handler before anything could be shown, leaving a
       * button that does nothing and says nothing.
       *
       * The stored key is reused only for the *same* request. A materially
       * different one — an edited topic, a different language — is a new
       * purchase and gets a new key, which is what somebody pressing the button
       * a second time on purpose expects.
       */
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
      setOperation(accepted);
      putOperationInRoute(accepted.id);
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
      if (isDecided(thrown)) {
        pendingKey.current = null;
        clearPendingSubmission(organizationId);
      }

      const classified = classify(thrown);

      setFailure(classified);

      /**
       * A refusal for a feature that is off is also news about availability.
       *
       * The reading this screen loaded may be minutes old, and an operator can
       * switch a flag between the two. Reconciling here is what stops the
       * screen from continuing to offer a button the server has just refused.
       */
      if (classified.kind === 'disabled') {
        getContentIdeaAvailability(organizationId)
          .then(setAvailability)
          .catch(() => undefined);
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [organizationId, form, setOperation, putOperationInRoute]);

  /**
   * Which idea is being promoted, and which ones already were.
   *
   * Keyed by index *and* discarded whenever the operation changes. An index
   * only means anything relative to the run that produced it, and this block
   * does not remount between generations — `setOperation` replaces the
   * operation in place — so state left behind would attach run A's project to
   * whatever idea happens to sit at the same position in run B, and hide run
   * B's own promote button behind a link to somebody else's project.
   *
   * It is intentionally not read back from the server. A project list filtered
   * by source run would answer "has this been promoted" authoritatively, but at
   * the cost of a second request on every result render to change a label —
   * and the button is idempotent, so the worst a stale "not yet" can cause is a
   * second click that returns the first project.
   */
  const [promoting, setPromoting] = useState<number | null>(null);
  const [promoted, setPromoted] = useState<Record<number, string>>({});
  const [promoteFailed, setPromoteFailed] = useState<number | null>(null);
  /** The operation `promoted` and `promoteFailed` were recorded against. */
  const [promotedFor, setPromotedFor] = useState<string | null>(null);
  const [promoteFailure, setPromoteFailure] = useState<ContentIdeaFailure | null>(
    null,
  );

  /**
   * The key is derived from the run and the index, not minted per click.
   *
   * That makes a double-click, a retried click after a dropped connection, and
   * a click after a reload all the same request — so an idea cannot become two
   * projects because somebody was impatient.
   */
  const promote = useCallback(
    async (index: number) => {
      if (operationId === null) return;

      setPromoting(index);
      setPromoteFailed(null);
      setPromoteFailure(null);
      // Recorded up front, so a *failure* is attributed to this run too. Set
      // only on success, the outcome would be discarded by the scope check
      // below and nothing would render.
      setPromotedFor(operationId);

      try {
        const project = await createContentProjectFromIdea(
          organizationId,
          { sourceRunId: operationId, ideaIndex: index },
          `promote:${operationId}:${index}`,
        );

        setPromoted((previous) => ({ ...previous, [index]: project.id }));
      } catch (thrown) {
        /**
         * Classified like every other failure in this block rather than
         * flattened to one sentence. A refusal the server decided — no
         * permission, a run that is not finished — is a different thing to tell
         * somebody than a browser that could not reach the API, and the second
         * is worth retrying while the first is not.
         */
        setPromoteFailed(index);
        setPromoteFailure(classify(thrown));
      } finally {
        setPromoting(null);
      }
    },
    [operationId, organizationId],
  );

  /**
   * Derived, not reset in an effect.
   *
   * `setState` from an effect body is refused by lint here, and a derived value
   * cannot be left behind by a dependency somebody forgot — the moment
   * `operationId` differs from the operation these were recorded against, they
   * are simply not this run's.
   */
  const promotedNow =
    promotedFor !== null && promotedFor === operationId ? promoted : {};
  const promoteFailedNow = promotedFor === operationId ? promoteFailed : null;
  const promoteFailureNow = promotedFor === operationId ? promoteFailure : null;

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
