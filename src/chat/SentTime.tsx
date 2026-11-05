import { useSyncExternalStore } from "react";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How often the times shown move on: often enough for "now" to become "1 min ago" about when it should. */
const TICK_MS = 30_000;

/**
 * When a message was sent, as a chat shows it under the message: "now", "12 min ago", the time today ("14:05"),
 * "Yesterday, 14:05", "Nov 3, 14:05" this year, and "Nov 3, 2025" before. `timeZone` and `locale` default to the
 * viewer's.
 */
export function sentLabel(at: number, now: number, { locale, timeZone }: { locale?: string; timeZone?: string } = {}): string {
  const ago = now - at;
  if (ago < MINUTE) return "now";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }).format(at);
  const day = (ms: number) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(ms);
  const sent = day(at);
  if (sent === day(now)) return time;
  if (sent === day(now - DAY)) return `Yesterday, ${time}`;
  const sameYear = sent.slice(0, 4) === day(now).slice(0, 4);
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric", timeZone }).format(at);
  return sameYear ? `${date}, ${time}` : date;
}

// One clock for every time shown, ticking only while one is on screen. Rounded down to the tick, so React reads the
// same value however often it asks between two ticks.
const clock = {
  listeners: new Set<() => void>(),
  timer: undefined as ReturnType<typeof setInterval> | undefined,
  subscribe(listener: () => void): () => void {
    clock.listeners.add(listener);
    clock.timer ??= setInterval(() => clock.listeners.forEach((l) => l()), TICK_MS);
    return () => {
      clock.listeners.delete(listener);
      if (clock.listeners.size === 0) {
        clearInterval(clock.timer);
        clock.timer = undefined;
      }
    };
  },
  now: () => Math.floor(Date.now() / TICK_MS) * TICK_MS,
};

/** When a message was sent, under it on hover; the full date and time in its tooltip. */
export function SentTime({ at }: { at: number }) {
  const now = useSyncExternalStore(clock.subscribe, clock.now, clock.now);
  const date = new Date(at);
  return (
    <time className="sent-time" dateTime={date.toISOString()} title={date.toLocaleString()}>
      {sentLabel(at, now)}
    </time>
  );
}
