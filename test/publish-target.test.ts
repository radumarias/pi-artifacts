import { describe, expect, it } from "vitest";
import { artifactByTitle } from "../worker/agent/publish-target.ts";

const artifact = (id: string, title: string, updatedAt: number) => ({ id, title, chatId: "c", latest: 1, updatedAt });

describe("artifactByTitle", () => {
  const artifacts = [
    artifact("a", "Hotel Budget & Forecast Dashboard", 1),
    artifact("b", "Prices", 3),
    artifact("c", "hotel budget &  forecast dashboard ", 2),
  ];

  it("finds this chat's newest artifact with the title, whatever its case and spacing", () => {
    expect(artifactByTitle(artifacts, "Hotel Budget & Forecast Dashboard")?.id).toBe("c");
    expect(artifactByTitle(artifacts, "  PRICES ")?.id).toBe("b");
  });

  it("finds none for a new title", () => {
    expect(artifactByTitle(artifacts, "Hotel Budget")).toBeUndefined();
    expect(artifactByTitle([], "Prices")).toBeUndefined();
  });
});
