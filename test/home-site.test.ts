import { describe, expect, it } from "vitest";
import { backUrl, homeSite } from "../shared/home-site.ts";

describe("home site", () => {
  it("needs a name and an https URL", () => {
    expect(homeSite("https://www.example.com", "Example")).toEqual({ name: "Example", url: "https://www.example.com/" });
    expect(homeSite("", "Example")).toBeUndefined();
    expect(homeSite("https://www.example.com", " ")).toBeUndefined();
    expect(homeSite("http://www.example.com", "Example")).toBeUndefined();
    expect(homeSite("javascript:alert(1)", "Example")).toBeUndefined();
    expect(homeSite("not a url", "Example")).toBeUndefined();
    expect(homeSite("http://localhost:3000/", "Local")).toEqual({ name: "Local", url: "http://localhost:3000/" });
  });

  const site = { name: "Example", url: "https://www.example.com/" };

  it("goes back to the page the site named, on its own origin", () => {
    expect(backUrl(site, "https://www.example.com/tools/ai?tab=2")).toBe("https://www.example.com/tools/ai?tab=2");
  });

  it("goes to the site itself for anything else", () => {
    expect(backUrl(site, null)).toBe(site.url);
    expect(backUrl(site, "")).toBe(site.url);
    expect(backUrl(site, "https://evil.example.net/")).toBe(site.url);
    expect(backUrl(site, "https://ai.example.com/")).toBe(site.url);
    expect(backUrl(site, "http://www.example.com/")).toBe(site.url);
    expect(backUrl(site, "javascript:alert(1)")).toBe(site.url);
    expect(backUrl(site, "/relative")).toBe(site.url);
    expect(backUrl(site, "blob:https://www.example.com/0c1d")).toBe(site.url);
  });
});
