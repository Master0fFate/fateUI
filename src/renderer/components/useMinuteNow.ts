import { useEffect, useState } from 'react';

export function useMinuteNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      timer = setTimeout(tick, 60_000 - Date.now() % 60_000 + 25);
    };
    timer = setTimeout(tick, 60_000 - Date.now() % 60_000 + 25);
    return () => clearTimeout(timer);
  }, [enabled]);
  return now;
}
