// Text helpers for the paste confirmation dialog.

export type PasteReason = 'multiline' | 'large' | 'both';

const LINE_BREAK = /\r\n|\r|\n/;

/** Lines of the paste, ignoring trailing line breaks. */
export function splitLines(text: string): string[] {
  const trimmed = text.replace(/(?:\r\n|\r|\n)+$/, '');
  return trimmed ? trimmed.split(LINE_BREAK) : [''];
}

/** "Paste as one line": trims each line, drops blank ones and joins with spaces. */
export function joinLines(text: string): string {
  return splitLines(text)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb < 10 ? kb.toFixed(1).replace(/\.0$/, '') : Math.round(kb)} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, '') : Math.round(mb)} MB`;
}

export function describePaste(text: string, reason: PasteReason): { title: string; message: string; lines: number; size: string } {
  const lines = splitLines(text).length;
  const size = formatBytes(byteLength(text));
  const lineLabel = `${lines} line${lines === 1 ? '' : 's'}`;
  switch (reason) {
    case 'multiline':
      return { title: `Paste ${lineLabel}?`, message: 'Each line may run as soon as it reaches the shell.', lines, size };
    case 'large':
      return { title: `Paste ${size}?`, message: 'This is a large paste and may take a moment to send.', lines, size };
    case 'both':
      return { title: `Paste ${lineLabel} (${size})?`, message: 'This is a large paste, and each line may run as soon as it reaches the shell.', lines, size };
  }
}

export interface ControlSegment {
  text: string;
  /** 'tab' for tabs, 'control' for other C0/DEL characters, null for plain text. */
  kind: 'tab' | 'control' | null;
}

/** Makes control characters visible: tabs as →, others as their Unicode control pictures (␀ … ␟, ␡). */
export function visualizeControls(line: string): ControlSegment[] {
  const segments: ControlSegment[] = [];
  let plain = '';
  for (const char of line) {
    const code = char.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) {
      plain += char;
      continue;
    }
    if (plain) {
      segments.push({ text: plain, kind: null });
      plain = '';
    }
    if (char === '\t') {
      segments.push({ text: '→   ', kind: 'tab' });
    } else {
      segments.push({ text: code === 0x7f ? '␡' : String.fromCharCode(0x2400 + code), kind: 'control' });
    }
  }
  if (plain) {
    segments.push({ text: plain, kind: null });
  }
  return segments;
}
