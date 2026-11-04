import { describe, expect, it } from "vitest";
import { AGENT_REACTOR, isReaction } from "../shared/reactions.ts";
import { ChatReactions } from "../worker/reactions.ts";
import { memorySql } from "./fakes.ts";

describe("chat reactions", () => {
  it("keeps who reacted with what on which message, first first", () => {
    const reactions = new ChatReactions(memorySql());
    expect(reactions.set(7, "🚀", AGENT_REACTOR, true)).toBe(true);
    expect(reactions.set(7, "👍", "ann", true)).toBe(true);
    expect(reactions.set(7, "👍", "bob", true)).toBe(true);
    expect(reactions.set(9, "🎉", "bob", true)).toBe(true);
    expect(reactions.all()).toEqual({ 7: { "👍": ["ann", "bob"], "🚀": [AGENT_REACTOR] }, 9: { "🎉": ["bob"] } });
    expect(reactions.of(7)).toEqual({ "👍": ["ann", "bob"], "🚀": [AGENT_REACTOR] });
    expect(reactions.of(8)).toEqual({});
    expect(reactions.has(7)).toBe(true);
    expect(reactions.has(8)).toBe(false);
  });

  it("counts a reaction once, and takes it back", () => {
    const reactions = new ChatReactions(memorySql());
    reactions.set(3, "❤️", "ann", true);
    expect(reactions.set(3, "❤️", "ann", true)).toBe(false);
    expect(reactions.set(3, "❤️", "bob", false)).toBe(false);
    expect(reactions.set(3, "❤️", "ann", false)).toBe(true);
    expect(reactions.all()).toEqual({});
  });

  it("takes only the set's emoji", () => {
    expect(isReaction("🚀")).toBe(true);
    expect(isReaction("<b>hi</b>")).toBe(false);
    expect(isReaction("💩")).toBe(false);
  });
});
