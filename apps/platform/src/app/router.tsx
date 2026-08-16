import { createBrowserRouter } from 'react-router';

import { PLATFORM_BASE_PATH } from '@/config/paths';

import { createRoutes } from './routes';

/**
 * The data router.
 *
 * Created once, at module scope, outside the React tree — a data router holds
 * navigation state and re-creating it on a render would reset it.
 *
 * `basename` is what lets every path in the tree be written without
 * `/platform`: React Router strips it from incoming URLs and re-applies it to
 * everything it emits. It has to match Vite's `base`, which is why both read
 * the same constant.
 */
export const router = createBrowserRouter(createRoutes(), {
  basename: PLATFORM_BASE_PATH,
});
