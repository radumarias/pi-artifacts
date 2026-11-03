import { describe, expect, it } from "vitest";
import type { ArtifactMeta } from "../shared/protocol.ts";
import { artifactByTitle, publishChecked, type PublishScope } from "../worker/agent/publish.ts";
import { BrowserUnavailable } from "../worker/artifacts/browser.ts";
import type { CheckReport } from "../worker/artifacts/check.ts";
import type { McpHub } from "../worker/mcp/hub.ts";
import type { ArtifactStore } from "../worker/storage/artifacts.ts";
import { ChatDrafts, draftId } from "../worker/storage/drafts.ts";
import { FakeBucket } from "./fakes.ts";

const artifact = (id: string, title: string, updatedAt: number) => ({ id, title, chatId: "c", latest: 1, updatedAt });

describe("artifactByTitle", () => {
  const artifacts = [artifact("b", "Prices", 3), artifact("c", "weather &  forecast dashboard ", 2), artifact("a", "Weather & Forecast Dashboard", 1)];

  it("finds the newest of this chat's artifacts (listed newest first) with the title, whatever its case and spacing", () => {
    expect(artifactByTitle(artifacts, "Weather & Forecast Dashboard")?.id).toBe("c");
    expect(artifactByTitle(artifacts, "  PRICES ")?.id).toBe("b");
  });

  it("finds none for a new title", () => {
    expect(artifactByTitle(artifacts, "Weather")).toBeUndefined();
    expect(artifactByTitle([], "Prices")).toBeUndefined();
  });
});

const report = (errors: string[]): CheckReport => ({
  errors,
  warnings: [],
  calls: [],
  tests: [],
  text: "",
  screenshot: "",
  thumb: "",
  width: 1280,
  height: 800,
});

/** A chat with no MCP servers whose browser answers with `check`, and the versions it published. */
function chat(check: (html: string) => CheckReport | Error, publishUnchecked = false) {
  const versions: { id?: string; html: string }[] = [];
  const checked: string[] = [];
  const drafts = new ChatDrafts(new FakeBucket().r2, "ada", "0123456789abcdef", new ArrayBuffer(32));
  const scope: PublishScope = {
    uid: "ada",
    chatId: "0123456789abcdef",
    hub: { servers: () => [] } as unknown as McpHub,
    artifacts: {
      publishVersion: async (input: { id?: string; title: string; html: string }) => {
        versions.push({ id: input.id, html: input.html });
        const id = input.id ?? "new0000000000001";
        return { id, title: input.title, latest: versions.filter((v) => (v.id ?? "new0000000000001") === id).length, updatedAt: 0 } as ArtifactMeta;
      },
    } as unknown as ArtifactStore,
    onPublished: async () => {},
    checkPage: async ({ html }) => {
      checked.push(html);
      const result = check(html);
      if (result instanceof Error) throw result;
      return result;
    },
    chatArtifacts: async () => [],
    drafts: async () => drafts,
    publishUnchecked,
  };
  return { scope, versions, checked, drafts };
}

describe("publishChecked", () => {
  const broken = "<p>broken</p>";
  const fixed = "<p>fixed</p>";
  const errorsIn = (html: string) => report(html === broken ? ["TypeError: L.map is not a function"] : []);

  it("makes no version of a page with errors, but keeps it as a draft; the fixed page is published and its draft goes", async () => {
    const { scope, versions, drafts } = chat(errorsIn);
    const failed = await publishChecked(scope, { title: "Map", html: broken, artifactId: "a1" });
    expect(failed.meta).toBeUndefined();
    expect(failed.draft).toMatchObject({ id: await draftId(broken, {}), html: broken, artifactId: "a1", errors: 1 });
    expect(versions).toEqual([]);

    const done = await publishChecked(scope, { title: "Map", html: fixed, artifactId: "a1" });
    expect(done.meta?.id).toBe("a1");
    expect(versions).toEqual([{ id: "a1", html: fixed }]);
    expect((await drafts.list()).map((d) => d.id)).toEqual([await draftId(broken, {})]);
  });

  it("publishes a page whose draft passed without checking it again, into the artifact it was checked for", async () => {
    const { scope, versions, checked, drafts } = chat(errorsIn);
    const page = { id: await draftId(fixed, {}), html: fixed, manifest: {}, artifactId: "a1" };
    await drafts.save(page, { errors: 0, warnings: 0 });
    const done = await publishChecked(scope, { title: "Map", html: fixed });
    expect(checked).toEqual([]);
    expect(versions).toEqual([{ id: "a1", html: fixed }]);
    expect(done.report).toBeUndefined();
    expect(await drafts.list()).toEqual([]);

    await drafts.save(page, { errors: 0, warnings: 0 });
    await publishChecked(scope, { title: "Map", checkId: page.id });
    expect(checked).toEqual([]);
    expect(versions).toHaveLength(2);
  });

  it("publishes by check id only a draft that passed", async () => {
    const { scope, versions, drafts } = chat(errorsIn);
    await expect(publishChecked(scope, { title: "Map", checkId: "0000000000000001" })).rejects.toThrow("No draft");
    const { id } = await drafts.save({ id: await draftId(broken, {}), html: broken, manifest: {} }, { errors: 1, warnings: 0 });
    await expect(publishChecked(scope, { title: "Map", checkId: id })).rejects.toThrow("has not passed a check");
    expect(versions).toEqual([]);
  });

  it("does not publish a page no browser could check, except in local development", async () => {
    const down = () => new BrowserUnavailable("no browser");
    const deployed = chat(down);
    const outcome = await publishChecked(deployed.scope, { title: "Map", html: fixed });
    expect(outcome).toMatchObject({ unchecked: "no browser", draft: { html: fixed, errors: null } });
    expect(deployed.versions).toEqual([]);

    const local = chat(down, true);
    expect((await publishChecked(local.scope, { title: "Map", html: fixed })).meta).toBeDefined();
    expect(local.versions).toHaveLength(1);
  });
});
