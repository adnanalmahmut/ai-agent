'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'theme';
const SYSTEM_THEME = '(prefers-color-scheme: dark)';

const ThemeContext = createContext<{
  setTheme: (theme: Theme) => void;
} | null>(null);

function isTheme(value: string | null): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system';
}

function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isTheme(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(theme: Theme) {
  const isDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia(SYSTEM_THEME).matches);

  document.documentElement.classList.toggle('dark', isDark);
  document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'system';
    return storedTheme();
  });

  const setTheme = useCallback((nextTheme: Theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, nextTheme);
    } catch {
      // Theme switching still works when storage is unavailable.
    }
    setThemeState(nextTheme);
  }, []);

  useEffect(() => {
    const media = window.matchMedia(SYSTEM_THEME);
    const synchronize = () => applyTheme(theme);

    synchronize();
    if (theme === 'system') media.addEventListener('change', synchronize);

    return () => media.removeEventListener('change', synchronize);
  }, [theme]);

  const value = useMemo(() => ({ setTheme }), [setTheme]);

  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme() {
  const context = useContext(ThemeContext);

  if (!context) throw new Error('useTheme must be used inside ThemeProvider');

  return context;
}
