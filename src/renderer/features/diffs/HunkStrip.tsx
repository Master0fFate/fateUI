import { Check, Undo2 } from 'lucide-react';
import { useState } from 'react';
import type { GitHunk } from '../../../shared/contracts/ipc';
import { useUiStore } from '../../stores/uiStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';

function rejectionFeedback(path: string, hunk: GitHunk): string {
  return `I rejected this change in ${path} and reverted it:\n\n\`\`\`diff\n${hunk.text}\n\`\`\`\n\nDo not reapply it. Explain what you intended and propose a different approach if the change is still needed.`;
}

export function HunkStrip({ path }: { path: string }) {
  const hunks = useWorkspaceStore((state) => state.hunks);
  const revertHunk = useWorkspaceStore((state) => state.revertHunk);
  const requestComposerDraft = useUiStore((state) => state.requestComposerDraft);
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  if (!hunks || hunks.path !== path || !hunks.tracked || hunks.hunks.length === 0) return null;
  const toggleKept = (header: string) => setKept((current) => {
    const next = new Set(current);
    if (!next.delete(header)) next.add(header);
    return next;
  });
  const reject = async (hunk: GitHunk) => {
    if (busy) return;
    setBusy(hunk.header);
    try {
      await revertHunk(path, hunk.index, hunk.header);
      requestComposerDraft(rejectionFeedback(path, hunk), false, 'Rejected hunk feedback ready. Review it before sending.');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="hunk-strip" role="list" aria-label="Hunks">
      {hunks.hunks.map((hunk) => {
        const keptHunk = kept.has(hunk.header);
        return (
          <div className="hunk-row" role="listitem" key={hunk.header} data-kept={keptHunk || undefined}>
            <code className="hunk-header" title={hunk.text.split('\n').slice(0, 12).join('\n')}>{hunk.header}</code>
            <span className="hunk-counts">+{hunk.newLines} −{hunk.oldLines}</span>
            <button type="button" className="hunk-action" aria-pressed={keptHunk} aria-label={`Keep hunk ${hunk.index + 1}`} onClick={() => toggleKept(hunk.header)}><Check size={11} aria-hidden="true" /> Keep</button>
            <button type="button" className="hunk-action" aria-label={`Reject hunk ${hunk.index + 1}`} disabled={busy !== null || hunk.truncated} title={hunk.truncated ? 'Too large to revert alone. Revert the whole file.' : 'Revert this hunk and draft feedback for the agent'} onClick={() => void reject(hunk)}><Undo2 size={11} aria-hidden="true" /> Reject</button>
          </div>
        );
      })}
    </div>
  );
}
