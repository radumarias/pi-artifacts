// When a scheduled agent runs next: a local time ("07:00") in its definition's time zone, on some days of the week.
// Cron is UTC only, so each run is a one-shot alarm set again after the run, from the wall clock of its time zone:
// 07:00 stays 07:00 across a daylight-saving change.

import { WEEKDAYS, type AgentTrigger, type Weekday } from "../../../shared/agents.ts";

type Schedule = Extract<AgentTrigger, { kind: "schedule" }>;
type Wall = { year: number; month: number; day: number; hour: number; minute: number };

const formats = new Map<string, Intl.DateTimeFormat>();

function format(tz: string): Intl.DateTimeFormat {
  let found = formats.get(tz);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formats.set(tz, found);
  }
  return found;
}

/** The wall clock in `tz` at instant `at` (epoch ms). */
export function wallClock(at: number, tz: string): Wall & { second: number } {
  const parts: Record<string, number> = {};
  for (const part of format(tz).formatToParts(new Date(at))) if (part.type !== "literal") parts[part.type] = Number(part.value);
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second };
}

/** How far `tz` is ahead of UTC at instant `at`, in ms. */
function offset(at: number, tz: string): number {
  const wall = wallClock(at, tz);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(at / 1000) * 1000;
}

/**
 * The instant the wall clock in `tz` shows `wall`. A time that comes twice (the hour the clocks go back) is its first;
 * one that never comes (the hour they go forward) is as late as the jump: 02:30 on a spring-forward night is 03:30.
 */
export function instantOf(wall: Wall, tz: string): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  // A change of offset is at most once around a given time: the offsets half a day either side are the two there are.
  const before = offset(asUtc - 14 * 3_600_000, tz);
  const after = offset(asUtc + 14 * 3_600_000, tz);
  const shows = (at: number) => {
    const seen = wallClock(at, tz);
    return seen.year === wall.year && seen.month === wall.month && seen.day === wall.day && seen.hour === wall.hour && seen.minute === wall.minute;
  };
  const candidates = [asUtc - before, asUtc - after].filter(shows).sort((a, b) => a - b);
  return candidates[0] ?? asUtc - before;
}

function weekday(wall: Pick<Wall, "year" | "month" | "day">): Weekday {
  // getUTCDay counts from Sunday; WEEKDAYS from Monday.
  return WEEKDAYS[(new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay() + 6) % 7];
}

/** When a schedule next runs, strictly after `after` (epoch ms); null when it names no day it can run on. */
export function nextRunAt(trigger: Schedule, after: number): number | null {
  const [hour, minute] = trigger.at.split(":").map(Number);
  const days = trigger.days?.length ? new Set(trigger.days) : null;
  const today = wallClock(after, trigger.tz);
  // Eight days covers a weekly schedule from any day; a day past a gap in the calendar (a skipped date) is one more.
  for (let ahead = 0; ahead < 9; ahead++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + ahead));
    const wall = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute };
    if (days && !days.has(weekday(wall))) continue;
    const at = instantOf(wall, trigger.tz);
    if (at > after) return at;
  }
  return null;
}

/** A schedule in words, as a run's "When" row says it: "Every day at 07:00 (Europe/Bucharest)". */
export function describeSchedule(trigger: Schedule): string {
  const days = trigger.days?.length && trigger.days.length < 7 ? `On ${trigger.days.map((day) => day[0].toUpperCase() + day.slice(1)).join(", ")}` : "Every day";
  return `${days} at ${trigger.at} (${trigger.tz})`;
}
