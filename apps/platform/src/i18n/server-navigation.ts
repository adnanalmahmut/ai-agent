import { createNavigation } from 'next-intl/navigation';

import { routing } from './routing';

export const { redirect } = createNavigation(routing);
