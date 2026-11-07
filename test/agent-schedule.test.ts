import { describe, expect, it } from "vitest";
import { describeSchedule, instantOf, nextRunAt, wallClock } from "../worker/agents/runs/schedule.ts";

const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());

describe("agent schedules", () => {
  it("keeps a local 07:00 across a daylight-saving change", () => {
    const trigger = { kind: "schedule" as const, at: "07:00", tz: "Europe/Bucharest" };
    // Clocks go forward on Sunday 29 March 2026 at 03:00: 07:00 is 05:00Z before, 04:00Z after.
    const saturday = nextRunAt(trigger, Date.parse("2026-03-27T06:00:00Z"));
    expect(iso(saturday)).toBe("2026-03-28T05:00:00.000Z");
    const sunday = nextRunAt(trigger, saturday!);
    expect(iso(sunday)).toBe("2026-03-29T04:00:00.000Z");
    expect(wallClock(sunday!, trigger.tz)).toMatchObject({ hour: 7, minute: 0, day: 29 });
    // And back on Sunday 25 October 2026 at 04:00.
    expect(iso(nextRunAt(trigger, Date.parse("2026-10-24T05:00:00Z")))).toBe("2026-10-25T05:00:00.000Z");
    expect(iso(nextRunAt(trigger, Date.parse("2026-10-23T05:00:00Z")))).toBe("2026-10-24T04:00:00.000Z");
  });

  it("runs only on the days named, strictly after the last run", () => {
    const trigger = { kind: "schedule" as const, at: "09:30", tz: "America/New_York", days: ["mon" as const, "fri" as const] };
    // Wednesday 4 November 2026: next Friday 6th, 09:30 EST = 14:30Z.
    const friday = nextRunAt(trigger, Date.parse("2026-11-04T12:00:00Z"));
    expect(iso(friday)).toBe("2026-11-06T14:30:00.000Z");
    expect(iso(nextRunAt(trigger, friday!))).toBe("2026-11-09T14:30:00.000Z");
    // The same minute again is not "after".
    expect(nextRunAt(trigger, friday! - 1)).toBe(friday);
  });

  it("gives a time the clocks skip the instant of the jump, and a time that comes twice its first", () => {
    // 03:30 does not exist in Bucharest on 29 March 2026: 04:30 (+3) is 01:30Z.
    expect(iso(instantOf({ year: 2026, month: 3, day: 29, hour: 3, minute: 30 }, "Europe/Bucharest"))).toBe("2026-03-29T01:30:00.000Z");
    // 03:30 comes twice on 25 October 2026: first at +3 (00:30Z).
    expect(iso(instantOf({ year: 2026, month: 10, day: 25, hour: 3, minute: 30 }, "Europe/Bucharest"))).toBe("2026-10-25T00:30:00.000Z");
  });

  it("works in zones without daylight saving and across a year's end", () => {
    const trigger = { kind: "schedule" as const, at: "00:15", tz: "Asia/Kolkata" };
    expect(iso(nextRunAt(trigger, Date.parse("2026-12-31T18:00:00Z")))).toBe("2026-12-31T18:45:00.000Z");
    expect(iso(nextRunAt(trigger, Date.parse("2026-12-31T19:00:00Z")))).toBe("2027-01-01T18:45:00.000Z");
  });

  it("says when in words", () => {
    expect(describeSchedule({ kind: "schedule", at: "07:00", tz: "Europe/Bucharest" })).toBe("Every day at 07:00 (Europe/Bucharest)");
    expect(describeSchedule({ kind: "schedule", at: "07:00", tz: "UTC", days: ["mon", "wed"] })).toBe("On Mon, Wed at 07:00 (UTC)");
  });
});
