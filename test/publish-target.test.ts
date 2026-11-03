import { describe, expect, it } from "vitest";
import { artifactByTitle } from "../worker/agent/publish-target.ts";

const artifact = (id: string, title: string, updatedAt: number) => ({ id, title, chatId: "c", latest: 1, updatedAt });

describe("artifactByTitle", () => {
  const artifacts = [
    artifact("b", "Prices", 3),
    artifact("c", "weather &  forecast dashboard ", 2),
    artifact("a", "Weather & Forecast Dashboard", 1),
  ];

  it("finds the newest of this chat's artifacts (listed newest first) with the title, whatever its case and spacing", () => {
    expect(artifactByTitle(artifacts, "Weather & Forecast Dashboard")?.id).toBe("c");
    expect(artifactByTitle(artifacts, "  PRICES ")?.id).toBe("b");
  });

  it("finds none for a new title", () => {
    expect(artifactByTitle(artifacts, "Weather")).toBeUndefined();
    expect(artifactByTitle([], "Prices")).toBeUndefined();
  });
});
