import { create } from 'zustand';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'dt-theme-mode';
const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

function readStoredMode(): ThemeMode {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
}

function resolveTheme(mode: ThemeMode, systemDark = window.matchMedia(SYSTEM_DARK_QUERY).matches): ResolvedTheme {
  return mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
}

type ThemeState = {
  mode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  syncSystemTheme: (systemDark: boolean) => void;
};

const initialMode = readStoredMode();

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: initialMode,
  resolvedTheme: resolveTheme(initialMode),
  setMode: (mode) => {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
    set({ mode, resolvedTheme: resolveTheme(mode) });
  },
  syncSystemTheme: (systemDark) => {
    if (get().mode === 'system') {
      set({ resolvedTheme: resolveTheme('system', systemDark) });
    }
  },
}));

export function subscribeToSystemTheme() {
  const media = window.matchMedia(SYSTEM_DARK_QUERY);
  const handleChange = (event: MediaQueryListEvent) => {
    useThemeStore.getState().syncSystemTheme(event.matches);
  };
  useThemeStore.getState().syncSystemTheme(media.matches);
  media.addEventListener('change', handleChange);
  return () => media.removeEventListener('change', handleChange);
}
