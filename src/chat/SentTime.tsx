import { useSyncExternalStore } from "react";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How often the times shown move on: often enough for "now" to become "1 min ago" about when it should. */
const TICK_MS = 30_000;

/** The formats a label is made of, made once for each locale and time zone: making one costs far more than using it. */
const formats = new Map<string, Record<"time" | "day" | "date" | "dateWithYear", Intl.DateTimeFormat>>();
function formatsFor(locale: string | undefined, timeZone: string | undefined) {
  const key = `${locale ?? ""}|${timeZone ?? ""}`;
  let found = formats.get(key);
  if (!found) {
    found = {
      time: new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }),
      // YYYY-MM-DD, to tell the calendar day and year.
      day: new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }),
      date: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone }),
      dateWithYear: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric", timeZone }),
    };
    formats.set(key, found);
  }
  return found;
}

/**
 * When a message was sent, as a chat shows it under the message: "now", "12 min ago", the time today ("14:05"),
 * "Yesterday, 14:05", "Nov 3, 14:05" this year, and "Nov 3, 2025" before. `timeZone` and `locale` default to the
 * viewer's.
 */
export function sentLabel(at: number, now: number, { locale, timeZone }: { locale?: string; timeZone?: string } = {}): string {
  const ago = now - at;
  if (ago < MINUTE) return "now";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
  const f = formatsFor(locale, timeZone);
  const time = f.time.format(at);
  const sent = f.day.format(at);
  const today = f.day.format(now);
  if (sent === today) return time;
  if (sent === f.day.format(now - DAY)) return `Yesterday, ${time}`;
  return sent.slice(0, 4) === today.slice(0, 4) ? `${f.date.format(at)}, ${time}` : f.dateWithYear.format(at);
}

// One clock for every time shown, ticking only while one is on screen. Rounded down to the tick, so React reads the
// same label however often it asks between two ticks.
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  timer ??= setInterval(() => listeners.forEach((l) => l()), TICK_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const clockNow = () => Math.floor(Date.now() / TICK_MS) * TICK_MS;

/** When a message was sent, under it on hover; the full date and time in its tooltip. */
export function SentTime({ at }: { at: number }) {
  // The label itself, so a tick draws again only the labels it changes ("now", "N min ago", and those past midnight).
  const label = () => sentLabel(at, clockNow());
  const text = useSyncExternalStore(subscribe, label, label);
  const date = new Date(at);
  return (
    <time className="sent-time" dateTime={date.toISOString()} title={date.toLocaleString()}>
      {text}
    </time>
  );
}
