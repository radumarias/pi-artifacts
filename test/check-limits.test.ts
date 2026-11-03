import { describe, expect, it } from "vitest";
import { deadline } from "../shared/util.ts";
import { CheckTimedOut } from "../worker/artifacts/browser.ts";

describe("deadline", () => {
  it("passes a promise that settles in time through", async () => {
    await expect(deadline(Promise.resolve(1), 1000, () => new CheckTimedOut("late"))).resolves.toBe(1);
  });

  it("rejects once the time is up, with the error it makes", async () => {
    await expect(deadline(new Promise(() => {}), 10, () => new CheckTimedOut("late"))).rejects.toBeInstanceOf(CheckTimedOut);
  });

  it("rejects when the signal aborts, also when it aborted already", async () => {
    const stop = new AbortController();
    const waiting = deadline(new Promise(() => {}), 10_000, () => new CheckTimedOut("late"), stop.signal);
    stop.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
    await expect(deadline(new Promise(() => {}), 10_000, () => new CheckTimedOut("late"), stop.signal)).rejects.toThrow("stopped");
  });
});
