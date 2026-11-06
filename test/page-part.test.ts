import { describe, expect, it } from "vitest";
import { pagePart } from "../worker/agent/page-part.ts";

const page = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");

describe("pagePart", () => {
  it("is the whole page without a part", () => {
    expect(pagePart(page)).toBe(page);
    expect(pagePart(page, " ")).toBe(page);
  });

  it("shows a line range, cut to the page", () => {
    expect(pagePart(page, "3-5")).toBe("Lines 3-5 of 100:\nline 3\nline 4\nline 5");
    expect(pagePart(page, "99-120")).toBe("Lines 99-100 of 100:\nline 99\nline 100");
    expect(pagePart(page, "150-160")).toMatch(/not in it/);
    expect(pagePart(page, "5-3")).toBe("Lines 3-5 of 100:\nline 3\nline 4\nline 5");
  });

  it("shows the lines around each place a text occurs, merging those that touch", () => {
    const shown = pagePart(page, "line 50");
    expect(shown.startsWith("Lines 35-65 of 100:\nline 35\n")).toBe(true);
    // line 5 and line 50..59 contain "line 5": runs around 5 and 50-59 merge into one run.
    expect(pagePart(page, "line 5").split("Lines ")).toHaveLength(3);
    expect(pagePart(page, "nowhere")).toMatch(/is not in the page \(100 lines\)/);
    // Text that spans lines: the run covers all of them.
    expect(pagePart(page, "line 50\nline 51").startsWith("Lines 35-66 of 100:\n")).toBe(true);
  });

  it("stops at five places and says there are more", () => {
    const spread = Array.from({ length: 400 }, (_, i) => (i % 50 === 0 ? "card" : "x")).join("\n");
    const shown = pagePart(spread, "card");
    expect(shown.split("Lines ")).toHaveLength(6);
    expect(shown).toMatch(/more places/);
  });
});
