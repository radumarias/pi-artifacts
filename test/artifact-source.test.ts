import { describe, expect, it } from "vitest";
import { ARTIFACT_CSP, artifactETag, artifactResponse, sourceETag, sourceResponse } from "../worker/artifacts/serve.ts";

describe("an artifact's source", () => {
  it("is the page as written, as plain text under the page's policy, without the runtime", async () => {
    const html = "<h1>Hi</h1><script>pi.use('mcp')</script>";
    const response = sourceResponse(html, sourceETag("abc", 2));
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe(ARTIFACT_CSP);
    expect(await response.text()).toBe(html);
    // The page itself carries the runtime.
    expect((await artifactResponse(html, artifactETag("abc", 2)).text()).length).toBeGreaterThan(html.length);
  });

  it("has its own ETag, apart from the page's", () => {
    expect(sourceETag("abc", 2)).not.toBe(artifactETag("abc", 2));
    expect(sourceETag("abc", 2)).not.toBe(sourceETag("abc", 3));
  });
});
