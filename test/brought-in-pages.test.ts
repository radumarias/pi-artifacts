import { describe, expect, it } from "vitest";
import type { ArtifactMeta } from "../shared/protocol.ts";
import { versionToRead, type SessionRules } from "../worker/agent/publish.ts";
import { shownOf } from "../worker/agents/roster.ts";

const versions = (n: number) => Array.from({ length: n }, (_, i) => ({ version: i + 1, publishedAt: i + 1 }));
/** A page of the owner's other chat, at version 3, brought into this one with "@" (ownArtifact in worker/agent/tools.ts). */
const page = {
  id: "p1",
  title: "Team",
  ownerUid: "u1",
  chatId: "home",
  createdAt: 0,
  updatedAt: 3,
  latest: 3,
  versions: versions(3),
} as ArtifactMeta;

describe("a page as its chat has it", () => {
  it("leaves out what turns apart from its chat hold: a brought-in page reads without it, as a run's page step builds", () => {
    const shown = shownOf(page, { page: false, versions: [3] })!;
    expect([shown.latest, shown.versions.map((version) => version.version)]).toEqual([2, [1, 2]]);
    // This chat's rules know nothing of the other chat's turns: the versions the page lists say what it may read.
    expect(versionToRead(shown, undefined)).toBe(2);
    expect(() => versionToRead(shown, 3)).toThrow("has no version 3");
    expect(versionToRead(shown, 1)).toBe(1);
    // All of it held, or every version: none of it is the chat's.
    expect(shownOf(page, { page: true, versions: [] })).toBeNull();
    expect(shownOf(page, { page: false, versions: [1, 2, 3] })).toBeNull();
    expect(shownOf(page, { page: false, versions: [] })).toEqual(page);
  });

  it("still leaves out what the conversation's own rules hide", () => {
    const rules = { hiddenVersion: (_id: string, version: number) => version === 3 } as unknown as SessionRules;
    expect([versionToRead(page, undefined, rules), versionToRead(page, undefined, rules, 2)]).toEqual([2, 2]);
    expect(() => versionToRead(page, 3, rules)).toThrow("has no version 3");
    expect(() => versionToRead(page, 4)).toThrow("has no version 4");
  });
});
