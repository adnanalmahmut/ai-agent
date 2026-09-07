import { ForbiddenNotice } from '@/features/auth/access-notice';

/**
 * The refusal as an address of its own, so it can be linked to and read
 * directly. The protected layout renders the same notice in place rather
 * than redirecting here, which is what keeps a refused request from emitting
 * protected markup first.
 */
export default ForbiddenNotice;
