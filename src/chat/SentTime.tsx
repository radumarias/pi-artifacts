import { useSyncExternalStore } from "react";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How often the times shown move on: often enough for "now" to become "1 min ago" about when it should. */
const TICK_MS = 30_000;

interface Formats {
  time: Intl.DateTimeFormat;
  /** The calendar day, read by its parts (see dayOf), never by the shape of the string. */
  day: Intl.DateTimeFormat;
  date: Intl.DateTimeFormat;
  dateWithYear: Intl.DateTimeFormat;
  /** The tooltip's full date and time, as `toLocaleString` gives it. */
  full: Intl.DateTimeFormat;
  /** The day of the last `now` asked for: the same for every label between two ticks. */
  today?: { now: number; day: number };
}

/** The formats a label is made of, made once for each locale and time zone: making one costs far more than using it. */
const formats = new Map<string, Formats>();
function formatsFor(locale: string | undefined, timeZone: string | undefined): Formats {
  const key = `${locale ?? ""}|${timeZone ?? ""}`;
  let found = formats.get(key);
  if (!found) {
    found = {
      time: new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }),
      day: new Intl.DateTimeFormat("en-US", { year: "numeric", month: "numeric", day: "numeric", numberingSystem: "latn", timeZone }),
      date: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone }),
      dateWithYear: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric", timeZone }),
      full: new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
        timeZone,
      }),
    };
    formats.set(key, found);
  }
  return found;
}

/** The calendar day `at` falls on in the format's time zone, as that day's midnight in UTC: days apart differ by DAY. */
function dayOf(f: Formats, at: number): number {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of f.day.formatToParts(at)) parts[part.type] = Number(part.value);
  return Date.UTC(parts.year ?? 0, (parts.month ?? 1) - 1, parts.day ?? 1);
}

function todayOf(f: Formats, now: number): number {
  if (f.today?.now !== now) f.today = { now, day: dayOf(f, now) };
  return f.today.day;
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
  const sent = dayOf(f, at);
  const today = todayOf(f, now);
  if (sent === today) return time;
  // By calendar days, not 24 hours back: a day can be 23 or 25 hours long where clocks change.
  if (sent === today - DAY) return `Yesterday, ${time}`;
  return new Date(sent).getUTCFullYear() === new Date(today).getUTCFullYear() ? `${f.date.format(at)}, ${time}` : f.dateWithYear.format(at);
}

// One clock for every time shown, ticking while any message is in view (each has its label, hidden until hovered).
// Rounded down to the tick, so React reads the same label however often it asks between two ticks.
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
  return (
    <time className="sent-time" dateTime={new Date(at).toISOString()} title={formatsFor(undefined, undefined).full.format(at)}>
      {text}
    </time>
  );
}
