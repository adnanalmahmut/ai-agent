import {
  ApiError,
  type ApiErrorDetails,
  ApiUnavailableError,
} from '@/lib/application-api';

/**
 * How the control-plane screens describe a failed request to an operator. The
 * classification is deliberately separate from whatever fetches the data: it
 * is the same sentence whether the request was owned by the custom resource
 * hook or by a TanStack query, and it holds no state of its own.
 */
export const CONTROL_PLANE_ERROR_KINDS = [
  'unavailable',
  'unauthenticated',
  'forbidden',
  'invalid',
  'failed',
] as const;

export type ControlPlaneErrorKind = (typeof CONTROL_PLANE_ERROR_KINDS)[number];

export function classifyControlPlaneError(
  thrown: unknown,
): ControlPlaneErrorKind {
  if (thrown instanceof ApiUnavailableError) return 'unavailable';

  if (thrown instanceof ApiError) {
    if (thrown.status === 401) return 'unauthenticated';
    if (thrown.status === 403) return 'forbidden';
    if (thrown.status === 400 || thrown.status === 422) return 'invalid';
  }

  return 'failed';
}

export function controlPlaneErrorDetails(thrown: unknown): ApiErrorDetails {
  return thrown instanceof ApiError ? thrown.details : {};
}
