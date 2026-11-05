import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SentTime, sentLabel } from "../src/chat/SentTime.tsx";

// 2026-11-05 14:30 UTC, a Thursday.
const now = Date.UTC(2026, 10, 5, 14, 30);
const label = (at: number) => sentLabel(at, now, { locale: "en-GB", timeZone: "UTC" });

describe("when a message was sent", () => {
  it("says now for the last minute, and for a clock a little behind", () => {
    expect(label(now)).toBe("now");
    expect(label(now - 59_000)).toBe("now");
    expect(label(now + 20_000)).toBe("now");
  });

  it("counts minutes for the last hour", () => {
    expect(label(now - 60_000)).toBe("1 min ago");
    expect(label(now - 59 * 60_000)).toBe("59 min ago");
  });

  it("gives the time today, and yesterday's with the day", () => {
    expect(label(Date.UTC(2026, 10, 5, 9, 5))).toBe("9:05");
    expect(label(Date.UTC(2026, 10, 5, 0, 0))).toBe("0:00");
    expect(label(Date.UTC(2026, 10, 4, 23, 59))).toBe("Yesterday, 23:59");
  });

  it("gives the date before, with the year only for another year", () => {
    expect(label(Date.UTC(2026, 10, 3, 8, 0))).toBe("3 Nov, 8:00");
    expect(label(Date.UTC(2025, 10, 3, 8, 0))).toBe("3 Nov 2025");
  });

  it("goes by the viewer's day, not UTC's", () => {
    // 01:00 on the 5th in Bucharest is 23:00 on the 4th in UTC.
    const at = Date.UTC(2026, 10, 4, 23, 0);
    expect(sentLabel(at, now, { locale: "en-GB", timeZone: "Europe/Bucharest" })).toBe("1:00");
  });

  it("renders a time element with the full date for machines", () => {
    const html = renderToStaticMarkup(<SentTime at={Date.UTC(2026, 10, 3, 8, 0)} />);
    expect(html).toContain('class="sent-time"');
    expect(html).toContain('dateTime="2026-11-03T08:00:00.000Z"');
  });
});
