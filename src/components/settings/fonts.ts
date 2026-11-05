import { useEffect, useState } from 'react';

import { bridge } from './bridge';
import { isPropoFont, monoAlternative } from './helpers';

let cache: Promise<string[]> | null = null;

function loadFonts(): Promise<string[]> {
  cache ??= bridge()
    .listFonts()
    .then((list) => [...new Set(list.filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })))
    .catch(() => {
      cache = null;
      return [];
    });
  return cache;
}

/** Installed font families (null while loading). Cached for the session. */
export function useInstalledFonts(): string[] | null {
  const [fonts, setFonts] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    void loadFonts().then((list) => {
      if (live) setFonts(list);
    });
    return () => {
      live = false;
    };
  }, []);
  return fonts;
}

export interface FontAdvice {
  tone: 'warn' | 'info';
  message: string;
  /** A face to offer instead. */
  suggestion?: string;
}

export function fontAdvice(face: string, installed: readonly string[] | null): FontAdvice | null {
  const trimmed = face.trim();
  if (!trimmed) return null;
  if (isPropoFont(trimmed)) {
    const suggestion = installed ? monoAlternative(trimmed, installed) : null;
    return {
      tone: 'warn',
      message: '“Propo” variants are proportional, so columns won’t line up. Use the “Nerd Font Mono” or plain “Nerd Font” variant.',
      suggestion: suggestion ?? undefined,
    };
  }
  if (installed && installed.length && !installed.some((name) => name.toLowerCase() === trimmed.toLowerCase())) {
    return { tone: 'warn', message: `“${trimmed}” isn’t installed; Cascadia Mono is used instead.` };
  }
  return null;
}
