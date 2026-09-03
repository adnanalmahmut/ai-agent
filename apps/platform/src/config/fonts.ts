import localFont from 'next/font/local';

export const thmanyahSans = localFont({
  src: [
    { path: '../../../../packages/ui/src/fonts/thmanyahsans-Light.woff2', weight: '300' },
    { path: '../../../../packages/ui/src/fonts/thmanyahsans-Regular.woff2', weight: '400' },
    { path: '../../../../packages/ui/src/fonts/thmanyahsans-Medium.woff2', weight: '500' },
    { path: '../../../../packages/ui/src/fonts/thmanyahsans-Bold.woff2', weight: '700' },
    { path: '../../../../packages/ui/src/fonts/thmanyahsans-Black.woff2', weight: '900' },
  ],
  variable: '--font-sans',
  display: 'swap',
});

export const thmanyahSerifDisplay = localFont({
  src: [
    { path: '../../../../packages/ui/src/fonts/thmanyahserifdisplay-Light.woff2', weight: '300' },
    { path: '../../../../packages/ui/src/fonts/thmanyahserifdisplay-Regular.woff2', weight: '400' },
    { path: '../../../../packages/ui/src/fonts/thmanyahserifdisplay-Medium.woff2', weight: '500' },
    { path: '../../../../packages/ui/src/fonts/thmanyahserifdisplay-Bold.woff2', weight: '700' },
    { path: '../../../../packages/ui/src/fonts/thmanyahserifdisplay-Black.woff2', weight: '900' },
  ],
  variable: '--font-serif',
  display: 'swap',
});
