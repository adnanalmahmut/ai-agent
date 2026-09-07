import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { ThemeProvider, useTheme } from './theme-provider';

function ThemeControls() {
  const { setTheme } = useTheme();

  return (
    <>
      <button type="button" onClick={() => setTheme('dark')}>dark</button>
      <button type="button" onClick={() => setTheme('light')}>light</button>
    </>
  );
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    document.documentElement.style.colorScheme = '';
  });

  it('applies the stored theme when it mounts', () => {
    localStorage.setItem('theme', 'dark');

    render(
      <ThemeProvider>
        <ThemeControls />
      </ThemeProvider>,
    );

    expect(document.documentElement).toHaveClass('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('updates the document and persists an explicit choice', () => {
    render(
      <ThemeProvider>
        <ThemeControls />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'dark' }));
    expect(document.documentElement).toHaveClass('dark');
    expect(localStorage.getItem('theme')).toBe('dark');

    fireEvent.click(screen.getByRole('button', { name: 'light' }));
    expect(document.documentElement).not.toHaveClass('dark');
    expect(localStorage.getItem('theme')).toBe('light');
  });
});
