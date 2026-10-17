import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SelectControl } from '../../components/SelectControl';
import { getDesktopApi } from '../../platform/api';
import { HOOK_TIMEOUT_DEFAULT_SECONDS, hookEvents, type HookDefinition, type HookEvent } from '../../../shared/contracts/hooks';
import { ipcErrorMessage } from '../../lib/ipcError';
import { useUiStore } from '../../stores/uiStore';

type Draft = { name: string; enabled: boolean; event: HookEvent; matcher: string; command: string; timeoutSeconds: string };

const draftFor = (hook: HookDefinition): Draft => ({
  name: hook.name, enabled: hook.enabled, event: hook.event, matcher: hook.matcher ?? '', command: hook.command, timeoutSeconds: String(hook.timeoutSeconds),
});

const EVENT_LABEL: Record<HookEvent, string> = {
  PreToolUse: 'Before tool',
  PostToolUse: 'After tool',
  Stop: 'Agent stop',
  SessionStart: 'Session start',
};

const EVENT_HINT: Record<HookEvent, string> = {
  PreToolUse: 'Exit 2 blocks the call.',
  PostToolUse: 'Exit 2 adds stderr to the result.',
  Stop: 'Exit 2 sends stderr back as a follow-up.',
  SessionStart: 'stdout becomes first-turn context.',
};

const EVENT_OPTIONS = hookEvents.map((name) => ({ value: name, label: EVENT_LABEL[name], detail: EVENT_HINT[name] }));

export function HookSettings() {
  const compact = useUiStore((state) => state.compactMode);
  const [saved, setSaved] = useState<Draft[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void getDesktopApi().getHooks().then((hooks) => {
      if (!active) return;
      const stored = hooks.map(draftFor);
      setSaved(stored);
      setDrafts(stored);
      setLoaded(true);
    }).catch((error: unknown) => { if (active) setMessage(ipcErrorMessage(error, 'Hooks could not be loaded.')); });
    return () => { active = false; };
  }, []);
  const dirty = JSON.stringify(drafts) !== JSON.stringify(saved);
  const update = (index: number, patch: Partial<Draft>) => setDrafts((current) => current.map((item, position) => position === index ? { ...item, ...patch } : item));
  const add = () => {
    setEditing(drafts.length);
    setDrafts((items) => [...items, { name: '', enabled: true, event: 'PostToolUse', matcher: '', command: '', timeoutSeconds: String(HOOK_TIMEOUT_DEFAULT_SECONDS) }]);
  };
  const remove = (index: number) => {
    setEditing(null);
    setDrafts((items) => items.filter((_, position) => position !== index));
  };
  const save = async () => {
    setSaving(true);
    try {
      const hooks: HookDefinition[] = drafts.map((draft) => {
        const timeoutSeconds = Number(draft.timeoutSeconds);
        if (!Number.isInteger(timeoutSeconds)) throw new Error('Timeout must be a whole number of seconds.');
        const matcher = draft.matcher.trim();
        return { name: draft.name.trim(), enabled: draft.enabled, event: draft.event, command: draft.command.trim(), timeoutSeconds, ...(matcher ? { matcher } : {}) };
      });
      const stored = (await getDesktopApi().setHooks(hooks)).map(draftFor);
      setSaved(stored);
      setDrafts(stored);
      setEditing(null);
      setMessage('Saved. Reopen the project to load the new hooks.');
    } catch (error) {
      setMessage(ipcErrorMessage(error, 'Hooks could not be saved.'));
    } finally { setSaving(false); }
  };
  return (
    <div className="settings-panel" role="tabpanel" id="settings-panel-hooks" aria-labelledby="settings-tab-hooks">
      <div className="settings-title">
        <div><h3>Hooks</h3><p>Shell commands on tool events for every agent. Each gets JSON on stdin and runs in the project with your account.</p></div>
        <button type="button" className="settings-providers-add" onClick={add}><Plus size={13} aria-hidden="true" /> Add hook</button>
      </div>
      {loaded && drafts.length === 0 && <p className="settings-empty">No hooks yet.</p>}
      {drafts.map((draft, index) => (
        <section className="settings-card" key={index} aria-label={`Hook ${index + 1}`}>
          <label className="settings-toggle settings-card-head">
            <div><strong>{draft.name || `Hook ${index + 1}`}</strong><small>{EVENT_LABEL[draft.event]} · {EVENT_HINT[draft.event]}</small></div>
            <input type="checkbox" aria-label={`Enable hook ${index + 1}`} checked={draft.enabled} onChange={(event) => update(index, { enabled: event.target.checked })} />
            <span aria-hidden="true" />
          </label>
          {editing === index && <div className="settings-card-grid">
            <label className="settings-input-row"><span>Name</span><input aria-label={`Hook ${index + 1} name`} value={draft.name} onChange={(event) => update(index, { name: event.target.value })} placeholder="format" /></label>
            <div className="settings-input-row"><span>Event</span><SelectControl compact={compact} label={`Hook ${index + 1} event`} value={draft.event} options={EVENT_OPTIONS} onValueChange={(event) => update(index, { event: event as HookEvent })} /></div>
            {(draft.event === 'PreToolUse' || draft.event === 'PostToolUse') && <label className="settings-input-row"><span>Tool matcher (regex)</span><input aria-label={`Hook ${index + 1} matcher`} value={draft.matcher} onChange={(event) => update(index, { matcher: event.target.value })} placeholder="^(write|edit)$" /></label>}
            <label className="settings-input-row"><span>Timeout (seconds)</span><input aria-label={`Hook ${index + 1} timeout`} inputMode="numeric" value={draft.timeoutSeconds} onChange={(event) => update(index, { timeoutSeconds: event.target.value })} /></label>
            <label className="settings-input-row settings-card-wide"><span>Command</span><input aria-label={`Hook ${index + 1} command`} value={draft.command} onChange={(event) => update(index, { command: event.target.value })} placeholder="jq -r .toolInput.path | xargs pnpm exec prettier --write" /></label>
          </div>}
          <div className="settings-card-actions">
            <button type="button" className="settings-providers-add" aria-expanded={editing === index} onClick={() => setEditing(editing === index ? null : index)}><Pencil size={12} aria-hidden="true" /> Edit</button>
            <button type="button" className="settings-providers-add" onClick={() => remove(index)}><Trash2 size={12} aria-hidden="true" /> Remove</button>
          </div>
        </section>
      ))}
      {(dirty || message) && <div className="settings-card-actions settings-card-actions--panel">
        {dirty && <button type="button" className="settings-inline-action" disabled={saving} onClick={() => void save()}>Save hooks</button>}
        {message && <span className="settings-card-status" role="status">{message}</span>}
      </div>}
    </div>
  );
}
