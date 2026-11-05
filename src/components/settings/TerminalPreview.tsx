import type { CSSProperties, ReactNode } from 'react';

import type { ColorScheme, CursorStyle, FontSettings } from '../../shared/settings';
import { fontFamily } from '../../terminal/theme';
import { cx } from './filter';
import { SCHEME_ANSI_KEYS } from './helpers';

type Tone = (typeof SCHEME_ANSI_KEYS)[number];

function Ink({ tone, bold, children }: { tone?: Tone; bold?: boolean; children: ReactNode }) {
  return <span className={cx(tone && `settings-pv-${tone}`, bold && 'settings-pv-bold')}>{children}</span>;
}

function Prompt() {
  return (
    <>
      <Ink tone="blue" bold>
        ~/src/lookout
      </Ink>{' '}
      <Ink tone="purple">main</Ink>
      <Ink tone="yellow"> ↑1</Ink> <Ink tone="green">❯</Ink>{' '}
    </>
  );
}

interface TerminalPreviewProps {
  scheme: ColorScheme;
  font: FontSettings;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
}

/** Static sample terminal rendered with a color scheme and font (no xterm instance). */
export function TerminalPreview({ scheme, font, cursorStyle, cursorBlink }: TerminalPreviewProps) {
  const style: Record<string, string | number> = {
    '--settings-pv-bg': scheme.background,
    '--settings-pv-fg': scheme.foreground,
    '--settings-pv-cursor': scheme.cursorColor,
    '--settings-pv-selection': scheme.selectionBackground,
    '--settings-pv-weight-bold': font.weightBold,
    fontFamily: fontFamily(font.face),
    fontSize: `${font.size}px`,
    lineHeight: font.lineHeight,
    letterSpacing: `${font.letterSpacing}px`,
    fontWeight: font.weight,
  };
  for (const key of SCHEME_ANSI_KEYS) {
    style[`--settings-pv-${key}`] = scheme[key];
  }

  return (
    <div className="settings-preview" style={style as CSSProperties} role="img" aria-label={`Terminal preview with ${scheme.name} and ${font.face}`}>
      <div>
        <Prompt />
        ls
      </div>
      <div>
        <Ink tone="blue" bold>
          docs/
        </Ink>
        {'  '}
        <Ink tone="blue" bold>
          src/
        </Ink>
        {'  '}
        <Ink tone="green" bold>
          build.ps1
        </Ink>
        {'  '}
        <Ink tone="cyan">node_modules@</Ink>
        {'  '}README.md{'  '}
        <Ink tone="red">release.zip</Ink>
        {'  '}
        <Ink tone="brightBlack">.gitignore</Ink>
      </div>
      <div>
        <Prompt />
        git pushh
      </div>
      <div>
        <Ink tone="red">git: &apos;pushh&apos; is not a git command. See &apos;git --help&apos;.</Ink>
      </div>
      <div>
        <Prompt />
        npm test
      </div>
      <div>
        <Ink tone="brightGreen">✓ 42 passed</Ink>
        {'  '}
        <Ink tone="brightYellow">2 skipped</Ink>
        {'  '}
        <Ink tone="brightRed">1 failed</Ink>
        {'  '}
        <Ink tone="brightCyan">0.84s</Ink>
        {'  '}
        <span className="settings-pv-selection">selected text</span>
      </div>
      <div>
        <Prompt />
        <span className={cx('settings-pv-cursor', `settings-pv-cursor--${cursorStyle}`, cursorBlink && 'settings-pv-cursor--blink')}> </span>
      </div>
    </div>
  );
}
