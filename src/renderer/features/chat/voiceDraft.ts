export class VoiceDraftRange {
  private committed = '';
  private preserved = '';

  constructor(private draft: string, private start: number, private end: number) {}

  rebase(next: string): void {
    if (this.draft === next) return;
    let left = 0;
    const previous = this.draft;
    while (left < previous.length && left < next.length && previous[left] === next[left]) left++;
    let oldRight = previous.length;
    let newRight = next.length;
    while (oldRight > left && newRight > left && previous[oldRight - 1] === next[newRight - 1]) { oldRight--; newRight--; }
    if (oldRight <= this.start) {
      this.start += newRight - oldRight;
      this.end += newRight - oldRight;
    } else if (left < this.end) {
      this.start = this.end = next.length;
      this.preserved = this.committed;
    }
    this.draft = next;
  }

  apply(committed: string, selectionStart: number, selectionEnd: number) {
    const words = committed.trim();
    if (!words || words === this.committed) return null;
    const firstInsertion = !this.committed;
    this.committed = words;
    const text = this.preserved && words.startsWith(this.preserved) ? words.slice(this.preserved.length).trimStart() : words;
    if (!text) return null;
    const before = this.draft.slice(0, this.start);
    const after = this.draft.slice(this.end);
    const leading = before && !/\s$/u.test(before) ? ' ' : '';
    const trailing = after && !/^\s/u.test(after) ? ' ' : '';
    const insertion = `${leading}${text}${trailing}`;
    const nextEnd = this.start + insertion.length;
    const offset = (position: number) => {
      if (position < this.start) return position;
      if (position >= this.end) return position + nextEnd - this.end;
      return this.start + Math.min(position - this.start, insertion.length);
    };
    const replacingSelection = firstInsertion && selectionStart === this.start && selectionEnd === this.end;
    const start = replacingSelection ? nextEnd : offset(selectionStart);
    const end = replacingSelection ? nextEnd : selectionStart < this.start && selectionEnd === this.start ? selectionEnd : offset(selectionEnd);
    this.draft = before + insertion + after;
    this.end = nextEnd;
    return { text: this.draft, start, end };
  }
}
