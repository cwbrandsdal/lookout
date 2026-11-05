import type { ColorScheme } from './settings';

const ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightPurple', 'brightCyan', 'brightWhite',
] as const;

function palette(name: string, background: string, foreground: string, cursorColor: string, selectionBackground: string, ansi: string): ColorScheme {
  const colors = ansi.split(' ');
  return {
    name, background, foreground, cursorColor, selectionBackground,
    ...Object.fromEntries(ANSI_KEYS.map((key, index) => [key, `#${colors[index]}`])),
  } as ColorScheme;
}

// WT palettes: microsoft/terminal, TerminalSettingsModel/defaults.json (MIT).
// WT's default selectionBackground is white when the palette omits it.
// Extras: published iTerm2-Color-Schemes terminal ports (MIT), with Nord's
// canonical nord3 bright black. "GitHub Light" is the light "GitHub" port.
export const BUILTIN_SCHEMES: ColorScheme[] = [
  palette('Campbell', '#0c0c0c', '#cccccc', '#ffffff', '#ffffff',
    '0c0c0c c50f1f 13a10e c19c00 0037da 881798 3a96dd cccccc 767676 e74856 16c60c f9f1a5 3b78ff b4009e 61d6d6 f2f2f2'),
  palette('Campbell Powershell', '#012456', '#cccccc', '#ffffff', '#ffffff',
    '0c0c0c c50f1f 13a10e c19c00 0037da 881798 3a96dd cccccc 767676 e74856 16c60c f9f1a5 3b78ff b4009e 61d6d6 f2f2f2'),
  palette('Vintage', '#000000', '#c0c0c0', '#ffffff', '#ffffff',
    '000000 800000 008000 808000 000080 800080 008080 c0c0c0 808080 ff0000 00ff00 ffff00 0000ff ff00ff 00ffff ffffff'),
  palette('One Half Dark', '#282c34', '#dcdfe4', '#ffffff', '#ffffff',
    '282c34 e06c75 98c379 e5c07b 61afef c678dd 56b6c2 dcdfe4 5a6374 e06c75 98c379 e5c07b 61afef c678dd 56b6c2 dcdfe4'),
  palette('One Half Light', '#fafafa', '#383a42', '#4f525d', '#383a42',
    '383a42 e45649 50a14f c18301 0184bc a626a4 0997b3 fafafa 4f525d df6c75 98c379 e4c07a 61afef c577dd 56b5c1 ffffff'),
  palette('Solarized Dark', '#002b36', '#839496', '#ffffff', '#ffffff',
    '002b36 dc322f 859900 b58900 268bd2 d33682 2aa198 eee8d5 073642 cb4b16 586e75 657b83 839496 6c71c4 93a1a1 fdf6e3'),
  palette('Solarized Light', '#fdf6e3', '#657b83', '#002b36', '#2c4d57',
    '002b36 dc322f 859900 b58900 268bd2 d33682 2aa198 eee8d5 073642 cb4b16 586e75 657b83 839496 6c71c4 93a1a1 fdf6e3'),
  palette('Tango Dark', '#000000', '#d3d7cf', '#ffffff', '#ffffff',
    '000000 cc0000 4e9a06 c4a000 3465a4 75507b 06989a d3d7cf 555753 ef2929 8ae234 fce94f 729fcf ad7fa8 34e2e2 eeeeec'),
  palette('Tango Light', '#ffffff', '#555753', '#000000', '#141414',
    '000000 cc0000 4e9a06 c4a000 3465a4 75507b 06989a d3d7cf 555753 ef2929 8ae234 fce94f 729fcf ad7fa8 34e2e2 eeeeec'),
  palette('Ottosson', '#000000', '#bebebe', '#ffffff', '#92a4fd',
    '000000 be2c21 3fae3a be9a4a 204dbe bb54be 00a7b2 bebebe 808080 ff3e30 58ea51 ffc944 2f6aff fc74ff 00e1f0 ffffff'),
  palette('Dark+', '#1e1e1e', '#cccccc', '#808080', '#ffffff',
    '000000 cd3131 0dbc79 e5e510 2472c8 bc3fbc 11a8cd e5e5e5 666666 f14c4c 23d18b f5f543 3b8eea d670d6 29b8db e5e5e5'),
  palette('CGA', '#000000', '#aaaaaa', '#00aa00', '#ffffff',
    '000000 aa0000 00aa00 aa5500 0000aa aa00aa 00aaaa aaaaaa 555555 ff5555 55ff55 ffff55 5555ff ff55ff 55ffff ffffff'),
  palette('IBM 5153', '#000000', '#aaaaaa', '#00aa00', '#ffffff',
    '000000 aa0000 00aa00 c47e00 0000aa aa00aa 00aaaa aaaaaa 555555 ff5555 55ff55 ffff55 5555ff ff55ff 55ffff ffffff'),
  palette('Dracula', '#282a36', '#f8f8f2', '#f8f8f2', '#44475a',
    '21222c ff5555 50fa7b f1fa8c bd93f9 ff79c6 8be9fd f8f8f2 6272a4 ff6e6e 69ff94 ffffa5 d6acff ff92df a4ffff ffffff'),
  palette('Catppuccin Mocha', '#1e1e2e', '#cdd6f4', '#f5e0dc', '#f5e0dc',
    '45475a f38ba8 a6e3a1 f9e2af 89b4fa f5c2e7 94e2d5 bac2de 585b70 f7aec2 c2ecbf fcd682 aeccfc f398da b1eae1 a6adc8'),
  palette('Catppuccin Latte', '#eff1f5', '#4c4f69', '#dc8a78', '#dc8a78',
    'bcc0cc d20f39 40a02b df8e1d 1e66f5 ea76cb 179299 5c5f77 acb0be e7103f 46b02f e49931 3878f6 ef95d7 19a1a8 6c6f85'),
  palette('Tokyo Night', '#1a1b26', '#c0caf5', '#c0caf5', '#33467c',
    '15161e f7768e 9ece6a e0af68 7aa2f7 bb9af7 7dcfff a9b1d6 414868 f7768e 9ece6a e0af68 7aa2f7 bb9af7 7dcfff c0caf5'),
  palette('Gruvbox Dark', '#282828', '#ebdbb2', '#ebdbb2', '#665c54',
    '282828 cc241d 98971a d79921 458588 b16286 689d6a a89984 928374 fb4934 b8bb26 fabd2f 83a598 d3869b 8ec07c ebdbb2'),
  palette('Nord', '#2e3440', '#d8dee9', '#eceff4', '#eceff4',
    '3b4252 bf616a a3be8c ebcb8b 81a1c1 b48ead 88c0d0 e5e9f0 4c566a bf616a a3be8c ebcb8b 81a1c1 b48ead 8fbcbb eceff4'),
  palette('GitHub Dark', '#101216', '#8b949e', '#c9d1d9', '#3b5070',
    '000000 f78166 56d364 e3b341 6ca4f8 db61a2 2b7489 ffffff 4d4d4d f78166 56d364 e3b341 6ca4f8 db61a2 2b7489 ffffff'),
  palette('GitHub Light', '#f4f4f4', '#3e3e3e', '#3f3f3f', '#a9c1e2',
    '3e3e3e 970b16 07962a c5bb94 003e8a e94691 7cc4df b2b2b2 666666 de0000 7ac895 d7b600 2e6cba f29592 00c7cb ffffff'),
  palette('Lookout Night', '#0b0d11', '#d6dde8', '#f0883e', '#2a3140',
    '161b22 e56b6f 85bd82 d9b66f 7aa2d6 b69bd6 78bac2 c6cdd8 697586 f08b8f a3d49f f0d092 9abded d0b8ed 9cd6dd f1f4f8'),
  // Lighter dark variants; they pair with the Dusk, Slate and Ash window themes (themes.ts).
  palette('Lookout Dusk', '#16191e', '#d8dee8', '#f0883e', '#323b4b',
    '232830 e56b6f 85bd82 d9b66f 7aa2d6 b69bd6 78bac2 c6cdd8 6c7889 f08b8f a3d49f f0d092 9abded d0b8ed 9cd6dd f1f4f8'),
  palette('Lookout Slate', '#22272e', '#c9d1d9', '#f0883e', '#3e4a5b',
    '2d333b f47067 8ddb8c daaa3f 6cb6ff dcbdfb 76c7d2 c5ced8 768390 ff938a b4f1b4 f2cc60 96d0ff eedcff 9de0e8 eef2f6'),
  palette('Lookout Ash', '#262624', '#e6e2d9', '#f0883e', '#4a463e',
    '34342f e5786d 9bbf7a e1b866 7fa8d4 c49bd0 7fbfb3 d6d1c6 7f7a70 f0958b b5d496 f0cd86 9cc0e6 d9b5e4 9dd5ca f6f3ed'),
  palette('Lookout Day', '#fbfbfa', '#252b35', '#bd591c', '#e1e6ed',
    '252b35 b43642 39733c 8a6516 315e9c 7952a0 216f78 d5dbe3 606b7a c54b55 468348 a07822 4475b5 9167b7 29848e ffffff'),
];

/** Extra palettes override built-ins with the same (case-insensitive) name. */
export function findScheme(name: string, extra: readonly ColorScheme[] = []): ColorScheme | undefined {
  const key = name.trim().toLowerCase();
  return [...extra, ...BUILTIN_SCHEMES].find((scheme) => scheme.name.toLowerCase() === key);
}

function color(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (/^#[\da-f]{3}$/i.test(value)) return `#${[...value.slice(1)].map((part) => part.repeat(2)).join('')}`.toLowerCase();
  return /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value) ? value.toLowerCase() : undefined;
}

/** Accept a WT settings object, an array of schemes, or an individual scheme. Invalid entries are skipped. */
export function parseWtSchemes(json: unknown): ColorScheme[] {
  if (!json || typeof json !== 'object') return [];
  const object = json as Record<string, unknown>;
  const values: unknown[] = Array.isArray(json) ? json : Array.isArray(object.schemes) ? object.schemes : [json];
  const result = new Map<string, ColorScheme>();
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.name !== 'string' || !entry.name.trim()) continue;
    const keys = [...ANSI_KEYS, 'foreground', 'background'] as const;
    const pairs = keys.map((key) => [key, color(entry[key])] as const);
    if (pairs.some(([, value]) => !value)) continue;
    const scheme = {
      ...Object.fromEntries(pairs),
      name: entry.name,
      cursorColor: color(entry.cursorColor) ?? '#ffffff',
      selectionBackground: color(entry.selectionBackground) ?? '#ffffff',
    } as ColorScheme;
    result.set(scheme.name.toLowerCase(), scheme);
  }
  return [...result.values()];
}

/** Parse the color dictionaries in an XML .itermcolors plist; no DTDs/entities are fetched. */
export function parseItermColors(xml: string, name: string): ColorScheme {
  const colors = new Map<string, string>();
  const source = xml.replace(/<!--[\s\S]*?-->/g, '');
  for (const match of source.matchAll(/<key>\s*([^<]+?)\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/g)) {
    const components = new Map<string, number>();
    for (const component of match[2].matchAll(/<key>\s*(Red|Green|Blue) Component\s*<\/key>\s*<(real|integer)>\s*([^<]+)\s*<\/\2>/g)) {
      const number = Number(component[3]);
      if (Number.isFinite(number)) components.set(component[1], Math.min(1, Math.max(0, number)));
    }
    if (components.size === 3) {
      colors.set(match[1], `#${['Red', 'Green', 'Blue'].map((key) =>
        Math.round(components.get(key)! * 255).toString(16).padStart(2, '0')).join('')}`);
    }
  }
  const background = colors.get('Background Color');
  const foreground = colors.get('Foreground Color');
  if (!background || !foreground) throw new Error('Invalid iTerm colors: missing background or foreground RGB components');
  const result = { ...BUILTIN_SCHEMES[0], name, background, foreground };
  for (const [index, key] of ANSI_KEYS.entries()) result[key] = colors.get(`Ansi ${index} Color`) ?? result[key];
  result.cursorColor = colors.get('Cursor Color') ?? foreground;
  result.selectionBackground = colors.get('Selection Color') ?? '#ffffff';
  return result;
}

/** W3C relative luminance, with the midpoint used to choose a light or dark UI. */
export function isLightScheme(scheme: ColorScheme): boolean {
  const background = color(scheme.background);
  if (!background) return false;
  const rgb = [1, 3, 5].map((offset) => parseInt(background.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] > 0.5;
}
