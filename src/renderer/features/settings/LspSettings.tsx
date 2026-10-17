import { Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getDesktopApi } from '../../platform/api';
import { defaultLspServers, type LspServerDefinition } from '../../../shared/contracts/lsp';
import { ipcErrorMessage } from '../../lib/ipcError';

type Draft = { name: string; enabled: boolean; extensions: string; command: string; args: string };

const draftFor = (server: LspServerDefinition): Draft => ({
  name: server.name, enabled: server.enabled, extensions: server.extensions.join(', '), command: server.command, args: JSON.stringify(server.args),
});

const serverFor = (draft: Draft): LspServerDefinition => {
  const args: unknown = JSON.parse(draft.args || '[]');
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) throw new Error('Arguments must be a JSON array of strings.');
  return { name: draft.name.trim(), enabled: draft.enabled, extensions: draft.extensions.split(',').map((item) => item.trim()).filter(Boolean), command: draft.command.trim(), args };
};

export function LspSettings() {
  const [saved, setSaved] = useState<Draft[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void getDesktopApi().getLspServers().then((servers) => {
      if (!active) return;
      const stored = servers.map(draftFor);
      setSaved(stored);
      setDrafts(stored);
    }).catch((error: unknown) => { if (active) setMessage(ipcErrorMessage(error, 'Language servers could not be loaded.')); });
    return () => { active = false; };
  }, []);
  const dirty = JSON.stringify(drafts) !== JSON.stringify(saved);
  const update = (index: number, patch: Partial<Draft>) => setDrafts((current) => current.map((item, position) => position === index ? { ...item, ...patch } : item));
  const add = () => {
    setEditing(drafts.length);
    setDrafts((items) => [...items, { name: '', enabled: true, extensions: '', command: '', args: '[]' }]);
  };
  const remove = (index: number) => {
    setEditing(null);
    setDrafts((items) => items.filter((_, position) => position !== index));
  };
  const toggle = async (index: number, enabled: boolean) => {
    update(index, { enabled });
    const position = saved.findIndex((item) => item.name === drafts[index]?.name);
    if (position < 0) return;
    try {
      const servers = saved.map((item, current) => serverFor(current === position ? { ...item, enabled } : item));
      setSaved((await getDesktopApi().setLspServers(servers)).map(draftFor));
      setMessage('Saved. Reopen the project to use the new server list.');
    } catch (error) {
      setMessage(ipcErrorMessage(error, 'Language servers could not be saved.'));
    }
  };
  const save = async () => {
    setSaving(true);
    try {
      const stored = (await getDesktopApi().setLspServers(drafts.map(serverFor))).map(draftFor);
      setSaved(stored);
      setDrafts(stored);
      setEditing(null);
      setMessage('Saved. Reopen the project to use the new server list.');
    } catch (error) {
      setMessage(ipcErrorMessage(error, 'Language servers could not be saved.'));
    } finally { setSaving(false); }
  };
  return (
    <div className="settings-panel" role="tabpanel" id="settings-panel-code" aria-labelledby="settings-tab-code">
      <div className="settings-title">
        <div><h3>Code Intelligence</h3><p>Language servers give the agent diagnostics and symbols and check every write. Each starts on first use from PATH or node_modules/.bin.</p></div>
        <button type="button" className="settings-providers-add" onClick={add}><Plus size={13} aria-hidden="true" /> Add server</button>
      </div>
      {drafts.map((draft, index) => (
        <section className="settings-card" key={index} aria-label={`Language server ${index + 1}`}>
          <label className="settings-toggle settings-card-head">
            <div><strong>{draft.name || `Server ${index + 1}`}</strong><small>{draft.extensions || 'No extensions'}</small></div>
            <input type="checkbox" aria-label={`Enable language server ${index + 1}`} checked={draft.enabled} onChange={(event) => void toggle(index, event.target.checked)} />
            <span aria-hidden="true" />
          </label>
          {editing === index && <div className="settings-card-grid">
            <label className="settings-input-row"><span>Name</span><input aria-label={`Language server ${index + 1} name`} value={draft.name} onChange={(event) => update(index, { name: event.target.value })} placeholder="typescript" /></label>
            <label className="settings-input-row"><span>File extensions</span><input aria-label={`Language server ${index + 1} extensions`} value={draft.extensions} onChange={(event) => update(index, { extensions: event.target.value })} placeholder=".ts, .tsx" /></label>
            <label className="settings-input-row"><span>Command</span><input aria-label={`Language server ${index + 1} command`} value={draft.command} onChange={(event) => update(index, { command: event.target.value })} placeholder="typescript-language-server" /></label>
            <label className="settings-input-row"><span>Arguments (JSON array)</span><input aria-label={`Language server ${index + 1} arguments`} value={draft.args} onChange={(event) => update(index, { args: event.target.value })} placeholder='["--stdio"]' /></label>
          </div>}
          <div className="settings-card-actions">
            <button type="button" className="settings-providers-add" aria-expanded={editing === index} onClick={() => setEditing(editing === index ? null : index)}><Pencil size={12} aria-hidden="true" /> Edit</button>
            <button type="button" className="settings-providers-add" onClick={() => remove(index)}><Trash2 size={12} aria-hidden="true" /> Remove</button>
          </div>
        </section>
      ))}
      <div className="settings-card-actions settings-card-actions--panel">
        {dirty && <button type="button" className="settings-inline-action" disabled={saving} onClick={() => void save()}>Save servers</button>}
        <button type="button" className="settings-providers-add" onClick={() => { setEditing(null); setDrafts(defaultLspServers.map(draftFor)); }}><RotateCcw size={12} aria-hidden="true" /> Defaults</button>
        {message && <span className="settings-card-status" role="status">{message}</span>}
      </div>
    </div>
  );
}
