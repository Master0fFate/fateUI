import { safeFetch } from '../pi/web/SafeFetch';

const TEXT_TYPE = /^(text\/|application\/([\w.+-]+\+)?(json|xml)\b)/u;

export async function fetchWatchedPage(address: string, signal: AbortSignal): Promise<{ type: string; body: string }> {
  const page = await safeFetch(address, { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', signal });
  const type = page.contentType.toLowerCase();
  if (page.status < 200 || page.status >= 300) throw new Error(`The page answered HTTP ${page.status}.`);
  if (type && !TEXT_TYPE.test(type)) throw new Error(`The page is not text (${type.split(';')[0]}).`);
  if (page.truncated) throw new Error('The page is larger than 2 MB.');
  const charset = /charset="?([\w-]+)/iu.exec(type)?.[1] ?? 'utf-8';
  try { return { type, body: new TextDecoder(charset).decode(page.body) }; }
  catch { return { type, body: new TextDecoder().decode(page.body) }; }
}

const HIDDEN = new Set(['title', 'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'select']);
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul']);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', dollar: '$' };

function entity(match: string, name: string): string {
  const code = name[0] !== '#' ? NaN : name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
  if (Number.isFinite(code)) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  return ENTITIES[name.toLowerCase()] ?? match;
}

function skipPast(lower: string, marker: string, from: number): number {
  const start = lower.indexOf(marker, from);
  const end = start < 0 ? -1 : lower.indexOf('>', start);
  return end < 0 ? lower.length : end + 1;
}

function visibleText(html: string): string {
  const lower = html.toLowerCase();
  const parts: string[] = [];
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    parts.push(html.slice(index, open < 0 ? html.length : open));
    if (open < 0) break;
    if (html.startsWith('<!--', open)) { index = skipPast(lower, '-->', open + 4); continue; }
    const close = html.indexOf('>', open);
    if (close < 0) break;
    const name = /^<\/?([a-z][a-z0-9]*)/u.exec(lower.slice(open, open + 16))?.[1] ?? '';
    index = close + 1;
    if (HIDDEN.has(name) && lower[open + 1] !== '/' && html[close - 1] !== '/') index = skipPast(lower, `</${name}`, index);
    else parts.push(BLOCK.has(name) ? '\n' : ' ');
  }
  return parts.join('').replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/giu, entity);
}

export function pageText(body: string, type: string): string {
  const text = /html|xml/u.test(type) || (!type && /^\s*</u.test(body)) ? visibleText(body) : body;
  return text.split('\n').map((line) => line.replace(/\s+/gu, ' ').trim()).filter(Boolean).join('\n');
}
