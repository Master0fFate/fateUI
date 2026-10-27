export type Modifier = 'ctrl' | 'shift' | 'alt' | 'meta';

export type NamedKey =
  | 'enter' | 'tab' | 'escape' | 'backspace' | 'delete' | 'space'
  | 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pageup' | 'pagedown'
  | 'insert' | 'capslock' | 'printscreen' | 'menu'
  | `f${number}`;

export type KeyName = Modifier | NamedKey | { readonly char: string };

export interface KeyCombo {
  readonly modifiers: readonly Modifier[];
  readonly key: KeyName | null;
}

const modifierAliases: Record<string, Modifier> = {
  ctrl: 'ctrl', control: 'ctrl', lctrl: 'ctrl', rctrl: 'ctrl', controll: 'ctrl', controlr: 'ctrl',
  shift: 'shift', lshift: 'shift', rshift: 'shift', shiftl: 'shift', shiftr: 'shift',
  alt: 'alt', option: 'alt', opt: 'alt', lalt: 'alt', ralt: 'alt', altl: 'alt', altr: 'alt',
  meta: 'meta', cmd: 'meta', command: 'meta', super: 'meta', win: 'meta', windows: 'meta', superl: 'meta', superr: 'meta', metal: 'meta', metar: 'meta',
};

const keyAliases: Record<string, NamedKey> = {
  enter: 'enter', return: 'enter', kpenter: 'enter',
  tab: 'tab', escape: 'escape', esc: 'escape',
  backspace: 'backspace', back: 'backspace',
  delete: 'delete', del: 'delete',
  space: 'space', spacebar: 'space',
  up: 'up', arrowup: 'up', down: 'down', arrowdown: 'down', left: 'left', arrowleft: 'left', right: 'right', arrowright: 'right',
  home: 'home', end: 'end',
  pageup: 'pageup', pgup: 'pageup', prior: 'pageup',
  pagedown: 'pagedown', pgdn: 'pagedown', pgdown: 'pagedown', next: 'pagedown',
  insert: 'insert', ins: 'insert',
  capslock: 'capslock', printscreen: 'printscreen', print: 'printscreen', prtsc: 'printscreen',
  menu: 'menu', apps: 'menu', contextmenu: 'menu',
};

const symbolNames: Record<string, string> = {
  minus: '-', equal: '=', plus: '+', comma: ',', period: '.', slash: '/', backslash: '\\', semicolon: ';',
  apostrophe: '\'', grave: '`', bracketleft: '[', bracketright: ']',
};

export function parseKeySequence(text: string): KeyCombo[] {
  const parts = text.trim().split(/\s+/u).filter(Boolean);
  if (!parts.length) throw new Error('A key or key combination is required, for example "ctrl+s" or "Return".');
  if (parts.length > 16) throw new Error('Send at most 16 key combinations at once.');
  return parts.map(parseKeyCombo);
}

export function parseKeyCombo(text: string): KeyCombo {
  const tokens = text === '+' ? ['+'] : text.split('+').map((token, index, all) => token === '' && index === all.length - 1 ? '+' : token).filter(Boolean);
  const modifiers: Modifier[] = [];
  let key: KeyName | null = null;
  for (const [index, token] of tokens.entries()) {
    const resolved = resolveKey(token);
    const last = index === tokens.length - 1;
    if (typeof resolved === 'string' && isModifier(resolved) && !last) {
      if (!modifiers.includes(resolved)) modifiers.push(resolved);
      continue;
    }
    if (!last) throw new Error(`"${token}" in "${text}" is not a modifier. Put the main key last, like "ctrl+shift+t".`);
    key = resolved;
  }
  if (typeof key === 'string' && isModifier(key)) {
    if (!modifiers.includes(key)) modifiers.push(key);
    key = null;
  }
  return { modifiers, key };
}

export function parseModifiers(text: string | undefined): Modifier[] {
  if (!text?.trim()) return [];
  return text.split('+').map((token) => {
    const modifier = modifierAliases[normalize(token)];
    if (!modifier) throw new Error(`"${token}" is not a modifier key. Use ctrl, shift, alt, or meta.`);
    return modifier;
  });
}

function isModifier(key: KeyName): key is Modifier {
  return key === 'ctrl' || key === 'shift' || key === 'alt' || key === 'meta';
}

function resolveKey(token: string): KeyName {
  if ([...token].length === 1) return { char: token };
  const name = normalize(token);
  const modifier = modifierAliases[name];
  if (modifier) return modifier;
  const named = keyAliases[name];
  if (named) return named;
  const symbol = symbolNames[name];
  if (symbol) return { char: symbol };
  if (/^f(?:[1-9]|1\d|2[0-4])$/u.test(name)) return name as NamedKey;
  throw new Error(`Unknown key "${token}".`);
}

function normalize(token: string): string {
  return token.trim().toLowerCase().replace(/[_\s-]/gu, '');
}
