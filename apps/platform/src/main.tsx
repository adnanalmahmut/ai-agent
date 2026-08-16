import '@repo/ui/globals.css';
import './styles/fonts.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';

import { Providers } from './app/providers';
import { router } from './app/router';

const container = document.getElementById('root');

// A missing mount point is a broken build, not a runtime condition to handle.
// Failing here names the cause; `createRoot(null!)` would fail later and
// somewhere less useful.
if (!container) {
  throw new Error('Missing #root element in index.html');
}

createRoot(container).render(
  <StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
);
