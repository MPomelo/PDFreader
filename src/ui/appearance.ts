export type ColorScheme = 'light' | 'dark';
export type ThemeMode = 'system' | ColorScheme;

export const ACCENTS = {
  blue: '蓝色', teal: '青绿', violet: '紫色', rose: '玫红', amber: '琥珀',
} as const;
export type Accent = keyof typeof ACCENTS;
export const DEFAULT_ACCENT: Accent = 'blue';

export function isAccent(value: unknown): value is Accent {
  return typeof value === 'string' && Object.hasOwn(ACCENTS, value);
}
