import { lookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { pipeline, type Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const PRIVATE = 'Watches only fetch public addresses.';
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) blockedV4.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::', 3], ['4000::', 2], ['8000::', 1], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16]] as const) blockedV6.addSubnet(network, prefix, 'ipv6');
const isPublic = (address: string, family: number) => family === 6 ? !blockedV6.check(address, 'ipv6') : !blockedV4.check(address, 'ipv4');

const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, '');
    if (!addresses.length || addresses.some((entry) => !isPublic(entry.address, entry.family))) return callback(Object.assign(new Error(PRIVATE), { code: 'EACCES' }), '');
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

export function watchedUrl(address: string): URL {
  const url = new URL(address);
  if (!['http:', 'https:'].includes(url.protocol) || url.port !== '' || url.username || url.password) throw new Error('Watches only fetch http or https pages on ports 80 and 443.');
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  const family = isIP(host);
  if (family && !isPublic(host, family)) throw new Error(PRIVATE);
  return url;
}

function get(url: URL, signal: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    (url.protocol === 'https:' ? https : http).get(url, {
      agent: false, lookup: publicLookup, signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; FateUI-Watch)', accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'accept-encoding': 'gzip, deflate, br' },
    }, resolve).on('error', reject);
  });
}

function decoded(response: http.IncomingMessage): Readable {
  const encoding = String(response.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  if (encoding === 'identity' || encoding === '') return response;
  const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
  if (!decoder) throw new Error(`The page uses an unsupported encoding (${encoding}).`);
  return pipeline(response, decoder, () => undefined);
}

async function readText(response: http.IncomingMessage, type: string): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of decoded(response) as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('The page is larger than 2 MB.');
    chunks.push(chunk);
  }
  const charset = /charset="?([\w-]+)/iu.exec(type)?.[1] ?? 'utf-8';
  try { return new TextDecoder(charset).decode(Buffer.concat(chunks)); }
  catch { return new TextDecoder().decode(Buffer.concat(chunks)); }
}

export async function fetchWatchedPage(address: string, signal: AbortSignal): Promise<{ type: string; body: string }> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
  let url = watchedUrl(address);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await get(url, deadline);
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        response.destroy();
        url = watchedUrl(new URL(location, url).href);
        continue;
      }
      const type = String(response.headers['content-type'] ?? '').toLowerCase();
      if (status < 200 || status >= 300 || (type && !/^(text\/|application\/([\w.+-]+\+)?(json|xml)\b)/u.test(type))) {
        response.destroy();
        throw new Error(status < 200 || status >= 300 ? `The page answered HTTP ${status}.` : `The page is not text (${type.split(';')[0]}).`);
      }
      return { type, body: await readText(response, type) };
    }
    throw new Error('The page redirected too many times.');
  } catch (error) {
    if (deadline.aborted && !signal.aborted) throw new Error(`The page did not answer within ${TIMEOUT_MS / 1000} seconds.`);
    throw error;
  }
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
