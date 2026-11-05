// Installed font families, read from the Windows font registry (machine and
// per-user installs). The list is cached; pass { refresh: true } after the user
// installs fonts.

import { execFile } from 'node:child_process';
import { join } from 'node:path';

const FONT_REGISTRY_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
  'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
];

/**
 * Registry value names carry the style for static fonts ("MesloLGM Nerd Font Bold Italic
 * (TrueType)"). Only the RIBBI suffixes are stripped: names such as "Segoe UI Semibold" or
 * "Arial Black" are real (GDI) family names that CSS accepts.
 */
const STYLE_SUFFIX = /\s+(?:Regular|Bold Italic|Bold Oblique|Bold|Italic|Oblique)$/i;

/** CSS generic families are always available. */
const GENERIC_FAMILIES = new Set(['monospace', 'sans-serif', 'serif', 'system-ui', 'ui-monospace', 'cursive', 'fantasy']);

export interface FontInventory {
  /** Family names, sorted, deduplicated. */
  families: string[];
  /** Raw registry names (without "(TrueType)"), for exact matches like "Cascadia Mono Regular". */
  rawNames: string[];
}

/** Parses one `reg query` output line into registry font names (collections yield several). */
export function parseFontRegistryLine(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.includes('REG_')) return [];
  const match = /^(.+?)\s+REG_\w+\s+/.exec(trimmed);
  if (!match?.[1]) return [];
  return match[1]
    .replace(/\s+\((?:TrueType|OpenType|All res)\)$/i, '')
    .split(/\s*&\s*/)
    .map((name) => name.trim())
    .filter(Boolean);
}

/** "MesloLGM Nerd Font Bold Italic" -> "MesloLGM Nerd Font". */
export function fontFamilyFromRegistryName(name: string): string {
  let family = name.trim();
  // At most two passes ("X Bold Italic" is one suffix; "X Regular Italic" two).
  for (let pass = 0; pass < 2 && STYLE_SUFFIX.test(family); pass += 1) family = family.replace(STYLE_SUFFIX, '');
  return family.trim() || name.trim();
}

function resolveRegExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  return join(systemRoot, 'System32', 'reg.exe');
}

function queryRegistry(key: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(resolveRegExecutable(), ['query', key], { windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10_000 }, (error, stdout) => {
      resolve(error ? [] : stdout.split(/\r?\n/).flatMap(parseFontRegistryLine));
    });
  });
}

export function buildFontInventory(rawNames: string[]): FontInventory {
  const families = new Map<string, string>();
  for (const name of rawNames) {
    const family = fontFamilyFromRegistryName(name);
    if (!families.has(family.toLowerCase())) families.set(family.toLowerCase(), family);
  }
  return {
    families: [...families.values()].sort((left, right) => left.localeCompare(right)),
    rawNames: [...new Set(rawNames)],
  };
}

let inventory: Promise<FontInventory> | null = null;

function loadInventory(refresh: boolean): Promise<FontInventory> {
  if (!inventory || refresh) {
    inventory = process.platform === 'win32'
      ? Promise.all(FONT_REGISTRY_KEYS.map(queryRegistry)).then((lists) => buildFontInventory(lists.flat()))
      : Promise.resolve({ families: [], rawNames: [] });
  }
  return inventory;
}

/** Installed font family names, sorted. */
export async function listLocalFonts(options: { refresh?: boolean } = {}): Promise<string[]> {
  return [...(await loadInventory(options.refresh ?? false)).families];
}

/** Pure check against an inventory (case-insensitive; accepts family or full registry names). */
export function inventoryHasFont(fonts: FontInventory, face: string): boolean {
  const key = face.trim().replace(/^["']|["']$/g, '').trim().toLowerCase();
  if (!key) return false;
  if (GENERIC_FAMILIES.has(key)) return true;
  return fonts.families.some((family) => family.toLowerCase() === key)
    || fonts.rawNames.some((name) => name.toLowerCase() === key);
}

/**
 * Whether `face` is installed. Returns true when the font list cannot be read (unknown
 * is not reported as missing).
 */
export async function isFontInstalled(face: string): Promise<boolean> {
  const fonts = await loadInventory(false);
  if (!fonts.families.length) return true;
  return inventoryHasFont(fonts, face);
}
