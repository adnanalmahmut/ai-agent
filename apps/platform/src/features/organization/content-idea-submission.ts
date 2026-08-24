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
 * ## Why the fingerprint
 *
 * A key alone would be reused for a *different* question. The backend binds the
 * caller's key to a digest of the body, so reusing one with an edited topic is
 * already answered correctly — but it is answered by creating a second run,
 * which is the purchase this is trying to avoid making by accident. Storing
 * what was asked lets the client tell "the same request, again" from "a new
 * request", and only the first reuses the key.
 */

const KEY_PREFIX = 'content-idea:pending:';

export type PendingSubmission = {
  /** The `Idempotency-Key` the in-flight request was sent with. */
  key: string;
  /** A stable rendering of what was asked for. */
  fingerprint: string;
};

/**
 * A stable string for a request, with keys in a fixed order.
 *
 * Sorted so a request assembled in a different field order is recognised as the
 * same one — matching what the backend does before it digests the body. Not
 * hashed: this never leaves the browser, so a digest would only make it harder
 * to debug.
 */
export function fingerprintOf(request: ContentIdeaRequest): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(request)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
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

    const { key, fingerprint } = parsed as Record<string, unknown>;

    if (typeof key !== 'string' || typeof fingerprint !== 'string') return null;

    return { key, fingerprint };
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
    store.setItem(`${KEY_PREFIX}${organizationId}`, JSON.stringify(pending));
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
 * The fingerprint comparison is what makes this safe to reuse at all. A key
 * reused for a different question would still be answered correctly — the
 * backend binds the key to a digest of the body — but it would be answered by
 * creating a second run, which is the purchase this exists to avoid making by
 * accident. So a materially different submission always gets a new key, and
 * only a genuine retry of the same one reuses.
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
export function keyForSubmission(
  organizationId: string,
  request: ContentIdeaRequest,
  mint: () => string,
  inMemory: PendingSubmission | null = null,
): PendingSubmission {
  const fingerprint = fingerprintOf(request);

  for (const candidate of [readPendingSubmission(organizationId), inMemory]) {
    if (candidate !== null && candidate.fingerprint === fingerprint) {
      return { key: candidate.key, fingerprint };
    }
  }

  return { key: mint(), fingerprint };
}
