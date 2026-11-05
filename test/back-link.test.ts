import { describe, expect, it } from "vitest";
import { backLink } from "../src/back-link.ts";

const own = "https://ai.example.com";
const back = (from: string | null, referrer: string | null) => backLink(from, referrer, own);

describe("back link", () => {
  it("takes the page named in from only on the referrer's site, or with no referrer", () => {
    expect(back("https://evil.example/login", "https://app.slack.com/")).toEqual({ url: "https://app.slack.com/", host: "app.slack.com" });
    expect(back("https://www.example.com/pricing", null)).toEqual({ url: "https://www.example.com/pricing", host: "www.example.com" });
    expect(back("https://www.example.com/pricing", "https://team.cloudflareaccess.com/")).toEqual({
      url: "https://www.example.com/pricing",
      host: "www.example.com",
    });
  });

  it("skips identity providers' sign-in pages", () => {
    expect(back(null, "https://accounts.google.com/")).toBeUndefined();
    expect(back(null, "https://pool.auth.eu-west-1.amazoncognito.com/")).toBeUndefined();
    expect(back(null, "https://github.com/")).toBeUndefined();
  });

  it("goes to the page the site named, before the referrer", () => {
    expect(back("https://www.example.com/tools/ai?tab=2", "https://www.example.com/")).toEqual({
      url: "https://www.example.com/tools/ai?tab=2",
      host: "www.example.com",
    });
  });

  it("goes to the referrer when the link names no page", () => {
    expect(back(null, "https://www.example.com/")).toEqual({ url: "https://www.example.com/", host: "www.example.com" });
    expect(back("not a url", "https://www.example.com/")).toEqual({ url: "https://www.example.com/", host: "www.example.com" });
  });

  it("skips the app itself and its sign-in pages", () => {
    expect(back(null, "https://ai.example.com/c/abc")).toBeUndefined();
    expect(back(null, "https://team.cloudflareaccess.com/cdn-cgi/access/login")).toBeUndefined();
    expect(back("https://ai.example.com/", null)).toBeUndefined();
    expect(back(null, "https://cloudflareaccess.com.evil.example/")).toEqual({
      url: "https://cloudflareaccess.com.evil.example/",
      host: "cloudflareaccess.com.evil.example",
    });
  });

  it("takes only web pages", () => {
    expect(back(null, null)).toBeUndefined();
    expect(back("", "")).toBeUndefined();
    expect(back("javascript:alert(1)", null)).toBeUndefined();
    expect(back("data:text/html,hi", null)).toBeUndefined();
    expect(back("blob:https://www.example.com/0c1d", null)).toBeUndefined();
    expect(back("http://www.example.com/", null)).toBeUndefined();
    expect(back("/relative", null)).toBeUndefined();
    expect(back("http://localhost:3000/", null)).toEqual({ url: "http://localhost:3000/", host: "localhost" });
  });
});
