import { describe, expect, it } from "vitest";
import { STREAM_STEP_MS as STEP_MS } from "../shared/protocol.ts";
import { revealAt, revealTo } from "../src/chat/reveal.ts";

describe("revealing a streaming answer", () => {
  it("shows the first text at once", () => {
    expect(revealTo(undefined, "Hello", 0).shown).toBe(5);
  });

  it("reveals a step's new text over about a step, from where the reader is", () => {
    let reveal = revealTo(undefined, "Hello", 0);
    reveal = revealTo(reveal, "Hello, world and more", 1_000);
    expect(reveal.shown).toBe(5);
    const half = revealAt(reveal, 1_000 + STEP_MS / 2);
    expect(half.shown).toBe(13);
    expect(revealAt(half, 1_000 + STEP_MS).shown).toBe(21);
    // The next step comes before this one is shown: the rest of both comes over the next step.
    const next = revealTo(half, "Hello, world and more, and more", 1_500);
    expect(next.shown).toBe(13);
    expect(revealAt(next, 1_500 + STEP_MS).shown).toBe(31);
  });

  it("shows a text that changed rather than grew at once", () => {
    const reveal = revealTo(revealTo(undefined, "Hello", 0), "Goodbye", 100);
    expect(reveal.shown).toBe(7);
  });

  it("grows by at least one unit a tick, and never cuts a character in two", () => {
    const reveal = revealTo(revealTo(undefined, "a", 0), "a😀b", 0);
    expect(revealAt(reveal, 0).shown).toBe(3);
  });
});
