import * as Popover from '@radix-ui/react-popover';
import { Check, MessageSquare, Undo2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { GitHunk } from '../../../shared/contracts/ipc';
import { useUiStore } from '../../stores/uiStore';
import { messageOf, useWorkspaceStore } from '../../stores/workspaceStore';
import { describeDiffRange, type DiffLineRange } from './diffNoteModel';

function rejectionFeedback(path: string, hunk: GitHunk): string {
  return `I rejected this change in ${path} and reverted it:\n\n\`\`\`diff\n${hunk.text}\n\`\`\`\n\nDo not reapply it. Explain what you intended and propose a different approach if the change is still needed.`;
}

interface HunkNotes {
  active: DiffLineRange | null;
  ranges: (hunk: GitHunk) => DiffLineRange[];
  open: (range: DiffLineRange) => void;
}

function HunkNoteMenu({ hunk, active, ranges, open }: HunkNotes & { hunk: GitHunk }) {
  const [show, setShow] = useState(false);
  const picked = useRef(false);
  const pick = (range: DiffLineRange) => { picked.current = true; setShow(false); open(range); };
  const editing = active && ranges(hunk).some((range) => range.side === active.side && range.start <= active.start && range.end >= active.end);
  if (active && !editing) return <span />;
  const choices = show ? ranges(hunk) : [];
  return <Popover.Root open={show} onOpenChange={setShow}>
    <Popover.Trigger className="hunk-action diff-hunk-note" type="button" aria-label={`${editing ? 'Edit local note on' : 'Add local note to'} hunk ${hunk.index + 1}`} disabled={hunk.truncated}>
      <MessageSquare size={11} aria-hidden="true" /> Note
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="diff-note-ranges" side="bottom" align="end" sideOffset={4} collisionPadding={10} aria-label="Changed ranges"
        onCloseAutoFocus={(event) => { if (picked.current) { picked.current = false; event.preventDefault(); } }}>
        {editing ? <button className="diff-review-button" type="button" onClick={() => pick(active)}>
          Edit · {describeDiffRange(active)}
        </button> : choices.slice(0, 64).map((range) => <button className="diff-review-button" type="button" key={describeDiffRange(range)} onClick={() => pick(range)}>{describeDiffRange(range)}</button>)}
        {!editing && (choices.length === 0 || choices.length > 64) && <span>{choices.length ? 'More ranges are available in the editor.' : 'No matching ranges. Select changed lines in the editor.'}</span>}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

export function HunkStrip({ path, notes }: { path: string; notes?: HunkNotes }) {
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
    } catch (caught) {
      useUiStore.getState().showToast({ kind: 'error', title: 'Revert failed', message: messageOf(caught) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="hunk-strip" role="list" aria-label="Hunks">
      {hunks.hunks.map((hunk) => {
        const keptHunk = kept.has(hunk.header);
        return (
          <div className="hunk-row" role="listitem" key={hunk.header} data-kept={keptHunk || undefined} data-local-notes={notes ? true : undefined}>
            <code className="hunk-header" title={hunk.text.split('\n').slice(0, 12).join('\n')}>{hunk.header}</code>
            <span className="hunk-counts">+{hunk.newLines} −{hunk.oldLines}</span>
            <button type="button" className="hunk-action" aria-pressed={keptHunk} aria-label={`Keep hunk ${hunk.index + 1}`} onClick={() => toggleKept(hunk.header)}><Check size={11} aria-hidden="true" /> Keep</button>
            <button type="button" className="hunk-action" aria-label={`Reject hunk ${hunk.index + 1}`} disabled={busy !== null || hunk.truncated} title={hunk.truncated ? 'Too large to revert alone. Revert the whole file.' : 'Revert this hunk and draft feedback for the agent'} onClick={() => void reject(hunk)}><Undo2 size={11} aria-hidden="true" /> Reject</button>
            {notes && <HunkNoteMenu hunk={hunk} {...notes} />}
          </div>
        );
      })}
    </div>
  );
}
