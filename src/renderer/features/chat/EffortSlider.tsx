import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type TransitionEvent } from 'react';

const KEY_STEPS: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 2, PageDown: -2 };
const STEP_UP_AT = 0.5;
const STEP_DOWN_AT = 0.25;
const SETTLE_TIMEOUT_MS = 1_500;
const LABEL_FALLBACK_MS = 400;

function stepTowards(level: number, position: number, last: number): number {
  let next = level;
  while (next < last && position >= next + STEP_UP_AT) next += 1;
  while (next > 0 && position <= next - STEP_DOWN_AT) next -= 1;
  return next;
}

export function EffortSlider<T extends string>({ levels, value, label, disabled, format, onChange }: {
  levels: readonly T[];
  value: T;
  label: string;
  disabled: boolean;
  format: (level: T) => string;
  onChange: (level: T) => void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [settling, setSettling] = useState<number | null>(null);
  const last = Math.max(1, levels.length - 1);
  const index = Math.max(0, levels.indexOf(value));
  const level = drag ?? settling ?? index;
  const fraction = level / last;
  const [settledLevel, setSettledLevel] = useState(level);
  const shownLevel = drag !== null ? level : settledLevel;
  useEffect(() => {
    if (settledLevel === level) return;
    const timer = setTimeout(() => setSettledLevel(level), LABEL_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [level, settledLevel]);
  useEffect(() => {
    if (settling === null) return;
    if (settling === index) {
      setSettling(null);
      return;
    }
    const timer = setTimeout(() => setSettling(null), SETTLE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [index, settling]);
  const positionAt = (event: PointerEvent<HTMLDivElement>) => {
    const rect = rail.current?.getBoundingClientRect();
    return rect?.width ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * last : index;
  };
  const commit = (next: number) => {
    const clamped = Math.min(last, Math.max(0, next));
    setSettling(clamped === index ? null : clamped);
    if (levels[clamped] !== value) onChange(levels[clamped]!);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    setDrag(stepTowards(level, positionAt(event), last));
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag !== null) setDrag(stepTowards(drag, positionAt(event), last));
  };
  const onPointerUp = () => {
    if (drag === null) return;
    setDrag(null);
    setSettledLevel(drag);
    commit(drag);
  };
  const onTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.propertyName === '--effort') setSettledLevel(level);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? last : KEY_STEPS[event.key] === undefined ? null : level + KEY_STEPS[event.key]!;
    if (next === null) return;
    event.preventDefault();
    commit(next);
  };
  return (
    <div
      className="effort-slider"
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={level}
      aria-valuetext={format(levels[level]!)}
      aria-disabled={disabled || undefined}
      data-dragging={drag !== null || undefined}
      data-level={level}
      data-max={level === last || undefined}
      style={{ '--effort': `${fraction * 100}%`, '--heat': fraction } as CSSProperties}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
      onTransitionEnd={onTransitionEnd}
      onKeyDown={onKeyDown}
    >
      <div ref={rail} className="effort-slider-rail">
        <i className="effort-slider-track" />
        <i className="effort-slider-fill" />
        <i className="effort-slider-thumb" />
        <span className="effort-slider-value">{format(levels[shownLevel]!)}</span>
      </div>
    </div>
  );
}
