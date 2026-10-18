const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', times: '×', deg: '°',
};
const SKIPPED = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object', 'canvas', 'nav', 'footer', 'aside', 'head', 'select', 'button']);
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'table', 'ul', 'ol', 'blockquote', 'dl', 'dt', 'dd', 'figure', 'figcaption', 'details', 'summary', 'form', 'fieldset', 'address']);
const TAG = /<(\/?)([a-zA-Z][\w:-]*)([^<>]*)>/y;
const HREF = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] !== '#') return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return (code >= 32 && code < 0x7f) || (code > 0x9f && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)) ? String.fromCodePoint(code) : ' ';
  });
}

const collapse = (text: string) => text.replace(/\s+/g, ' ');

function linkTarget(attributes: string, base: URL): string | undefined {
  const match = HREF.exec(attributes);
  const href = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!href) return undefined;
  try {
    const url = new URL(decodeEntities(href), base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.hash && url.href.slice(0, -url.hash.length) === base.href ? undefined : url.href;
  } catch {
    return undefined;
  }
}

function normalizeLines(text: string): string {
  return text.split('\n').map((line) => line.trim()).join('\n').replace(/^-\n+/gm, '- ').replace(/\n{3,}/g, '\n\n').trim();
}

function contentRegion(html: string, lower: string): [number, number] {
  const main = lower.search(/<main[\s>]/);
  const mainEnd = lower.lastIndexOf('</main');
  if (main >= 0 && mainEnd > main) return [main, mainEnd];
  const article = lower.search(/<article[\s>]/);
  const articleEnd = lower.lastIndexOf('</article');
  if (article >= 0 && articleEnd > article && lower.indexOf('<article', article + 1) < 0) return [article, articleEnd];
  return [Math.max(lower.indexOf('<body'), 0), html.length];
}

export function htmlToMarkdown(html: string, pageUrl: string): { title: string; markdown: string } {
  const lower = html.toLowerCase();
  const titleStart = lower.indexOf('<title');
  const titleOpen = titleStart < 0 ? -1 : lower.indexOf('>', titleStart);
  const titleEnd = titleOpen < 0 ? -1 : lower.indexOf('</title', titleOpen);
  const title = titleEnd > 0 ? collapse(decodeEntities(html.slice(titleOpen + 1, titleEnd))).trim() : '';
  const base = new URL(pageUrl);
  const blocks: string[] = [];
  let parts: string[] = [];
  let link: { href: string | undefined; start: number } | null = null;
  const flush = () => {
    const text = normalizeLines(parts.join(''));
    if (text) blocks.push(text);
    parts = [];
    link = null;
  };
  const closeOf = (name: string, from: number) => {
    const close = lower.indexOf(`</${name}`, from);
    return close < 0 ? html.length : Math.max(close, lower.indexOf('>', close) + 1);
  };
  const [regionStart, regionEnd] = contentRegion(html, lower);
  let index = regionStart;
  while (index < regionEnd) {
    const next = html.indexOf('<', index);
    const textEnd = next < 0 || next > regionEnd ? regionEnd : next;
    if (textEnd > index) parts.push(collapse(decodeEntities(html.slice(index, textEnd))));
    if (textEnd === regionEnd) break;
    index = textEnd;
    if (html.startsWith('<!--', index)) {
      const end = html.indexOf('-->', index + 4);
      index = end < 0 ? regionEnd : end + 3;
      continue;
    }
    if (html[index + 1] === '!' || html[index + 1] === '?') {
      const end = html.indexOf('>', index);
      index = end < 0 ? regionEnd : end + 1;
      continue;
    }
    TAG.lastIndex = index;
    const match = TAG.exec(html);
    if (!match) {
      parts.push('<');
      index += 1;
      continue;
    }
    index = TAG.lastIndex;
    const closing = match[1] === '/';
    const name = match[2]!.toLowerCase();
    const attributes = match[3]!;
    if (!closing && SKIPPED.has(name)) {
      if (!attributes.trimEnd().endsWith('/')) index = closeOf(name, index);
      continue;
    }
    if (!closing && name === 'pre') {
      const end = lower.indexOf('</pre', index);
      const code = decodeEntities(html.slice(index, end < 0 ? regionEnd : end).replace(/<[^<>]*>/g, '')).replace(/^\n+|\s+$/g, '');
      flush();
      if (code) blocks.push(`\`\`\`\n${code}\n\`\`\``);
      index = closeOf('pre', index);
      continue;
    }
    const heading = /^h([1-6])$/.exec(name);
    if (heading) parts.push(closing ? '\n\n' : `\n\n${'#'.repeat(Number(heading[1]))} `);
    else if (name === 'a' && !closing) link = { href: linkTarget(attributes, base), start: parts.length };
    else if (name === 'a' && link) {
      const text = collapse(parts.splice(link.start).join('')).trim();
      parts.push(text && link.href ? `[${text}](${link.href})` : text);
      link = null;
    } else if (name === 'li' && !closing) parts.push('\n- ');
    else if (name === 'br' || name === 'tr') parts.push('\n');
    else if (name === 'hr') parts.push('\n\n---\n\n');
    else if ((name === 'td' || name === 'th') && !closing) parts.push(' | ');
    else if (name === 'code') parts.push('`');
    else if (BLOCKS.has(name)) parts.push('\n\n');
  }
  flush();
  return { title, markdown: blocks.join('\n\n') };
}
