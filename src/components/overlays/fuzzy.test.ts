import { describe, expect, it } from 'vitest';

import { fuzzyMatch, fuzzyMatchFields, highlightSegments } from './fuzzy';

function rank(query: string, texts: string[]): string[] {
  return texts
    .map((text) => ({ text, match: fuzzyMatch(query, text) }))
    .filter((entry) => entry.match)
    .sort((a, b) => b.match!.score - a.match!.score)
    .map((entry) => entry.text);
}

describe('fuzzyMatch', () => {
  it('matches subsequences case-insensitively', () => {
    expect(fuzzyMatch('NTB', 'new tab')?.positions).toEqual([0, 4, 6]);
    expect(fuzzyMatch('tab', 'TAB')?.positions).toEqual([0, 1, 2]);
  });

  it('rejects non-subsequences and over-long queries', () => {
    expect(fuzzyMatch('tba', 'tab')).toBeNull();
    expect(fuzzyMatch('xyz', 'Split pane right')).toBeNull();
    expect(fuzzyMatch('tabs', 'tab')).toBeNull();
  });

  it('matches everything with an empty query', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, positions: [] });
  });

  it('prefers word boundaries over mid-word characters', () => {
    expect(fuzzyMatch('gb', 'debug git branch')?.positions).toEqual([6, 10]);
    expect(fuzzyMatch('sr', 'Split pane right')?.positions).toEqual([0, 11]);
  });

  it('prefers camelCase humps', () => {
    expect(fuzzyMatch('ps', 'PowerShell')?.positions).toEqual([0, 5]);
  });

  it('prefers a contiguous run over scattered boundary hits', () => {
    expect(fuzzyMatch('tab', 'toggle a tab')?.positions).toEqual([9, 10, 11]);
  });

  it('ranks prefix and boundary matches above scattered ones', () => {
    expect(rank('nt', ['Focus next pane', 'New tab', 'Open settings'])[0]).toBe('New tab');
    expect(rank('copy', ['Copy last command output', 'Copy'])[0]).toBe('Copy');
    expect(rank('split', ['Toggle split view', 'Split pane right'])[0]).toBe('Split pane right');
  });

  it('ranks an exact match first', () => {
    expect(rank('find', ['Find next', 'Find', 'Find previous'])[0]).toBe('Find');
  });

  it('handles non-ASCII text and long inputs', () => {
    expect(fuzzyMatch('ø', 'Brøndby')?.positions).toEqual([2]);
    expect(fuzzyMatch('z', `${'a'.repeat(400)}z`)).toBeNull();
  });
});

describe('fuzzyMatchFields', () => {
  it('requires every token to match some field, in any order', () => {
    const match = fuzzyMatchFields('right pwsh', ['Split right with PowerShell']);
    expect(match).not.toBeNull();
    expect(match!.positions[0]).toEqual([6, 7, 8, 9, 10, 17, 19, 22, 23]);
    expect(fuzzyMatchFields('right zsh', ['Split right with PowerShell'])).toBeNull();
    expect(fuzzyMatchFields('pwsh right', ['Split right with PowerShell'])).not.toBeNull();
  });

  it('assigns each token to its best field', () => {
    const match = fuzzyMatchFields('api main', ['api', 'main', undefined]);
    expect(match!.positions).toEqual([[0, 1, 2], [0, 1, 2, 3], []]);
  });

  it('applies field weights', () => {
    const label = fuzzyMatchFields('tab', ['tab', undefined], [1, 0.5])!;
    const detail = fuzzyMatchFields('tab', [undefined, 'tab'], [1, 0.5])!;
    expect(label.score).toBeGreaterThan(detail.score);
  });

  it('matches everything with a blank query', () => {
    expect(fuzzyMatchFields('   ', ['a', 'b'])).toEqual({ score: 0, positions: [[], []] });
  });
});

describe('highlightSegments', () => {
  it('merges runs of matched and unmatched characters', () => {
    expect(highlightSegments('New tab', [0, 4, 5])).toEqual([
      { text: 'N', match: true },
      { text: 'ew ', match: false },
      { text: 'ta', match: true },
      { text: 'b', match: false },
    ]);
  });

  it('returns the whole text unmatched without positions', () => {
    expect(highlightSegments('abc', [])).toEqual([{ text: 'abc', match: false }]);
    expect(highlightSegments('', [])).toEqual([]);
  });
});
