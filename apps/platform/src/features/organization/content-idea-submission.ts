import type { ContentIdeaRequest } from './organization-api';

const KEY_PREFIX = 'content-idea:pending:';

export type PendingSubmission = {
  idempotencyKey: string;
  requestDigest: string;
};

function canonicalize(request: ContentIdeaRequest): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(request)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

export async function digestOf(request: ContentIdeaRequest): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(request));
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

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

    if (
      typeof idempotencyKey !== 'string' ||
      typeof requestDigest !== 'string'
    ) {
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

export function clearPendingSubmission(organizationId: string): void {
  const store = storage();

  if (store === null) return;

  try {
    store.removeItem(`${KEY_PREFIX}${organizationId}`);
  } catch {
    // Nothing to do, and nothing worth failing a render over.
  }
}

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
