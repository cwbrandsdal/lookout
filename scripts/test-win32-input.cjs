// Run with: node scripts/test-win32-input.cjs (Windows only).
// No generated files are written into the checkout.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const ROOT = path.resolve(__dirname, '..');
const PROMPT = 'WIN32-INPUT>';
const COLS = 120;
const ROWS = 30;

function keyEvent(key, code, keyCode, type, modifiers = {}) {
  return {
    key, code, keyCode, type,
    location: code.endsWith('Right') ? 2 : code.endsWith('Left') ? 1 : 0,
    repeat: false,
    ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
    getModifierState: (name) => name === 'AltGraph' && Boolean(modifiers.altGraph),
    ...modifiers,
  };
}

function createSession(executable, args, Win32InputEncoder) {
  const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true });
  const encoder = new Win32InputEncoder();
  const child = pty.spawn(executable, args, {
    name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: ROOT,
    env: { ...process.env, TERM: 'xterm-256color' },
    useConpty: true,
    useConptyDll: true,
  });
  let rawOutput = '';
  let exitCode;
  let daReplies = 0;
  const observers = new Set();
  const notify = () => { for (const observer of observers) observer(); };
  // Headless xterm answers DA1 (ESC[c) with ESC[?1;2c, which bundled ConPTY
  // waits for at startup. It also answers PSReadLine's cursor-position queries.
  const inputSubscription = terminal.onData((data) => {
    if (data === '\x1b[?1;2c') daReplies++;
    child.write(data);
  });
  const dataSubscription = child.onData((data) => {
    rawOutput += data;
    terminal.write(data, notify);
  });
  const exitSubscription = child.onExit((result) => {
    exitCode = result.exitCode;
    notify();
  });

  function lines() {
    const buffer = terminal.buffer.active;
    return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row).translateToString(true));
  }

  function waitFor(label, condition, timeout = 15_000) {
    return new Promise((resolve, reject) => {
      function finish(error) {
        clearTimeout(timer);
        observers.delete(check);
        if (error) reject(error);
        else resolve();
      }
      function check() {
        try {
          if (condition()) finish();
          else if (exitCode !== undefined) finish(new Error(`${label}: shell exited with ${exitCode}`));
        } catch (error) {
          finish(error);
        }
      }
      const timer = setTimeout(() => finish(new Error(
        `${label}: timed out\nScreen:\n${lines().join('\n')}\nRaw tail: ${JSON.stringify(rawOutput.slice(-2000))}`,
      )), timeout);
      observers.add(check);
      check();
    });
  }

  function send(key, code, keyCode, type, modifiers) {
    const sequence = encoder.encode(keyEvent(key, code, keyCode, type, modifiers));
    assert.notEqual(sequence, null, `Encoder did not handle ${type} ${code}`);
    child.write(sequence);
  }

  function tap(key, code, keyCode, modifiers) {
    send(key, code, keyCode, 'keydown', modifiers);
    send(key, code, keyCode, 'keyup', modifiers);
  }

  function altGr(key, code, keyCode) {
    send('Control', 'ControlLeft', 17, 'keydown', { ctrlKey: true });
    send('Alt', 'AltRight', 18, 'keydown', { ctrlKey: true, altKey: true, altGraph: true });
    tap(key, code, keyCode, { ctrlKey: true, altKey: true, altGraph: true });
    send('Alt', 'AltRight', 18, 'keyup', { ctrlKey: true });
    send('Control', 'ControlLeft', 17, 'keyup');
  }

  function type(text) {
    for (const character of text) {
      if (character === '@') altGr(character, 'Digit2', 50);
      else if (character === '{') altGr(character, 'Digit7', 55);
      else if (character === '}') altGr(character, 'Digit0', 48);
      else if (character === '€') altGr(character, 'KeyE', 69);
      else if (/^[a-z]$/.test(character)) tap(character, `Key${character.toUpperCase()}`, character.toUpperCase().charCodeAt(0));
      else if (/^[0-9]$/.test(character)) tap(character, `Digit${character}`, character.charCodeAt(0));
      else if (character === ' ') tap(character, 'Space', 32);
      else if (character === "'") tap(character, 'Backslash', 191); // Norwegian apostrophe.
      else throw new Error(`No integration fixture for ${JSON.stringify(character)}`);
    }
  }

  async function command(text, expected) {
    type(text);
    tap('Enter', 'Enter', 13);
    // Check a complete rendered output line, never just echoed command text.
    await waitFor(`Output ${JSON.stringify(expected)}`, () => lines().some((line) => line === expected));
    await waitFor('Next prompt', () => {
      const buffer = terminal.buffer.active;
      return buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true).trim() === PROMPT;
    });
  }

  return {
    type, tap, send, lines, waitFor, command,
    get daReplies() { return daReplies; },
    async ready() {
      await waitFor('Win32 input mode and shell prompt', () => rawOutput.includes('\x1b[?9001h')
        && lines().some((line) => line.trim() === PROMPT));
      assert.ok(daReplies > 0, 'Bundled ConPTY must receive a DA1 response');
    },
    async close(graceful) {
      try {
        if (graceful && exitCode === undefined) {
          type('exit');
          tap('Enter', 'Enter', 13);
          await waitFor('Shell exit', () => exitCode !== undefined, 5000);
        }
      } finally {
        // kill() also closes node-pty's input handle after a natural shell exit.
        child.kill();
        dataSubscription.dispose();
        exitSubscription.dispose();
        inputSubscription.dispose();
        terminal.dispose();
      }
    },
  };
}

async function testShell(name, executable, args, Win32InputEncoder) {
  const session = createSession(executable, args, Win32InputEncoder);
  let success = false;
  try {
    await session.ready();
    const plain = `lookoutplain${name === 'pwsh' ? 'pwsh' : 'cmd'}`;
    await session.command(`echo ${plain}`, plain);
    console.log(`PASS ${name}: encoded text and Enter execute`);

    const altGrText = 'a@b{c}€';
    await session.command(`echo ${name === 'pwsh' ? "'" : ''}${altGrText}${name === 'pwsh' ? "'" : ''}`, altGrText);
    console.log(`PASS ${name}: Norwegian AltGr @, {, }, and € survive ConPTY`);

    if (name === 'pwsh') {
      // A wrong binding leaves "badword" (or part of it) in the quoted string,
      // so neither a command echo nor an unrelated output line can pass this.
      session.type("echo 'lookoutkept badword");
      session.send('Control', 'ControlLeft', 17, 'keydown', { ctrlKey: true });
      session.tap('Backspace', 'Backspace', 8, { ctrlKey: true });
      session.send('Control', 'ControlLeft', 17, 'keyup');
      session.type("goodword'");
      session.tap('Enter', 'Enter', 13);
      await session.waitFor('PSReadLine Ctrl+Backspace removes a word',
        () => session.lines().some((line) => line === 'lookoutkept goodword'));
      console.log('PASS pwsh: PSReadLine Ctrl+Backspace deletes the preceding word');
    }
    console.log(`PASS ${name}: bundled ConPTY mode request and DA1 handshake (${session.daReplies} replies)`);
    success = true;
  } finally {
    await session.close(success);
  }
}

async function main() {
  assert.equal(process.platform, 'win32', 'This ConPTY integration test requires Windows');
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lookout-win32-input-'));
  const compiledPath = path.join(temporaryDirectory, 'win32-input.cjs');
  try {
    buildSync({
      entryPoints: [path.join(ROOT, 'src/terminal/win32-input.ts')],
      outfile: compiledPath, format: 'cjs', platform: 'node', target: 'node22', logLevel: 'silent',
    });
    const { Win32InputEncoder } = require(compiledPath);
    await testShell('cmd.exe', process.env.ComSpec || 'cmd.exe', ['/d', '/q', '/k', 'prompt WIN32-INPUT$G'], Win32InputEncoder);
    let pwsh;
    try {
      pwsh = execFileSync('where.exe', ['pwsh.exe'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
    } catch (error) {
      if (error.status !== 1) throw error;
    }
    if (pwsh) {
      await testShell('pwsh', pwsh, ['-NoLogo', '-NoProfile', '-NoExit', '-Command',
        "Import-Module PSReadLine -ErrorAction Stop; Set-PSReadLineOption -EditMode Windows -PredictionSource None -BellStyle None; function global:prompt { 'WIN32-INPUT> ' }"], Win32InputEncoder);
    } else {
      console.log('SKIP pwsh: executable is not available on PATH');
    }
    console.log('win32-input integration: PASS');
  } finally {
    if (fs.existsSync(compiledPath)) fs.unlinkSync(compiledPath);
    fs.rmdirSync(temporaryDirectory);
  }
}

// Bundled ConPTY in node-pty 1.1 can retain a worker-thread server after the
// shells and their pipes close. All tests and cleanup above are awaited, so
// explicitly end this standalone test process instead of retaining that worker.
main().then(() => {
  process.exit(0);
}, (error) => {
  console.error(error);
  process.exit(1);
});
