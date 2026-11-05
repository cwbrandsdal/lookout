// Groups palette items into sections and ranks them against a query.

import { fuzzyMatchFields } from './fuzzy';

export interface Rankable {
  section: string;
  label: string;
  detail?: string;
  /** Searched but never shown. */
  keywords?: string;
}

export interface RankedRow<T> {
  item: T;
  score: number;
  labelPositions: number[];
  detailPositions: number[];
}

export interface RankedSection<T> {
  title: string;
  rows: RankedRow<T>[];
}

export interface RankOptions {
  /** Max rows per section title. */
  limits?: Record<string, number>;
  /** Max rows for sections without an entry in `limits`. */
  defaultLimit?: number;
  maxTotal?: number;
}

const FIELD_WEIGHTS = [1, 0.8, 0.5];

/**
 * Without a query, sections keep their first-appearance order and items their
 * input order. With a query, non-matching items are dropped, rows are sorted by
 * score and sections by their best row, so the top result is always first.
 */
export function rankSections<T extends Rankable>(items: readonly T[], query: string, options: RankOptions = {}): RankedSection<T>[] {
  const q = query.trim();
  const groups = new Map<string, { order: number; best: number; rows: RankedRow<T>[] }>();

  for (const item of items) {
    let row: RankedRow<T>;
    if (q) {
      const match = fuzzyMatchFields(q, [item.label, item.detail, item.keywords], FIELD_WEIGHTS);
      if (!match) {
        continue;
      }
      row = { item, score: match.score, labelPositions: match.positions[0], detailPositions: match.positions[1] };
    } else {
      row = { item, score: 0, labelPositions: [], detailPositions: [] };
    }

    let group = groups.get(item.section);
    if (!group) {
      group = { order: groups.size, best: Number.NEGATIVE_INFINITY, rows: [] };
      groups.set(item.section, group);
    }
    group.rows.push(row);
    group.best = Math.max(group.best, row.score);
  }

  const ordered = [...groups.entries()].map(([title, group]) => ({ title, ...group }));
  if (q) {
    // Array#sort is stable, so equal scores keep their input order.
    ordered.sort((a, b) => b.best - a.best || a.order - b.order);
    for (const group of ordered) {
      group.rows.sort((a, b) => b.score - a.score);
    }
  }

  let remaining = options.maxTotal ?? Number.POSITIVE_INFINITY;
  const sections: RankedSection<T>[] = [];
  for (const group of ordered) {
    if (remaining <= 0) {
      break;
    }
    const limit = Math.min(options.limits?.[group.title] ?? options.defaultLimit ?? Number.POSITIVE_INFINITY, remaining);
    const rows = group.rows.slice(0, limit);
    if (rows.length) {
      sections.push({ title: group.title, rows });
      remaining -= rows.length;
    }
  }
  return sections;
}
