import { Plus, Trash2 } from 'lucide-react';
import { getDesktopApi } from '../../platform/api';
import { useEffect, useState } from 'react';
import type { McpServerDefinition, PiMigrationReport } from '../../../shared/contracts/ipc';
import { SelectControl } from '../../components/SelectControl';
import { ipcErrorMessage } from '../../lib/ipcError';
import { useUiStore } from '../../stores/uiStore';

type Draft = { name: string; enabled: boolean; transport: 'stdio' | 'http'; command: string; args: string; url: string };
const draftFor = (server: McpServerDefinition): Draft => ({
  name: server.name, enabled: server.enabled, transport: server.transport,
  command: server.transport === 'stdio' ? server.command : '',
  args: server.transport === 'stdio' ? JSON.stringify(server.args) : '[]',
  url: server.transport === 'http' ? server.url : '',
});
const TRANSPORT_OPTIONS = [{ value: 'stdio', label: 'Local command' }, { value: 'http', label: 'HTTPS endpoint' }];
const BRIDGE_WARNING = /^(.+?) needs its Pi MCP bridge or manual setup; /u;
/** Collapse one-per-server bridge notices into one line so a large Pi config cannot flood the panel. */
function groupWarnings(warnings: readonly string[]): { bridgeOnly: string[]; other: string[] } {
  const bridgeOnly: string[] = [];
  const other: string[] = [];
  for (const warning of warnings) {
    const match = BRIDGE_WARNING.exec(warning);
    if (match?.[1]) bridgeOnly.push(match[1]); else other.push(warning);
  }
  return { bridgeOnly, other };
}

export function McpSettings() {
  const compact = useUiStore((state) => state.compactMode);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [message, setMessage] = useState('Loading MCP servers…');
  const [saving, setSaving] = useState(false);
  const [savedNames, setSavedNames] = useState<string[]>([]);
  const [migration, setMigration] = useState<PiMigrationReport | null>(null);
  const [migrationMessage, setMigrationMessage] = useState('');
  const [migrating, setMigrating] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    let active = true;
    void getDesktopApi().getMcpServers().then((servers) => {
      if (!active) return;
      setDrafts(servers.map(draftFor));
      setSavedNames(servers.filter((server) => server.enabled).map((server) => server.name));
      setMessage(servers.length ? '' : 'No servers configured.');
    }).catch((error: unknown) => { if (active) setMessage(ipcErrorMessage(error, 'MCP settings could not be loaded.')); });
    void getDesktopApi().inspectPiMigration().then((report) => { if (active) setMigration(report); })
      .catch((error: unknown) => { if (active) setMigrationMessage(ipcErrorMessage(error, 'Pi migration could not be inspected.')); });
    return () => { active = false; };
  }, []);
  const update = (index: number, patch: Partial<Draft>) => { setDirty(true); setDrafts((current) => current.map((item, position) => position === index ? { ...item, ...patch } : item)); };
  const save = async () => {
    setSaving(true);
    try {
      const servers: McpServerDefinition[] = drafts.map((draft) => {
        if (draft.transport === 'http') return { name: draft.name.trim(), enabled: draft.enabled, transport: 'http', url: draft.url.trim() };
        const args: unknown = JSON.parse(draft.args);
        if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) throw new Error('Arguments must be a JSON array of strings.');
        return { name: draft.name.trim(), enabled: draft.enabled, transport: 'stdio', command: draft.command.trim(), args };
      });
      const saved = await getDesktopApi().setMcpServers(servers);
      setDrafts(saved.map(draftFor));
      setSavedNames(saved.filter((server) => server.enabled).map((server) => server.name));
      setDirty(false);
      setMessage('Saved. Reopen this project to load the new server list.');
    } catch (error) {
      setMessage(ipcErrorMessage(error, 'MCP settings could not be saved.'));
    } finally { setSaving(false); }
  };
  const probe = async (name: string) => {
    setMessage(`Connecting to ${name}…`);
    try {
      const result = await getDesktopApi().testMcpServer(name);
      setMessage(`${name} connected: ${result.tools.length} tools available${result.tools.length ? ` (${result.tools.slice(0, 5).join(', ')})` : ''}.`);
    } catch (error) { setMessage(ipcErrorMessage(error, `${name} could not connect.`)); }
  };
  const importPi = async () => {
    if (dirty || migrating) return;
    setMigrating(true);
    try {
      const result = await getDesktopApi().importPiMigration();
      setMigrationMessage(`Imported ${result.providerEntriesImported} provider entries and ${result.mcpServersImported} MCP servers. Restart Fate UI to reload providers; reopen the project to load MCP tools.${result.providerConflicts || result.mcpServersSkipped ? ` ${result.providerConflicts} provider conflicts and ${result.mcpServersSkipped} MCP servers still need review.` : ''}`);
      const [report, servers] = await Promise.all([getDesktopApi().inspectPiMigration(), getDesktopApi().getMcpServers()]);
      setMigration(report);
      setDrafts(servers.map(draftFor));
      setSavedNames(servers.filter((server) => server.enabled).map((server) => server.name));
    } catch (error) { setMigrationMessage(`${ipcErrorMessage(error, 'Pi migration stopped.')} Reopen this panel to check for any partial changes before retrying.`); }
    finally { setMigrating(false); }
  };
  const importable = migration ? migration.providerEntriesToImport > 0 || (migration.mcpServersToImport > 0 && !migration.bridgeConfigured) : false;
  const bridgeServers = migration?.bridgeConfigured ? migration.piMcpServers : [];
  const warnings = groupWarnings(migration?.warnings ?? []);
  const showBridgeNote = warnings.bridgeOnly.length > 0 && bridgeServers.length === 0;
  const warningCount = warnings.other.length + (showBridgeNote ? 1 : 0);
  const addServer = () => { setDirty(true); setDrafts((items) => [...items, { name: '', enabled: false, transport: 'stdio', command: '', args: '[]', url: '' }]); };
  return (
    <div className="settings-panel" role="tabpanel" id="settings-panel-mcp" aria-labelledby="settings-tab-mcp">
      <div className="settings-title">
        <div><h3>MCP servers</h3><p>Full access sessions only. Add servers you trust; keep secrets out of URLs and arguments.</p></div>
        <button type="button" className="settings-providers-add" onClick={addServer}><Plus size={13} aria-hidden="true" /> Add server</button>
      </div>
      <details className="workspace-preference-details"><summary>How it works</summary><p>Local servers run commands as you; remote servers receive tool inputs. Global Pi MCP bridge extensions keep their own settings; no copy is needed. Project files cannot add servers to Fate's bridge, but a separate Pi extension may read project config. OAuth is not supported yet.</p></details>
      {drafts.length === 0 && message === 'No servers configured.' && <div className="settings-empty-card"><strong>{bridgeServers.length ? 'No Fate servers.' : 'No servers configured.'}</strong><span>{bridgeServers.length ? 'Your Pi bridge servers are below. Add a server here only if it is not in Pi.' : 'Add a local command or an HTTPS endpoint.'}</span></div>}
      {bridgeServers.length > 0 && <section className="settings-card" aria-label="Pi MCP bridge servers">
        <div className="settings-toggle settings-card-head"><div><strong>Pi MCP bridge</strong><small>{bridgeServers.length} {bridgeServers.length === 1 ? 'server' : 'servers'} · read-only · edit in Pi's mcp.json</small></div></div>
        <ul className="settings-bridge-list">
          {bridgeServers.map((server) => <li key={server.name} data-off={server.enabled ? undefined : ''}>
            <strong>{server.name}</strong><code>{server.target}</code>{!server.enabled && <span>off</span>}
          </li>)}
        </ul>
      </section>}
      {drafts.map((draft, index) => (
        <section className="settings-card" key={index} aria-label={`MCP server ${index + 1}`}>
          <label className="settings-toggle settings-card-head">
            <div><strong>{draft.name || `Server ${index + 1}`}</strong><small>{draft.transport === 'http' ? draft.url || 'HTTPS endpoint' : draft.command || 'Local command'}</small></div>
            <input type="checkbox" aria-label={`Enable MCP server ${index + 1}`} checked={draft.enabled} onChange={(event) => update(index, { enabled: event.target.checked })} />
            <span aria-hidden="true" />
          </label>
          <div className="settings-card-grid">
            <label className="settings-input-row"><span>Server name</span><input aria-label={`MCP server ${index + 1} name`} value={draft.name} onChange={(event) => update(index, { name: event.target.value })} placeholder="docs" /></label>
            <div className="settings-input-row"><span>Connection</span><SelectControl compact={compact} label={`MCP server ${index + 1} connection`} value={draft.transport} options={TRANSPORT_OPTIONS} onValueChange={(transport) => update(index, { transport: transport as Draft['transport'] })} /></div>
            {draft.transport === 'stdio' ? <>
              <label className="settings-input-row"><span>Command</span><input aria-label={`MCP server ${index + 1} command`} value={draft.command} onChange={(event) => update(index, { command: event.target.value })} placeholder="npx" /></label>
              <label className="settings-input-row"><span>Arguments (JSON array)</span><input aria-label={`MCP server ${index + 1} arguments`} value={draft.args} onChange={(event) => update(index, { args: event.target.value })} placeholder={'["-y", "server-package@1.0.0"]'} /></label>
            </> : <label className="settings-input-row settings-card-wide"><span>URL</span><input aria-label={`MCP server ${index + 1} URL`} value={draft.url} onChange={(event) => update(index, { url: event.target.value })} placeholder="https://example.com/mcp" /></label>}
          </div>
          <div className="settings-card-actions">
            {draft.enabled && savedNames.includes(draft.name) && <button type="button" className="settings-inline-action" onClick={() => void probe(draft.name)}>Test saved server</button>}
            <button type="button" className="settings-providers-add" onClick={() => { setDirty(true); setDrafts((items) => items.filter((_, position) => position !== index)); }}><Trash2 size={12} aria-hidden="true" /> Remove</button>
          </div>
        </section>
      ))}
      {(dirty || (message && message !== 'No servers configured.')) && <div className="settings-card-actions settings-card-actions--panel">
        {dirty && <button type="button" className="settings-inline-action" disabled={saving} onClick={() => void save()}>Save MCP servers</button>}
        {message && message !== 'No servers configured.' && <span className="settings-card-status" role="status">{message}</span>}
      </div>}
      {(migration || migrationMessage) && <section className="settings-card settings-import-card" aria-label="Import from Pi">
        <div className="settings-toggle settings-card-head">
          <div><strong>Import from Pi</strong><small>{migration?.piProfileFound ? 'Settings, sessions, skills and extensions are already shared.' : 'No Pi profile found.'}</small></div>
          {importable && <button type="button" className="settings-inline-action" disabled={migrating || dirty} title={dirty ? 'Save or discard your MCP edits before import.' : undefined} aria-label="Import missing Pi providers and MCP servers" onClick={() => void importPi()}>{migrating ? 'Importing…' : 'Import'}</button>}
        </div>
        {migration?.piProfileFound && <ul className="settings-import-facts">
          <li>{migration.bridgeConfigured ? 'Pi MCP bridge active' : `${migration.mcpServersToImport} MCP servers importable`}</li>
          <li>{migration.providerEntriesToImport} provider entries importable</li>
          {migration.providerConflicts > 0 && <li data-tone="warn" title="Fate keeps its own values.">{migration.providerConflicts} provider values differ</li>}
        </ul>}
        {warningCount > 0 && <details className="workspace-preference-details"><summary>{warningCount} {warningCount === 1 ? 'note' : 'notes'}</summary>
          <ul className="settings-import-warnings">
            {showBridgeNote && <li>Kept on the Pi MCP bridge (options Fate cannot copy): <code>{warnings.bridgeOnly.join(', ')}</code></li>}
            {warnings.other.map((warning, index) => <li key={index}>{warning}</li>)}
          </ul>
        </details>}
        {migrationMessage && <p className="settings-card-status settings-card-actions" role="status">{migrationMessage}</p>}
      </section>}
    </div>
  );
}
