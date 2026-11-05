// Keyboard settings model: one row per (command, args) variant, and pure edits of
// `settings.keybindings` (user overrides merged over DEFAULT_KEYBINDINGS).

import { COMMANDS, isCommandId, type CommandId } from '../../shared/commands';
import type { KeybindingEntry } from '../../shared/settings';
import { DEFAULT_KEYBINDINGS, normalizeChord, resolveKeymap } from '../../terminal/keymap';
import { matchesTerms } from './catalog';
import { chordParts } from './chords';

export type BindingArgs = Record<string, string | number | boolean>;

export interface CommandVariant {
  key: string;
  command: CommandId;
  args?: BindingArgs;
  title: string;
  category: string;
  /** Chords that currently run this variant. */
  chords: string[];
  /** Chords this variant has by default. */
  defaults: string[];
  modified: boolean;
}

export interface VariantContext {
  /** Visible profiles in order (Ctrl+Shift+1…9). */
  profiles: ReadonlyArray<{ id: string; name: string }>;
  snippets: ReadonlyArray<{ id: string; name: string }>;
  workspaces: ReadonlyArray<{ id: string; name: string }>;
}

/** Commands that do nothing useful without arguments; they only appear as variants. */
const REQUIRES_ARGS = new Set<CommandId>(['newTabProfileIndex', 'switchToTab', 'focusPane', 'resizePane', 'runSnippet', 'sendInput', 'openWorkspace']);

const COMMAND_ORDER = new Map((Object.keys(COMMANDS) as CommandId[]).map((id, index) => [id, index]));
const CATEGORY_ORDER = new Map<string, number>();
for (const id of Object.keys(COMMANDS) as CommandId[]) {
  const category = COMMANDS[id].category;
  if (!CATEGORY_ORDER.has(category)) CATEGORY_ORDER.set(category, CATEGORY_ORDER.size);
}

export function argsKey(args?: Record<string, unknown>): string {
  if (!args || !Object.keys(args).length) return '';
  return JSON.stringify(Object.keys(args).sort().map((key) => [key, args[key]]));
}

export function variantKey(command: string, args?: Record<string, unknown>): string {
  return `${command}|${argsKey(args)}`;
}

function variantTitle(command: CommandId, args: BindingArgs | undefined, context: VariantContext): string {
  const base: string = COMMANDS[command].title;
  if (!args || !Object.keys(args).length) return base;
  const nameOf = (list: ReadonlyArray<{ id: string; name: string }>, id: unknown) => list.find((entry) => entry.id === id)?.name ?? String(id);

  switch (command) {
    case 'switchToTab':
      return Number(args.index) === -1 ? 'Switch to last tab' : `Switch to tab ${Number(args.index) + 1}`;
    case 'newTabProfileIndex': {
      const index = Number(args.index);
      const profile = context.profiles[index];
      return `New tab with profile ${index + 1}${profile ? ` (${profile.name})` : ''}`;
    }
    case 'focusPane':
    case 'resizePane':
      return `${base} ${String(args.direction)}`;
    case 'runSnippet':
      return `Run snippet: ${nameOf(context.snippets, args.id)}`;
    case 'openWorkspace':
      return `Open workspace: ${nameOf(context.workspaces, args.id)}`;
    case 'sendInput':
      return `Send “${String(args.input)}”`;
    default:
      if (args.profile !== undefined && Object.keys(args).length === 1) return `${base} (${nameOf(context.profiles, args.profile)})`;
      return `${base} (${Object.entries(args).map(([key, value]) => `${key}: ${String(value)}`).join(', ')})`;
  }
}

export function buildVariants(userBindings: KeybindingEntry[], context: VariantContext): CommandVariant[] {
  const variants = new Map<string, CommandVariant>();
  const ensure = (command: CommandId, args?: BindingArgs): CommandVariant => {
    const cleanArgs = args && Object.keys(args).length ? args : undefined;
    const key = variantKey(command, cleanArgs);
    let variant = variants.get(key);
    if (!variant) {
      variant = {
        key,
        command,
        args: cleanArgs,
        title: variantTitle(command, cleanArgs, context),
        category: COMMANDS[command].category,
        chords: [],
        defaults: [],
        modified: false,
      };
      variants.set(key, variant);
    }
    return variant;
  };

  for (const id of Object.keys(COMMANDS) as CommandId[]) {
    if (!REQUIRES_ARGS.has(id)) ensure(id);
  }
  for (const entry of DEFAULT_KEYBINDINGS) {
    if (entry.command && isCommandId(entry.command)) {
      ensure(entry.command, entry.args).defaults.push(normalizeChord(entry.keys));
    }
  }
  for (const snippet of context.snippets) ensure('runSnippet', { id: snippet.id });
  for (const workspace of context.workspaces) ensure('openWorkspace', { id: workspace.id });
  for (const entry of userBindings) {
    if (entry.command && isCommandId(entry.command)) ensure(entry.command, entry.args);
  }
  for (const binding of resolveKeymap(userBindings, isCommandId).values()) {
    ensure(binding.command, binding.args).chords.push(binding.chord);
  }

  const list = [...variants.values()];
  for (const variant of list) {
    const current = new Set(variant.chords);
    variant.modified = current.size !== variant.defaults.length || variant.defaults.some((chord) => !current.has(chord));
  }

  const insertion = new Map(list.map((variant, index) => [variant.key, index]));
  return list.sort((a, b) =>
    (CATEGORY_ORDER.get(a.category) ?? 0) - (CATEGORY_ORDER.get(b.category) ?? 0)
    || (COMMAND_ORDER.get(a.command) ?? 0) - (COMMAND_ORDER.get(b.command) ?? 0)
    || (insertion.get(a.key) ?? 0) - (insertion.get(b.key) ?? 0));
}

export function variantMatches(variant: CommandVariant, query: string): boolean {
  const chords = variant.chords.flatMap((chord) => [chord, chordParts(chord).join('+')]);
  return matchesTerms([variant.title, variant.category, variant.command, ...chords].join(' '), query);
}

function defaultFor(chord: string): KeybindingEntry | undefined {
  return DEFAULT_KEYBINDINGS.find((entry) => normalizeChord(entry.keys) === chord);
}

/** Binds `chord` to the variant, replacing whatever the chord did before. */
export function addChord(user: KeybindingEntry[], chord: string, command: CommandId, args?: BindingArgs): KeybindingEntry[] {
  const normalized = normalizeChord(chord);
  const next = user.filter((entry) => normalizeChord(entry.keys) !== normalized);
  const fallback = defaultFor(normalized);
  const isDefault = fallback?.command === command && argsKey(fallback.args) === argsKey(args);
  if (!isDefault) {
    next.push(args && Object.keys(args).length ? { keys: normalized, command, args } : { keys: normalized, command });
  }
  return next;
}

/** Unbinds `chord` entirely (a default chord gets a `command: null` override). */
export function removeChord(user: KeybindingEntry[], chord: string): KeybindingEntry[] {
  const normalized = normalizeChord(chord);
  const next = user.filter((entry) => normalizeChord(entry.keys) !== normalized);
  if (defaultFor(normalized)) {
    next.push({ keys: normalized, command: null });
  }
  return next;
}

/** Restores the variant's default chords and drops its user-added ones. */
export function resetVariant(user: KeybindingEntry[], command: CommandId, args?: BindingArgs): KeybindingEntry[] {
  const key = variantKey(command, args);
  const defaults = new Set(
    DEFAULT_KEYBINDINGS.filter((entry) => entry.command && variantKey(entry.command, entry.args) === key).map((entry) => normalizeChord(entry.keys)),
  );
  return user.filter((entry) => {
    if (entry.command !== null && variantKey(entry.command, entry.args) === key) return false;
    return !defaults.has(normalizeChord(entry.keys));
  });
}

export interface ChordConflict {
  chord: string;
  /** Variant that has the chord. */
  variantKey: string;
  message: string;
}

/**
 * Chords that do not do what the user may expect: a user binding that took over a
 * default chord of another command, or a chord also registered as a global hotkey
 * (Windows delivers those to the hotkey, never to the terminal).
 */
export function findConflicts(
  user: KeybindingEntry[],
  variants: CommandVariant[],
  globalHotkeys: ReadonlyArray<{ chord: string; label: string }>,
): ChordConflict[] {
  const byKey = new Map(variants.map((variant) => [variant.key, variant]));
  const result: ChordConflict[] = [];

  for (const entry of user) {
    if (!entry.command || !isCommandId(entry.command)) continue;
    const chord = normalizeChord(entry.keys);
    const fallback = defaultFor(chord);
    if (!fallback?.command) continue;
    const winner = variantKey(entry.command, entry.args);
    const loser = variantKey(fallback.command, fallback.args);
    if (winner === loser) continue;
    const loserTitle = byKey.get(loser)?.title ?? fallback.command;
    const winnerTitle = byKey.get(winner)?.title ?? entry.command;
    const label = chordParts(chord).join('+');
    result.push({ chord, variantKey: winner, message: `${label} replaces its default, ${loserTitle}.` });
    result.push({ chord, variantKey: loser, message: `${label} now runs ${winnerTitle}.` });
  }

  for (const hotkey of globalHotkeys) {
    if (!hotkey.chord) continue;
    for (const variant of variants) {
      if (variant.chords.includes(hotkey.chord)) {
        result.push({ chord: hotkey.chord, variantKey: variant.key, message: `${chordParts(hotkey.chord).join('+')} is also the ${hotkey.label}, which takes precedence.` });
      }
    }
  }
  return result;
}
