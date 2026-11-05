import { describe, expect, it } from 'vitest';
import type { Socket } from 'node:net';
import { encodeHandoffFrame, HANDOFF_FRAME, HandoffFrameDecoder, HandoffPty, parseHandoffHello } from './handoff-server';

describe('handoff wire protocol', () => {
  it('decodes split headers, split payloads and multiple frames without losing raw VT bytes', () => {
    const frames = new HandoffFrameDecoder();
    const data = Buffer.from('\x1b[31mhello🌍', 'utf8');
    const exit = Buffer.alloc(4); exit.writeUInt32LE(37);
    const wire = Buffer.concat([encodeHandoffFrame(HANDOFF_FRAME.data, data), encodeHandoffFrame(HANDOFF_FRAME.exit, exit)]);
    const actual: [number, Buffer][] = [];
    for (let i = 0; i < wire.length; i += 3) frames.push(wire.subarray(i, i + 3), (type, payload) => actual.push([type, payload]));
    expect(actual).toEqual([[HANDOFF_FRAME.data, data], [HANDOFF_FRAME.exit, exit]]);
  });

  it('rejects zero and oversized lengths before accumulating their payloads', () => {
    for (const size of [0, 1024 * 1024 + 1, 0xffffffff]) {
      const header = Buffer.alloc(4); header.writeUInt32LE(size);
      expect(() => new HandoffFrameDecoder().push(header, () => {})).toThrow('Invalid handoff frame length');
    }
  });

  it('validates version, PID, dimensions and optional metadata', () => {
    const hello = { version: 1, pid: 42, cols: 120, rows: 30, title: 'cmd', elevated: false };
    expect(parseHandoffHello(Buffer.from(JSON.stringify(hello)))).toEqual(hello);
    for (const patch of [{ version: 2 }, { pid: 0 }, { cols: 32768 }, { rows: -1 }, { title: 7 }, { elevated: 'false' }]) {
      expect(() => parseHandoffHello(Buffer.from(JSON.stringify({ ...hello, ...patch })))).toThrow();
    }
  });

  it('forwards input, resize and kill, and decodes split UTF-8 output', () => {
    const writes: Buffer[] = [];
    const transport = { destroyed: false, writableLength: 0, write: (value: Buffer) => writes.push(value) } as unknown as Socket;
    const pty = new HandoffPty(42, transport);
    const received: string[] = [];
    pty.onData((data) => received.push(data));
    const emoji = Buffer.from('🌍');
    pty.acceptData(emoji.subarray(0, 2));
    pty.acceptData(emoji.subarray(2));
    expect(received).toEqual(['🌍']);
    pty.write('hello\r'); pty.resize(101, 42); pty.resize(0, 42); pty.kill();
    const frames: [number, Buffer][] = [];
    new HandoffFrameDecoder().push(Buffer.concat(writes), (type, payload) => frames.push([type, payload]));
    expect(frames.map(([type]) => type)).toEqual([HANDOFF_FRAME.data, HANDOFF_FRAME.resize, HANDOFF_FRAME.close]);
    expect(frames[0][1].toString()).toBe('hello\r');
    expect([frames[1][1].readUInt32LE(0), frames[1][1].readUInt32LE(4)]).toEqual([101, 42]);
  });

  it('retains early output and delivers a single exit to current and late listeners', async () => {
    const transport = { destroyed: false, writableLength: 0, write: () => {} } as unknown as Socket;
    const pty = new HandoffPty(42, transport);
    pty.acceptData(Buffer.from('early output'));
    const output: string[] = [];
    pty.onData((data) => output.push(data));
    const exits: number[] = [];
    pty.onExit(({ exitCode }) => exits.push(exitCode));
    pty.finish(37); pty.finish(1);
    const late: number[] = [];
    pty.onExit(({ exitCode }) => late.push(exitCode));
    await Promise.resolve();
    expect(output).toEqual(['early output']);
    expect(exits).toEqual([37]);
    expect(late).toEqual([37]);
  });
});
