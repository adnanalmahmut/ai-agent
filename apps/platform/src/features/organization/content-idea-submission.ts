import type { ContentIdeaRequest } from './organization-api';

/**
 * The identity of a submission that may or may not have been accepted.
 *
 * ## The problem this exists for
 *
 * Generation is billed and is not naturally idempotent. A request that fails in
 * transport — a 5xx, a gateway timeout, the tab reloading mid-flight — leaves
 * acceptance *unknown*: the backend commits the run and its outbox event in one
 * transaction, so a proxy giving up after that commit returns a failure for work
 * that was accepted and will be paid for.
 *
 * Keeping the idempotency key in a `useRef` survived a retry within one page
 * view and nothing else. A reload discarded it, so the obvious recovery — press
 * the button again — minted a fresh key and bought the same ideas twice. That
 * is the exact scenario a reader hits after a failure, which makes it the one
 * case worth surviving a reload.
 *
 * ## Why sessionStorage
 *
 * Per-tab and cleared when the tab closes, which matches the lifetime of a
 * submission somebody is waiting on. `localStorage` would outlive it and carry
 * a stale key into next week's unrelated request; a cookie would travel to the
 * server on every request for no reason. Neither is a better fit for a value
 * that means "this tab is mid-purchase".
 *
 * ## Why a digest rather than the request
 *
 * A key alone would be reused for a *different* question. The backend binds the
 * caller's key to a digest of the body, so reusing one with an edited topic is
 * already answered correctly — but it is answered by creating a second run,
 * which is the purchase this is trying to avoid making by accident. So the
 * record has to carry enough to tell "the same request, again" from "a new
 * request".
 *
 * Enough is a digest, not the request. This record was previously the request
 * itself, serialized: topic, goal, audience and guidance are operator-authored
 * business text — an unannounced campaign, a customer segment, a launch date —
 * and writing them to `sessionStorage` put them somewhere no part of the
 * feature needed them to be. `sessionStorage` is readable by every script that
 * runs on this origin and survives in a process the reader does not think of as
 * storing anything, and the only question ever asked of the value is "is this
 * the same request as before". Equality is all a digest has to preserve, so the
 * plaintext bought nothing and carried the whole payload.
 *
 * SHA-256 over a canonical rendering, so the comparison is exact and stable:
 * the same material request digests identically across a reload, and any
 * material edit digests differently. It is a *sameness* check between two of
 * this tab's own submissions, not a secret — a digest of a low-entropy request
 * is guessable by anyone who can guess the request, which is why the value is
 * still scoped per tab and cleared the moment acceptance stops being ambiguous.
 */

const KEY_PREFIX = 'content-idea:pending:';

export type PendingSubmission = {
  /** The `Idempotency-Key` the in-flight request was sent with. */
  idempotencyKey: string;
  /** SHA-256, hex, of the canonical rendering of what was asked for. */
  requestDigest: string;
};

/**
 * A stable string for a request, with keys in a fixed order.
 *
 * Sorted so a request assembled in a different field order is recognised as the
 * same one — matching what the backend does before it digests the body. Absent
 * and `undefined` fields are dropped rather than serialized as null, because
 * "no audience" and "audience omitted" are the same request and must not digest
 * differently.
 *
 * Not exported: it is the input to the digest and never a stored value, and
 * keeping it private is what stops a future caller from persisting it again.
 */
function canonicalize(request: ContentIdeaRequest): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(request)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

/**
 * The digest of a request: SHA-256 of its canonical rendering, as lowercase
 * hex.
 *
 * Async because `crypto.subtle` is, which is why `keyForSubmission` is too. The
 * caller already awaits — the submission is a network call — so the cost is a
 * microtask rather than anything a reader notices.
 */
export async function digestOf(request: ContentIdeaRequest): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(request));
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Every accessor is wrapped, and that is not defensive habit.
 *
 * `sessionStorage` throws rather than returning null in a browser configured to
 * block site data, and the getter itself throws in some embedded contexts. An
 * unhandled throw here would take down the screen for a convenience — so a
 * storage that refuses to answer degrades to the previous behavior: a key that
 * lives only as long as the page does.
 */
function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function readPendingSubmission(
  organizationId: string,
): PendingSubmission | null {
  const store = storage();

  if (store === null) return null;

  try {
    const raw = store.getItem(`${KEY_PREFIX}${organizationId}`);

    if (raw === null) return null;

    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== 'object' || parsed === null) return null;

    const { idempotencyKey, requestDigest } = parsed as Record<string, unknown>;

    /**
     * A record that is not this shape is discarded rather than repaired.
     *
     * That includes one written by an older build, which stored the request
     * itself under different field names. Failing the check mints a fresh key
     * for a submission this tab has no reliable record of, which is the safe
     * direction: the alternative is reusing a key against a request nobody can
     * confirm it was bound to.
     */
    if (typeof idempotencyKey !== 'string' || typeof requestDigest !== 'string') {
      return null;
    }

    return { idempotencyKey, requestDigest };
  } catch {
    return null;
  }
}

export function writePendingSubmission(
  organizationId: string,
  pending: PendingSubmission,
): void {
  const store = storage();

  if (store === null) return;

  try {
    /**
     * Written field by field rather than by serializing `pending` whole, so a
     * caller that hands this a wider object — a request bundled alongside the
     * key, which is exactly what this module used to store — cannot put it in
     * the browser by accident.
     */
    store.setItem(
      `${KEY_PREFIX}${organizationId}`,
      JSON.stringify({
        idempotencyKey: pending.idempotencyKey,
        requestDigest: pending.requestDigest,
      }),
    );
  } catch {
    // A full or blocked store is not a reason to fail the submission. The key
    // still lives in memory for this page view, which is what it did before.
  }
}

/**
 * Cleared only when the server has made acceptance unambiguous.
 *
 * A success means the run exists and its id is now in the URL; a refusal the
 * server *chose* means no run was created. Both end this submission. Anything
 * that leaves acceptance unknown must leave the record in place, because that
 * is the only case it exists for.
 */
export function clearPendingSubmission(organizationId: string): void {
  const store = storage();

  if (store === null) return;

  try {
    store.removeItem(`${KEY_PREFIX}${organizationId}`);
  } catch {
    // Nothing to do, and nothing worth failing a render over.
  }
}

/**
 * The key to send for this request: the pending one when it is the *same*
 * request, a new one otherwise.
 *
 * The digest comparison is what makes this safe to reuse at all. A key reused
 * for a different question would still be answered correctly — the backend
 * binds the key to a digest of the body — but it would be answered by creating
 * a second run, which is the purchase this exists to avoid making by accident.
 * So a materially different submission always gets a new key, and only a
 * genuine retry of the same one reuses.
 *
 * `inMemory` is the fallback for a browser that refuses `sessionStorage`
 * — checked second, because the stored record is the one that survived the
 * reload and is therefore the more authoritative of the two. It is a full
 * record rather than a bare key so it is subject to the same comparison; a
 * bare key would be reused for whatever was typed next.
 *
 * `mint` is a parameter rather than a call to `crypto.randomUUID` here so the
 * decision stays testable without a secure context.
 */
export async function keyForSubmission(
  organizationId: string,
  request: ContentIdeaRequest,
  mint: () => string,
  inMemory: PendingSubmission | null = null,
): Promise<PendingSubmission> {
  const requestDigest = await digestOf(request);

  for (const candidate of [readPendingSubmission(organizationId), inMemory]) {
    if (candidate !== null && candidate.requestDigest === requestDigest) {
      return { idempotencyKey: candidate.idempotencyKey, requestDigest };
    }
  }

  return { idempotencyKey: mint(), requestDigest };
}
