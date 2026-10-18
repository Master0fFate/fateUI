import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { agentDraftSchema, routineDraftSchema, type AgentDefinition, type AgentDraft, type AgentPermission, type RoutineDefinition, type RoutineDraft } from '../../../shared/contracts/agents';
import type { ModelInfo } from '../../../shared/contracts/ipc';
import { SelectControl } from '../../components/SelectControl';
import { getDesktopApi } from '../../platform/api';
import { agentDraft, agentError, agentLabel, routineDraft, useAgentsStore } from '../../stores/agentsStore';
import { useRuntimeStore } from '../../stores/runtimeStore';

const permissionOptions: { value: AgentPermission; label: string }[] = [
  { value: 'read-only', label: 'Read only' }, { value: 'edit', label: 'Edit files' }, { value: 'full-access', label: 'Full access' },
];
const thinkingOptions = agentDraftSchema.shape.defaults.shape.thinkingLevel.options.map((level) => ({ value: level, label: level }));
const newAgent = (): AgentDraft => ({ name: '', description: '', instructions: '', skillRefs: [], enabled: true, tone: '', avatar: '', defaults: { model: null, thinkingLevel: 'high', permission: 'edit', workspace: 'shared' } });
const newRoutine = (agentId: string, count: number): RoutineDraft => ({ name: `Routine ${count + 1}`, agentId, message: '', intervalMinutes: 60,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, enabled: false, notify: true, osNotify: false });

function useSave() {
  const [status, setStatus] = useState<string | null>(null);
  const run = (operation: () => Promise<unknown>, done?: () => void) => {
    setStatus(null);
    void useAgentsStore.getState().mutate(operation).then(() => { setStatus('Saved.'); done?.(); }, (error: unknown) => setStatus(agentError(error)));
  };
  return { status, run };
}

function RoutineEditor({ routine, agentId, count, compact, onDone }: { routine?: RoutineDefinition; agentId: string; count: number; compact: boolean; onDone?: () => void }) {
  const library = useAgentsStore((state) => state.library);
  const busy = useAgentsStore((state) => state.busy);
  const [initial] = useState(() => routine ? routineDraft(routine) : newRoutine(agentId, count));
  const [draft, setDraft] = useState(initial);
  const [confirming, setConfirming] = useState(false);
  const { status, run } = useSave();
  const dirty = !routine || JSON.stringify(draft) !== JSON.stringify(initial);
  const nextDue = routine && draft.enabled ? library.nextDue[routine.id] : null;
  const patch = (values: Partial<RoutineDraft>) => setDraft((current) => ({ ...current, ...values }));
  const save = () => {
    const parsed = routineDraftSchema.safeParse(draft);
    if (!parsed.success) { run(() => Promise.reject(new Error(parsed.error.issues[0]?.message ?? 'Check the Routine.'))); return; }
    run(() => getDesktopApi().saveRoutineDefinition({ ...(routine ? { id: routine.id } : {}), expected: routine ? library.revisions[`routine:${routine.id}`]! : null, value: parsed.data }), onDone);
  };
  const remove = () => routine && run(() => getDesktopApi().deleteAgentLibraryItem({ kind: 'routine', id: routine.id, expected: library.revisions[`routine:${routine.id}`]! }));
  return <div className="settings-card-grid" aria-label={`Routine ${draft.name}`}>
    <label className="settings-input-row"><span>Routine</span><input aria-label="Routine name" maxLength={80} value={draft.name} disabled={busy} onChange={(event) => patch({ name: event.target.value })} /></label>
    <label className="settings-input-row"><span>Every (minutes)</span><input aria-label="Routine interval in minutes" type="number" min={1} max={10_080} value={draft.intervalMinutes} disabled={busy} onChange={(event) => patch({ intervalMinutes: Number(event.target.value) })} /></label>
    <label className="settings-input-row settings-card-wide"><span>Message</span><textarea aria-label="Routine message" rows={compact ? 2 : 3} maxLength={200_000} value={draft.message} disabled={busy} onChange={(event) => patch({ message: event.target.value })} /></label>
    <label className="settings-toggle settings-card-wide">
      <div><strong>Routine on</strong><small>{nextDue ? `Next ${new Date(nextDue).toLocaleString()}` : 'Runs while Fate UI is open'}</small></div>
      <input type="checkbox" aria-label={`Routine ${draft.name} on`} checked={draft.enabled} disabled={busy} onChange={(event) => patch({ enabled: event.target.checked })} />
      <span aria-hidden="true" />
    </label>
    <div className="settings-card-actions settings-card-wide">
      {dirty && <button type="button" className="settings-inline-action" disabled={busy} onClick={save}>Save routine</button>}
      {!routine && <button type="button" className="settings-inline-action" disabled={busy} onClick={onDone}>Cancel</button>}
      {status && <span className="settings-card-status" role="status">{status}</span>}
      {routine && <button type="button" className="settings-providers-add" disabled={busy} onClick={() => { if (confirming) remove(); else setConfirming(true); }}><Trash2 size={12} aria-hidden="true" /> {confirming ? 'Confirm delete' : 'Delete routine'}</button>}
    </div>
  </div>;
}

function AgentCard({ agent, models, compact }: { agent?: AgentDefinition; models: readonly ModelInfo[]; compact: boolean }) {
  const library = useAgentsStore((state) => state.library);
  const legacy = useAgentsStore((state) => state.legacy);
  const busy = useAgentsStore((state) => state.busy);
  const [initial] = useState(() => agent ? agentDraft(agent) : newAgent());
  const [draft, setDraft] = useState(initial);
  const [skills, setSkills] = useState(initial.skillRefs.join(', '));
  const [addingRoutine, setAddingRoutine] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { status, run } = useSave();
  const routines = agent ? library.routines.filter((routine) => routine.agentId === agent.id) : [];
  const copyable = legacy.filter((item) => !item.existingRoutineId && !item.error);
  const dirty = !agent || JSON.stringify(draft) !== JSON.stringify(initial);
  const patch = (values: Partial<AgentDraft>) => setDraft((current) => ({ ...current, ...values }));
  const model = draft.defaults.model;
  const modelOptions = [{ value: 'current', label: 'Current model' }, ...models.map((item) => ({ value: JSON.stringify({ provider: item.provider, id: item.id }), label: item.name, detail: item.provider })),
    ...(model && !models.some((item) => item.provider === model.provider && item.id === model.id) ? [{ value: JSON.stringify(model), label: 'Unavailable model', detail: `${model.provider}/${model.id}` }] : [])];
  const save = () => {
    const parsed = agentDraftSchema.safeParse(draft);
    if (!parsed.success) { run(() => Promise.reject(new Error(parsed.error.issues[0]?.message ?? 'Check the agent.'))); return; }
    run(() => getDesktopApi().saveAgentDefinition({ ...(agent ? { id: agent.id } : {}), expected: agent ? library.revisions[`agent:${agent.id}`]! : null, value: parsed.data }),
      agent ? undefined : () => useAgentsStore.setState({ editing: null }));
  };
  const remove = () => agent && run(() => getDesktopApi().deleteAgentLibraryItem({ kind: 'agent', id: agent.id, expected: library.revisions[`agent:${agent.id}`]! }));
  const copy = (sourceId: string) => {
    const item = copyable.find((candidate) => candidate.sourceId === sourceId);
    if (agent && item) run(() => getDesktopApi().copyAutomationToRoutine({ automationId: item.sourceId, sourceDigest: item.sourceDigest, agentId: agent.id }).then(() => useAgentsStore.getState().loadLegacy()));
  };
  return <section className="settings-card" id={`saved-agent-${agent?.id ?? 'new'}`} aria-label={`Agent ${draft.name || 'new'}`}>
    <label className="settings-toggle settings-card-head">
      <div><strong>{agentLabel({ name: draft.name || 'New agent', avatar: draft.avatar })}</strong><small>{permissionOptions.find((option) => option.value === draft.defaults.permission)?.label} · {model ? model.id : 'current model'}</small></div>
      <input type="checkbox" aria-label={`${draft.name || 'New agent'} on`} checked={draft.enabled} disabled={busy} onChange={(event) => patch({ enabled: event.target.checked })} />
      <span aria-hidden="true" />
    </label>
    <div className="settings-card-grid">
      <label className="settings-input-row"><span>Name</span><input aria-label="Agent name" maxLength={80} value={draft.name} disabled={busy} autoFocus={!agent} onChange={(event) => patch({ name: event.target.value })} /></label>
      <label className="settings-input-row"><span>Avatar</span><input aria-label="Agent avatar" placeholder="Emoji" maxLength={16} value={draft.avatar ?? ''} disabled={busy} onChange={(event) => patch({ avatar: event.target.value })} /></label>
      <div className="settings-input-row"><span>Model</span><SelectControl compact={compact} label="Agent model" value={model ? JSON.stringify(model) : 'current'} options={modelOptions} disabled={busy}
        onValueChange={(value) => patch({ defaults: { ...draft.defaults, model: value === 'current' ? null : JSON.parse(value) as AgentDraft['defaults']['model'] } })} /></div>
      <div className="settings-input-row"><span>Thinking</span><SelectControl compact={compact} label="Agent thinking" value={draft.defaults.thinkingLevel} options={thinkingOptions} disabled={busy}
        onValueChange={(value) => patch({ defaults: { ...draft.defaults, thinkingLevel: value as AgentDraft['defaults']['thinkingLevel'] } })} /></div>
      <div className="settings-input-row"><span>Permission</span><SelectControl compact={compact} label="Agent permission" value={draft.defaults.permission} options={permissionOptions} disabled={busy}
        onValueChange={(value) => patch({ defaults: { ...draft.defaults, permission: value as AgentPermission } })} /></div>
      <label className="settings-input-row"><span>Tone</span><input aria-label="Agent tone" placeholder="Warm and brief" maxLength={500} value={draft.tone ?? ''} disabled={busy} onChange={(event) => patch({ tone: event.target.value })} /></label>
      <label className="settings-input-row settings-card-wide"><span>Skills</span><input aria-label="Agent skills" placeholder="Skill names, comma-separated" value={skills} disabled={busy}
        onChange={(event) => { setSkills(event.target.value); patch({ skillRefs: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) }); }} /></label>
      <label className="settings-input-row settings-card-wide"><span>Instructions</span><textarea aria-label="Agent instructions" rows={compact ? 4 : 6} maxLength={65_536} value={draft.instructions} disabled={busy} onChange={(event) => patch({ instructions: event.target.value })} /></label>
    </div>
    {agent && routines.map((routine) => <RoutineEditor key={`${routine.id}:${routine.revision}`} routine={routine} agentId={agent.id} count={routines.length} compact={compact} />)}
    {agent && addingRoutine && <RoutineEditor agentId={agent.id} count={routines.length} compact={compact} onDone={() => setAddingRoutine(false)} />}
    <div className="settings-card-actions">
      {dirty && <button type="button" className="settings-inline-action" disabled={busy} onClick={save}>Save agent</button>}
      {!agent && <button type="button" className="settings-inline-action" disabled={busy} onClick={() => useAgentsStore.setState({ editing: null })}>Cancel</button>}
      {status && <span className="settings-card-status" role="status">{status}</span>}
      {agent && <button type="button" className="settings-providers-add" disabled={busy || addingRoutine} onClick={() => setAddingRoutine(true)}><Plus size={12} aria-hidden="true" /> Routine</button>}
      {agent && copyable.length > 0 && <SelectControl compact={compact} label="Copy an old Automation into a Routine" placeholder="Copy Automation" value="" disabled={busy}
        options={copyable.map((item) => ({ value: item.sourceId, label: item.name }))} onValueChange={copy} />}
      {agent && <button type="button" className="settings-providers-add" disabled={busy} onClick={() => { if (confirming) remove(); else setConfirming(true); }}><Trash2 size={12} aria-hidden="true" /> {confirming ? 'Confirm delete' : 'Delete agent'}</button>}
    </div>
  </section>;
}

export function SavedAgentsSettings({ compact }: { compact: boolean }) {
  const agents = useAgentsStore((state) => state.library.agents);
  const editing = useAgentsStore((state) => state.editing);
  const models = useRuntimeStore((state) => state.runtime.models);
  useEffect(() => { void useAgentsStore.getState().load(); void useAgentsStore.getState().loadLegacy(); }, []);
  useEffect(() => { if (editing) document.getElementById(`saved-agent-${editing}`)?.scrollIntoView?.({ block: 'nearest' }); }, [editing, agents.length]);
  return <>
    <div className="settings-title settings-title--spaced">
      <div><h3>Saved agents</h3><p>Each agent has one chat and its own folder. It works in your projects through background runs.</p></div>
      <button type="button" className="settings-providers-add" onClick={() => useAgentsStore.setState({ editing: 'new' })}><Plus size={13} aria-hidden="true" /> New agent</button>
    </div>
    {editing === 'new' && <AgentCard key="new" models={models} compact={compact} />}
    {agents.map((agent) => <AgentCard key={`${agent.id}:${agent.revision}`} agent={agent} models={models} compact={compact} />)}
    {editing !== 'new' && !agents.length && <div className="settings-empty-card"><strong>No agents yet.</strong><span>Create one, then open its chat from the sidebar.</span></div>}
  </>;
}
