import { Brain, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { LearningState } from '../../../shared/contracts/learning';
import { getDesktopApiOptional } from '../../platform/api';
import { useSkinComponents } from '../../skins/SkinProvider';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useLearningStore } from './learningStore';

interface Store { on: boolean; count: number }
interface PendingDrafts { projectKey: string | null; project: Store; global: Store }
const none: PendingDrafts = { projectKey: null, project: { on: false, count: 0 }, global: { on: false, count: 0 } };
const store = (state: LearningState): Store => ({ on: state.enabled, count: state.snapshot?.drafts.filter((draft) => draft.state === 'pending').length ?? 0 });
const shown = ({ on, count }: Store) => on ? count : 0;

export function LearningDraftsRail() {
  const { Symbol } = useSkinComponents();
  const projectPath = useRuntimeStore((state) => state.runtime.project?.trusted ? state.runtime.project.path : null);
  const [pending, setPending] = useState(none);
  useEffect(() => {
    const api = getDesktopApiOptional();
    if (!projectPath || !api?.getLearningState) { setPending(none); return; }
    let current = true;
    const load = () => void Promise.all([api.getLearningState('project'), api.getLearningState('global')])
      .then(([project, global]) => { if (current) setPending({ projectKey: project.binding?.projectKey ?? null, project: store(project), global: store(global) }); })
      .catch(() => { if (current) setPending(none); });
    load();
    const unsubscribe = api.onLearningChanged?.((event) => {
      const count = event.pending;
      if (count === undefined) { load(); return; }
      setPending((previous) => event.scope === 'global' ? { ...previous, global: { ...previous.global, count } }
        : event.projectKey === previous.projectKey ? { ...previous, project: { ...previous.project, count } } : previous);
    });
    return () => { current = false; unsubscribe?.(); };
  }, [projectPath]);
  const project = shown(pending.project);
  const total = project + shown(pending.global);
  if (!total) return null;
  return (
    <div className="goalmax-saved-instructions">
      <button type="button" className="composer-rail-header" aria-label={`Review ${total} memory drafts`} onClick={() => useLearningStore.getState().show(undefined, project ? 'project' : 'global')}>
        <span className="composer-rail-mark"><Symbol text="[m]"><Brain size={13} aria-hidden="true" /></Symbol></span>
        <span className="composer-rail-copy">Memory drafts · {total}</span>
        <ChevronRight size={12} aria-hidden="true" />
      </button>
    </div>
  );
}
