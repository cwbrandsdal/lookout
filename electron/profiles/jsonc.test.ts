import { describe, expect, it } from 'vitest';
import { parseJsonc } from './jsonc';

describe('parseJsonc', () => {
  it('handles BOM, both comment forms, nested trailing commas, and CRLF', () => {
    expect(parseJsonc('\uFEFF{\r\n// settings\r\n"list": [1, /* next */ {"ok": true,},],\r\n}')).toEqual({ list: [1, { ok: true }] });
  });

  it('preserves URLs, comment-like strings, escaped quotes, Unicode, and Windows paths', () => {
    const values = { url: 'https://example.com/a//b', text: '🛰️ /* not a comment */ ,}', quote: 'a\\"//b', path: 'C:\\Windows\\cmd.exe' };
    expect(parseJsonc(`${JSON.stringify(values)} // final comment`)).toEqual(values);
  });

  it('rejects invalid JSON and unterminated block comments', () => {
    expect(() => parseJsonc('{"a": /* unclosed')).toThrow(SyntaxError);
    expect(() => parseJsonc('{"a": 1,,}')).toThrow(SyntaxError);
    expect(() => parseJsonc('{"a": "unclosed}')).toThrow(SyntaxError);
    expect(() => parseJsonc('/*')).toThrow(SyntaxError);
  });
});
