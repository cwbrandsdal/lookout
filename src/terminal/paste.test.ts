import { describe, expect, it } from 'vitest';

import { preparePaste } from './paste';

describe('preparePaste', () => {
  it.each(['\n', '\r', '\r\n', '\r\n\r\n', '\n\r\n'])('removes trailing %j from a single-line paste when auto-submit is off', (ending) => {
    expect(preparePaste(`echo hello${ending}`, false)).toBe('echo hello');
  });

  it.each(['', 'echo hello', '  echo hello  ', '\ttext\t'])('preserves single-line text and whitespace in %j', (text) => {
    expect(preparePaste(text, false)).toBe(text);
  });

  it('preserves spaces before a trailing line break', () => {
    expect(preparePaste('  echo hello  \r\n', false)).toBe('  echo hello  ');
  });

  it.each(['\n', '\r', '\r\n\r\n'])('does not submit a clipboard containing only %j', (text) => {
    expect(preparePaste(text, false)).toBe('');
  });

  it.each(['echo one\necho two\n', 'echo one\recho two\r', 'echo one\r\necho two\r\n', '\necho hello\n'])('preserves multi-line paste %j', (text) => {
    expect(preparePaste(text, false)).toBe(text);
  });

  it.each(['echo hello', 'echo hello\n', 'echo hello\r', 'echo hello\r\n', '\r\n', 'echo one\necho two\n'])('keeps %j unchanged when auto-submit is on', (text) => {
    expect(preparePaste(text, true)).toBe(text);
  });
});
