import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light' | 'system';

const KEY = 'elvis.theme';
const listeners = new Set<() => void>();
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    if (t === 'dark' || t === 'light' || t === 'system') return t;
  } catch {
    /* storage unavailable */
  }
  return 'dark';
}

let current: Theme = getTheme();

export function applyTheme(theme: Theme = current): void {
  current = theme;
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

/** Tatsächlich angezeigtes Schema (bei „System“ nach Betriebssystem-Einstellung). */
export const effectiveTheme = (t: Theme = current): 'dark' | 'light' => (t === 'system' ? (systemDark() ? 'dark' : 'light') : t);

/** Zwischen Hell und Dunkel umschalten (aus „System“ heraus auf das Gegenteil des Angezeigten). */
export const toggleTheme = () => applyTheme(effectiveTheme() === 'dark' ? 'light' : 'dark');

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', l);
      return () => {
        listeners.delete(l);
        mq.removeEventListener('change', l);
      };
    },
    () => current,
  );
}
