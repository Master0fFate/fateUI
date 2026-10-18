import { useEffect, useRef, useState } from 'react';
import type { GoogleStatus } from '../../../shared/contracts/google';
import { ipcErrorMessage } from '../../lib/ipcError';
import { getDesktopApi } from '../../platform/api';

const REMOTE_PREFIX = /^Error invoking remote method '[^']+': (?:Error: )?/u;
const failure = (error: unknown) => ipcErrorMessage(error instanceof Error ? new Error(error.message.replace(REMOTE_PREFIX, '')) : error, 'Google could not be reached.');
const connectionFact = (status: GoogleStatus | null, waiting: boolean) => {
  if (waiting) return 'Waiting for Google…';
  if (!status) return 'Loading…';
  if (status.access === 'none') return 'Not connected';
  return status.account ? `${status.account} · ${status.access === 'write' ? 'can send' : 'read only'}` : 'Connected';
};

export function GoogleSettings() {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState<'connect' | 'other' | null>(null);
  const [message, setMessage] = useState('');
  const apply = (next: GoogleStatus) => { setStatus(next); setClientId(next.clientId ?? ''); setClientSecret(''); };
  useEffect(() => {
    let active = true;
    void getDesktopApi().getGoogleStatus().then((next) => { if (active) apply(next); })
      .catch((error: unknown) => { if (active) setMessage(failure(error)); });
    return () => { active = false; };
  }, []);
  const attempt = useRef(0);
  const run = async (kind: 'connect' | 'other', action: () => Promise<GoogleStatus>) => {
    const current = ++attempt.current;
    setBusy(kind);
    setMessage('');
    try { const next = await action(); if (current === attempt.current) apply(next); }
    catch (error) { if (current === attempt.current) setMessage(failure(error)); }
    finally { if (current === attempt.current) setBusy(null); }
  };
  const waiting = busy === 'connect' || status?.connecting === true;
  const pending = busy !== null || waiting;
  const storageReady = status?.secureStorage === true;
  const connected = status !== null && status.access !== 'none';
  const locked = busy === 'other' || !storageReady;
  const showSave = status !== null && !connected && clientId.trim() !== '' && clientSecret.trim() !== '';
  const showConnect = status !== null && !connected && status.clientId !== null;
  const showAllow = status?.access === 'read';
  const notice = message || (status && !status.secureStorage ? 'Secure storage is unavailable on this PC.' : '');
  return <>
    <div className="settings-title settings-title--spaced"><div><h3>Google</h3><p>Lets Agents read Gmail and Calendar. Sending mail and calendar changes ask you first.</p></div></div>
    <details className="workspace-preference-details"><summary>Setup steps</summary>
      <p>In Google Cloud Console, create a project and enable the Gmail API and Google Calendar API. On the OAuth consent screen, add yourself as a test user, then publish the app to In production; in Testing, Google ends the sign-in every 7 days.</p>
      <p>Create an OAuth client of type Desktop app and paste its ID and secret here. Fate UI keeps the secret and sign-in encrypted on this PC. Agents read mail only when their Google toggle is on.</p>
    </details>
    <section className="settings-card" aria-label="Google account">
      <div className="settings-toggle settings-card-head"><div><strong>Google account</strong><small>{connectionFact(status, waiting)}</small></div></div>
      {status && !connected && <div className="settings-card-grid">
        <label className="settings-input-row"><span>Client ID</span><input aria-label="Google client ID" value={clientId} disabled={pending} onChange={(event) => setClientId(event.target.value)} /></label>
        <label className="settings-input-row"><span>Client secret</span><input type="password" aria-label="Google client secret" value={clientSecret} disabled={pending} onChange={(event) => setClientSecret(event.target.value)} /></label>
      </div>}
      {(showSave || showConnect || showAllow || connected || notice) && <div className="settings-card-actions">
        {showSave && <button type="button" className="settings-inline-action" disabled={locked || waiting} onClick={() => void run('other', () => getDesktopApi().setGoogleClient({ clientId, clientSecret }))}>Save client</button>}
        {showConnect && <button type="button" className="settings-inline-action" disabled={locked} onClick={() => void run('connect', () => getDesktopApi().connectGoogle({ access: 'read' }))}>Connect</button>}
        {showAllow && <button type="button" className="settings-inline-action" disabled={locked} onClick={() => void run('connect', () => getDesktopApi().connectGoogle({ access: 'write' }))}>Allow sending</button>}
        {notice && <span className="settings-card-status" role="status">{notice}</span>}
        {connected && <button type="button" className="settings-providers-add" disabled={pending} onClick={() => void run('other', () => getDesktopApi().disconnectGoogle())}>Disconnect</button>}
      </div>}
    </section>
  </>;
}
