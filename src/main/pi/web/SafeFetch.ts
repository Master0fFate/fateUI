import { lookup } from 'node:dns';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { pipeline, type Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

const SAFE_FETCH_MAX_BYTES = 2 * 1024 * 1024;
const SAFE_FETCH_TIMEOUT_MS = 20_000;
const SAFE_FETCH_MAX_REDIRECTS = 5;
const USER_AGENT = 'Mozilla/5.0 (compatible; fateUI web_fetch; +https://github.com/Master0fFate/pi-fategui)';

export interface SafeFetchOptions {
  accept?: string;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface SafeFetchResult {
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
  truncated: boolean;
}

const reserved = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) reserved.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16]] as const) reserved.addSubnet(address, prefix, 'ipv6');
const globalUnicast = new BlockList();
globalUnicast.addSubnet('2000::', 3, 'ipv6');

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !reserved.check(address, 'ipv4');
  return family === 6 && globalUnicast.check(address, 'ipv6') && !reserved.check(address, 'ipv6');
}

const refusedHost = (hostname: string) => new Error(`${hostname} is not a public internet address.`);

const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, []);
    if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) return callback(refusedHost(hostname), []);
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

function publicUrl(href: string): URL {
  let url: URL;
  try { url = new URL(href); } catch { throw new Error(`${href.slice(0, 200)} is not a valid URL.`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https URLs can be fetched.');
  if (url.username || url.password) throw new Error('URLs with embedded credentials are refused.');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (port !== '80' && port !== '443') throw new Error('Only ports 80 and 443 can be fetched.');
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (isIP(host) && !isPublicAddress(host)) throw refusedHost(url.hostname);
  url.hash = '';
  return url;
}

function requestOnce(url: URL, accept: string, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      headers: { accept, 'accept-encoding': 'gzip, deflate, br', 'user-agent': USER_AGENT },
      agent: false,
      lookup: publicLookup,
      signal,
    }, resolve);
    request.on('error', reject);
    request.end();
  });
}

function decodedBody(response: IncomingMessage): Readable {
  const encoding = String(response.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  if (encoding === 'identity' || encoding === '') return response;
  const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
  if (!decoder) {
    response.destroy();
    throw new Error(`Unsupported content encoding ${encoding}.`);
  }
  return pipeline(response, decoder, () => {});
}

async function readCapped(response: IncomingMessage, maxBytes: number): Promise<{ body: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  try {
    for await (const chunk of decodedBody(response) as AsyncIterable<Buffer>) {
      const room = maxBytes - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        size = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(chunk);
      size += chunk.length;
    }
  } finally {
    response.destroy();
  }
  return { body: Buffer.concat(chunks, size), truncated };
}

export async function safeFetch(href: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const { accept = '*/*', maxBytes = SAFE_FETCH_MAX_BYTES, timeoutMs = SAFE_FETCH_TIMEOUT_MS, maxRedirects = SAFE_FETCH_MAX_REDIRECTS } = options;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let url = publicUrl(href);
  try {
    for (let redirects = 0; ; redirects++) {
      const response = await requestOnce(url, accept, signal);
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.destroy();
        if (redirects >= maxRedirects) throw new Error(`Stopped after ${maxRedirects} redirects.`);
        url = publicUrl(new URL(location, url).href);
        continue;
      }
      const { body, truncated } = await readCapped(response, maxBytes);
      return { url: url.href, status, contentType: response.headers['content-type'] ?? '', body, truncated };
    }
  } catch (error) {
    if (deadline.aborted) throw new Error(`Fetching ${url.href} timed out after ${timeoutMs / 1000} seconds.`);
    throw error;
  }
}
