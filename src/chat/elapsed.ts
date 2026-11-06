import { useEffect, useState } from "react";

/** Time since `ms` ago, the way a stopwatch reads it: "12s", "2m 21s", "2m", "1h 5m". */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const [hours, minutes] = [Math.floor(seconds / 3_600), Math.floor(seconds / 60) % 60];
  if (hours) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  return `${seconds}s`;
}

/** Milliseconds since `since`, again on each whole second after it, so a count turns over on time and never skips or repeats one. */
export function useElapsed(since: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), 1_000 - ((((now - since) % 1_000) + 1_000) % 1_000));
    return () => clearTimeout(timer);
  }, [now, since]);
  return now - since;
}
