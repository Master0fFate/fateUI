import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import type { GoogleAccess, GoogleClientInput, GoogleStatus } from '../../shared/contracts/google';
import { fateDataRoot } from '../pi/FateProviderStorage';

export interface SecretBox {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}
export interface GoogleRequest { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal }

export const GMAIL_READ = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';
export const CALENDAR_READ = 'https://www.googleapis.com/auth/calendar.events.readonly';
export const CALENDAR_WRITE = 'https://www.googleapis.com/auth/calendar.events';
const READ_SCOPES = [GMAIL_READ, CALENDAR_READ];
const WRITE_SCOPES = [GMAIL_SEND, CALENDAR_WRITE];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
export const GOOGLE_REQUEST_TIMEOUT_MS = 30_000;
const SETTINGS_HINT = 'Settings → Agent → Google';

const storedSchema = z.object({
  clientId: z.string().min(1).max(500),
  clientSecret: z.string().min(1).max(500),
  refreshToken: z.string().min(1).nullable(),
  scopes: z.array(z.string().max(200)).max(50),
  account: z.string().max(320).nullable(),
}).strict();
const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});
type Stored = z.infer<typeof storedSchema>;
type Token = z.infer<typeof tokenSchema>;

class GoogleGrantError extends Error {}
export class GoogleTransportError extends Error {}

const accessOf = (stored: Stored | null): GoogleAccess => !stored?.refreshToken ? 'none'
  : stored.scopes.includes(GMAIL_SEND) ? 'write' : stored.scopes.includes(GMAIL_READ) ? 'read' : 'none';
const signedOut = (stored: Stored): Stored => ({ ...stored, refreshToken: null, scopes: [], account: null });
function missingScope(scope: string): string {
  if (WRITE_SCOPES.includes(scope)) return `Sending mail and changing calendar events are not allowed yet. Choose Allow sending in ${SETTINGS_HINT}.`;
  return `Google did not grant ${scope === GMAIL_READ ? 'Gmail' : 'Calendar'} access. Reconnect in ${SETTINGS_HINT} and allow it.`;
}

export class GoogleAccount {
  readonly root: string;
  private readonly file: string;
  private stored: Promise<Stored | null> | null = null;
  private token: { value: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;
  private signIn: AbortController | null = null;

  constructor(private readonly box: SecretBox, private readonly open: (url: string) => Promise<void>, root = path.join(fateDataRoot(), 'google')) {
    this.root = root;
    this.file = path.join(root, 'account.bin');
  }

  async status(): Promise<GoogleStatus> {
    const stored = await this.load();
    return { secureStorage: this.box.available(), clientId: stored?.clientId ?? null, account: stored?.refreshToken ? stored.account : null,
      access: accessOf(stored), connecting: this.signIn !== null };
  }

  async setClient(input: GoogleClientInput): Promise<GoogleStatus> {
    if ((await this.load())?.refreshToken) throw new Error('Disconnect Google before changing the OAuth client.');
    await this.save({ ...input, refreshToken: null, scopes: [], account: null });
    return this.status();
  }

  async connect(access: 'read' | 'write'): Promise<GoogleStatus> {
    const stored = await this.load();
    if (!stored) throw new Error('Save your Google OAuth client first.');
    this.signIn?.abort();
    const signIn = new AbortController();
    this.signIn = signIn;
    try {
      const token = await this.authorize(stored, access === 'write' ? [...READ_SCOPES, ...WRITE_SCOPES] : READ_SCOPES, signIn.signal);
      const refreshToken = token.refresh_token ?? stored.refreshToken;
      if (!refreshToken) throw new Error('Google did not return a refresh token. Try connecting again.');
      const scopes = token.scope?.split(' ').filter(Boolean) ?? [];
      const account = scopes.includes(GMAIL_READ) ? await this.profile(token.access_token).catch(() => stored.account) : stored.account;
      await this.save({ ...stored, refreshToken, scopes, account });
      this.token = { value: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
    } finally {
      if (this.signIn === signIn) this.signIn = null;
    }
    return this.status();
  }

  async disconnect(): Promise<GoogleStatus> {
    this.signIn?.abort();
    const stored = await this.load();
    if (stored?.refreshToken) {
      await fetch(REVOKE_URL, { method: 'POST', body: new URLSearchParams({ token: stored.refreshToken }), signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS) }).catch(() => undefined);
      await this.save(signedOut(stored));
    }
    return this.status();
  }

  async assertScope(scope: string): Promise<void> {
    const stored = await this.load();
    if (!stored?.refreshToken) throw new Error(`Google is not connected. Connect it in ${SETTINGS_HINT}.`);
    if (!stored.scopes.includes(scope)) throw new Error(missingScope(scope));
  }

  async request(scope: string, url: string, init: GoogleRequest = {}): Promise<Response> {
    await this.assertScope(scope);
    const token = await this.accessToken();
    const timeout = AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` }, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
    } catch (error) {
      throw new GoogleTransportError(error instanceof Error ? error.message : String(error));
    }
    if (response.status === 401) this.token = null;
    return response;
  }

  private load(): Promise<Stored | null> {
    this.stored ??= fs.readFile(this.file).then(
      (data) => storedSchema.parse(JSON.parse(this.box.decrypt(data))),
      (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; },
    ).catch((error: unknown) => { this.stored = null; throw error; });
    return this.stored;
  }

  private async save(next: Stored): Promise<void> {
    if (!this.box.available()) throw new Error('Secure storage is unavailable on this system, so Fate UI cannot keep a Google sign-in.');
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(temporary, this.box.encrypt(JSON.stringify(next)), { mode: 0o600 });
    await fs.rename(temporary, this.file);
    this.stored = Promise.resolve(next);
    this.token = null;
  }

  private accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return Promise.resolve(this.token.value);
    this.refreshing ??= this.refresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const stored = await this.load();
    if (!stored?.refreshToken) throw new Error(`Google is not connected. Connect it in ${SETTINGS_HINT}.`);
    try {
      const token = await this.exchange(stored, { grant_type: 'refresh_token', refresh_token: stored.refreshToken });
      this.token = { value: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
      return token.access_token;
    } catch (error) {
      if (!(error instanceof GoogleGrantError)) throw error;
      await this.save(signedOut(stored));
      throw new Error(`The Google sign-in expired or was revoked. Reconnect in ${SETTINGS_HINT}.`);
    }
  }

  private async exchange(client: Stored, params: Record<string, string>): Promise<Token> {
    const response = await fetch(TOKEN_URL, { method: 'POST', body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...params }), signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS) });
    const body: unknown = await response.json().catch(() => null);
    const token = tokenSchema.safeParse(body);
    if (response.ok && token.success) return token.data;
    const error = body && typeof body === 'object' && 'error' in body ? String(body.error) : `HTTP ${response.status}`;
    if (error === 'invalid_grant') throw new GoogleGrantError(`Google sign-in failed: ${error}.`);
    throw new Error(`Google sign-in failed: ${error}.`);
  }

  private async profile(accessToken: string): Promise<string | null> {
    const response = await fetch(PROFILE_URL, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS) });
    const body = z.object({ emailAddress: z.string().max(320) }).safeParse(await response.json().catch(() => null));
    return response.ok && body.success ? body.data.emailAddress : null;
  }

  private async authorize(client: Stored, scopes: readonly string[], signal: AbortSignal): Promise<Token> {
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(16).toString('base64url');
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try {
      const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const stop = AbortSignal.any([signal, AbortSignal.timeout(SIGN_IN_TIMEOUT_MS)]);
      const code = new Promise<string>((resolve, reject) => {
        stop.addEventListener('abort', () => reject(new Error(signal.aborted ? 'Google sign-in was cancelled.' : 'Google sign-in timed out.')), { once: true });
        server.on('request', (request, response) => {
          const url = new URL(request.url ?? '/', redirectUri);
          if (url.pathname !== '/' || url.searchParams.get('state') !== state) { response.writeHead(404).end(); return; }
          const value = url.searchParams.get('code');
          response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(value ? 'Fate UI is connected to Google. You can close this tab.' : 'Google sign-in did not finish. You can close this tab.');
          if (value) resolve(value);
          else reject(new Error(url.searchParams.get('error') === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google sign-in failed.'));
        });
      });
      code.catch(() => undefined);
      const url = new URL(AUTH_URL);
      url.search = new URLSearchParams({
        client_id: client.clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '),
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
        state, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
      }).toString();
      await this.open(url.toString());
      return await this.exchange(client, { grant_type: 'authorization_code', code: await code, code_verifier: verifier, redirect_uri: redirectUri });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }
}
