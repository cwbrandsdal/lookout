// Fuzzy matching for the command palette: case-insensitive subsequence match
// with word-boundary, camelCase and contiguity bonuses. The best alignment is
// found with a small DP, so "tab" in "toggle a tab" highlights the contiguous
// "tab" instead of t…a…b scattered across words.

export interface FuzzyMatch {
  score: number;
  /** Ascending indices into the text of the matched characters. */
  positions: number[];
}

const SCORE_MATCH = 1;
const BONUS_START = 10;
const BONUS_BOUNDARY = 8;
const BONUS_CAMEL = 6;
const BONUS_CONSECUTIVE = 5;
const PENALTY_GAP = 0.35;
const PENALTY_LEADING = 0.1;
const MAX_LEADING_PENALTY = 3;
const PENALTY_LENGTH = 0.03;
const MAX_LENGTH_PENALTY = 1.5;
const BONUS_PREFIX = 4;
const BONUS_EXACT = 6;
/** Longer texts are matched on their first MAX_TEXT characters only. */
const MAX_TEXT = 256;

const WORD_CHAR = /[\p{L}\p{N}]/u;

function isLower(char: string): boolean {
  return char !== char.toUpperCase() && char === char.toLowerCase();
}

function isUpper(char: string): boolean {
  return char !== char.toLowerCase() && char === char.toUpperCase();
}

function bonusAt(text: string, index: number): number {
  if (index === 0) {
    return BONUS_START;
  }
  const previous = text[index - 1];
  const current = text[index];
  if (!WORD_CHAR.test(previous) && WORD_CHAR.test(current)) {
    return BONUS_BOUNDARY;
  }
  if (isLower(previous) && isUpper(current)) {
    return BONUS_CAMEL;
  }
  return 0;
}

/** Matches one query (spaces are literal) against a text. Returns null when it is not a subsequence. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  const m = q.length;
  if (!m) {
    return { score: 0, positions: [] };
  }

  const source = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  const t = source.toLowerCase();
  const n = t.length;
  if (m > n) {
    return null;
  }

  // Cheap rejection before the DP.
  let found = 0;
  for (let j = 0; j < n && found < m; j += 1) {
    if (t[j] === q[found]) {
      found += 1;
    }
  }
  if (found < m) {
    return null;
  }

  const bonus = new Float64Array(n);
  for (let j = 0; j < n; j += 1) {
    bonus[j] = bonusAt(source, j);
  }

  const NEG = Number.NEGATIVE_INFINITY;
  // score[i * n + j]: best score with q[i] matched at t[j]; from[]: where q[i - 1] matched.
  const score = new Float64Array(m * n).fill(NEG);
  const from = new Int32Array(m * n).fill(-1);

  for (let j = 0; j < n; j += 1) {
    if (t[j] === q[0]) {
      score[j] = SCORE_MATCH + bonus[j] - Math.min(j * PENALTY_LEADING, MAX_LEADING_PENALTY);
    }
  }

  for (let i = 1; i < m; i += 1) {
    const row = i * n;
    const previousRow = (i - 1) * n;
    // Best previous match at k <= j - 2, already charged for the gap up to j.
    let run = NEG;
    let runIndex = -1;
    for (let j = 1; j < n; j += 1) {
      run -= PENALTY_GAP;
      if (j >= 2) {
        const candidate = score[previousRow + j - 2] - PENALTY_GAP;
        if (candidate > run) {
          run = candidate;
          runIndex = j - 2;
        }
      }
      if (t[j] !== q[i]) {
        continue;
      }

      let best = run;
      let bestIndex = runIndex;
      const adjacent = score[previousRow + j - 1];
      if (adjacent !== NEG && adjacent + BONUS_CONSECUTIVE >= best) {
        best = adjacent + BONUS_CONSECUTIVE;
        bestIndex = j - 1;
      }
      if (best === NEG) {
        continue;
      }
      score[row + j] = best + SCORE_MATCH + bonus[j];
      from[row + j] = bestIndex;
    }
  }

  const lastRow = (m - 1) * n;
  let end = -1;
  let total = NEG;
  for (let j = m - 1; j < n; j += 1) {
    if (score[lastRow + j] > total) {
      total = score[lastRow + j];
      end = j;
    }
  }
  if (end < 0) {
    return null;
  }

  const positions = new Array<number>(m);
  for (let i = m - 1, j = end; i >= 0; i -= 1) {
    positions[i] = j;
    j = from[i * n + j];
  }

  if (positions[0] === 0 && positions[m - 1] === m - 1) {
    total += m === n ? BONUS_EXACT : BONUS_PREFIX;
  }
  total -= Math.min((text.length - m) * PENALTY_LENGTH, MAX_LENGTH_PENALTY);

  return { score: total, positions };
}

export interface FieldsMatch {
  score: number;
  /** Matched positions per field (same order as the fields passed in). */
  positions: number[][];
}

/**
 * Splits the query on whitespace; every token must match one of the fields
 * (in any order). Each token picks the field where it scores best after
 * weighting, so "right pwsh" matches "Split right with PowerShell".
 */
export function fuzzyMatchFields(query: string, fields: ReadonlyArray<string | undefined>, weights: readonly number[] = []): FieldsMatch | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const positions = fields.map(() => [] as number[]);
  if (!tokens.length) {
    return { score: 0, positions };
  }

  let total = 0;
  for (const token of tokens) {
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestField = -1;
    let bestPositions: number[] = [];
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index];
      if (!field) {
        continue;
      }
      const match = fuzzyMatch(token, field);
      if (!match) {
        continue;
      }
      const weighted = match.score * (weights[index] ?? 1);
      if (weighted > bestScore) {
        bestScore = weighted;
        bestField = index;
        bestPositions = match.positions;
      }
    }
    if (bestField < 0) {
      return null;
    }
    total += bestScore;
    positions[bestField].push(...bestPositions);
  }

  return { score: total, positions: positions.map((list) => [...new Set(list)].sort((a, b) => a - b)) };
}

export interface Segment {
  text: string;
  match: boolean;
}

/** Splits text into runs of matched / unmatched characters for highlighting. */
export function highlightSegments(text: string, positions: readonly number[]): Segment[] {
  if (!positions.length) {
    return text ? [{ text, match: false }] : [];
  }
  const marked = new Set(positions);
  const segments: Segment[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const match = marked.has(index);
    const last = segments[segments.length - 1];
    if (last && last.match === match) {
      last.text += text[index];
    } else {
      segments.push({ text: text[index], match });
    }
  }
  return segments;
}
