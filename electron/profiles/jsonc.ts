/** Parse Windows Terminal JSONC without treating comment markers inside strings as comments. */
export function parseJsonc(text: string): unknown {
  const input = text.replace(/^\uFEFF/, '');
  const chars = [...input];
  let quoted = false;
  let escaped = false;

  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === '/' && chars[i + 1] === '/') {
      while (i < chars.length && chars[i] !== '\n' && chars[i] !== '\r') {
        chars[i++] = ' ';
      }
      i -= 1;
    } else if (char === '/' && chars[i + 1] === '*') {
      chars[i++] = ' ';
      chars[i++] = ' ';
      while (i < chars.length && !(chars[i] === '*' && chars[i + 1] === '/')) {
        if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
        i += 1;
      }
      if (i === chars.length) throw new SyntaxError('Unterminated JSONC comment');
      chars[i] = ' ';
      chars[++i] = ' ';
    }
  }

  quoted = false;
  escaped = false;
  for (let i = 0; i < chars.length; i += 1) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (chars[i] === '\\') escaped = true;
      else if (chars[i] === '"') quoted = false;
    } else if (chars[i] === '"') {
      quoted = true;
    } else if (chars[i] === ',') {
      let next = i + 1;
      while (next < chars.length && /\s/.test(chars[next])) next += 1;
      if (chars[next] === '}' || chars[next] === ']') chars[i] = ' ';
    }
  }
  return JSON.parse(chars.join('')) as unknown;
}
