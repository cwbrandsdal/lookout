import { createContext, useContext } from 'react';

import { ROW_IDS, rowMeta, type RowId, type SectionId } from './catalog';

export interface SettingsFilter {
  query: string;
  /** Matching rows while searching; null shows everything. */
  matches: ReadonlySet<RowId> | null;
}

export const FilterContext = createContext<SettingsFilter>({ query: '', matches: null });

export function useSettingsFilter(): SettingsFilter {
  return useContext(FilterContext);
}

export function useRowVisible(id: RowId): boolean {
  const { matches } = useContext(FilterContext);
  return !matches || matches.has(id);
}

export function groupHasMatches(matches: ReadonlySet<RowId> | null, section: SectionId, group?: string): boolean {
  if (!matches) return true;
  return ROW_IDS.some((id) => {
    const meta = rowMeta(id);
    return meta.section === section && meta.group === group && matches.has(id);
  });
}

export function sectionHasMatches(matches: ReadonlySet<RowId> | null, section: SectionId): boolean {
  if (!matches) return true;
  return ROW_IDS.some((id) => rowMeta(id).section === section && matches.has(id));
}

/** Set on <html> while a key recorder is listening, so global shortcuts stand down. */
export const RECORDING_ATTRIBUTE = 'data-lookout-recording';

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function controlIdFor(id: RowId): string {
  return `settings-${id.replace(/\./g, '-')}`;
}
