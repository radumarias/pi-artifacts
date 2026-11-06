import { describe, expect, it } from "vitest";
import type { ArtifactMeta } from "../shared/protocol.ts";
import {
  applyEdits,
  artifactByTitle,
  checkInBrowser,
  FailedChecks,
  MAX_FAILED_CHECKS,
  publishDraft,
  checkDraft,
  writeDraft,
  type PublishScope,
} from "../worker/agent/publish.ts";
import { BrowserUnavailable, CheckTimedOut } from "../worker/artifacts/browser.ts";
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
function chat(check: (html: string) => CheckReport | Error, publishUnchecked = false, skillFiles: Record<string, string> = {}, skillSet = { id: "0123456789abcdef" }) {
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
    skillSets: async (names) =>
      new Map(
        names.flatMap((name) => {
          const files = Object.keys(skillFiles).filter((key) => key.startsWith(`${name}/`));
          return files.length ? [[name, { set: skillSet.id, files: files.map((key) => ({ path: key.slice(name.length + 1), size: skillFiles[key].length })) }] as const] : [];
        }),
      ),
    readSkillFile: async (skill, set, path) => (set === skillSet.id ? (skillFiles[`${skill}/${path}`] ?? null) : null),
    publishUnchecked,
  };
  return { scope, versions, checked, drafts };
}

const a1 = { id: "a1", latest: 2, versions: [{ version: 1 }, { version: 2 }] } as unknown as ArtifactMeta;

describe("write, check, publish", () => {
  const broken = "<p>broken</p>";
  const fixed = "<p>fixed</p>";
  const errorsIn = (html: string) => report(html === broken ? ["TypeError: L.map is not a function"] : []);

  it("checks a draft and keeps what it found; publishes the fixed one into its artifact, and its draft goes", async () => {
    const { scope, versions, checked, drafts } = chat(errorsIn);
    const first = await writeDraft(scope, { html: broken, artifact: a1 });
    const bad = await checkDraft(scope, first.id, {});
    expect(bad.draft).toMatchObject({ id: first.id, artifactId: "a1", errors: 1 });
    expect(await drafts.get(first.id)).toMatchObject({ errors: 1 });
    await expect(publishDraft(scope, { title: "Map", draftId: first.id })).rejects.toThrow('found 1 error in draft "' + first.id + '"');
    expect(versions).toEqual([]);

    const second = await writeDraft(scope, { draftId: first.id, edits: [{ old: "broken", new: "fixed" }] });
    expect(second).toMatchObject({ html: fixed, artifactId: "a1", errors: null });
    await checkDraft(scope, second.id, {});
    const done = await publishDraft(scope, { title: "Map", draftId: second.id });
    expect(done.meta.id).toBe("a1");
    expect(versions).toEqual([{ id: "a1", html: fixed }]);
    expect(checked).toEqual([broken, fixed]);
    expect((await drafts.list()).map((d) => d.id)).toEqual([first.id]);
  });

  it("publishes only a draft that passed: none not checked, and none that is gone", async () => {
    const { scope, versions } = chat(errorsIn);
    await expect(publishDraft(scope, { title: "Map", draftId: "0000000000000001" })).rejects.toThrow("No draft");
    const { id } = await writeDraft(scope, { html: fixed });
    await expect(publishDraft(scope, { title: "Map", draftId: id })).rejects.toThrow("has not passed a check");
    expect(versions).toEqual([]);
  });

  it("keeps a passed draft when its version could not be stored, to publish again", async () => {
    const { scope, drafts } = chat(errorsIn);
    scope.artifacts.publishVersion = async () => {
      throw new Error("push failed");
    };
    const { id } = await writeDraft(scope, { html: fixed });
    await checkDraft(scope, id, {});
    await expect(publishDraft(scope, { title: "Map", draftId: id })).rejects.toThrow("push failed");
    expect(await drafts.get(id)).toMatchObject({ errors: 0 });
  });

  it("does not publish a page no browser could check, except in local development", async () => {
    const down = () => new BrowserUnavailable("no browser");
    const deployed = chat(down);
    const { id } = await writeDraft(deployed.scope, { html: fixed });
    expect(await checkDraft(deployed.scope, id, {})).toMatchObject({ unchecked: "no browser", draft: { errors: null } });
    await expect(publishDraft(deployed.scope, { title: "Map", draftId: id })).rejects.toThrow("has not passed a check");

    const local = chat(down, true);
    const page = await writeDraft(local.scope, { html: fixed });
    expect(await publishDraft(local.scope, { title: "Map", draftId: page.id })).toMatchObject({ unchecked: true });
    expect(local.versions).toHaveLength(1);
  });

  it("checks a draft no check saw before publishing it in local development, when a browser can", async () => {
    const local = chat(errorsIn, true);
    const bad = await writeDraft(local.scope, { html: broken });
    await expect(publishDraft(local.scope, { title: "Map", draftId: bad.id })).rejects.toThrow("found 1 error");
    expect(await local.drafts.get(bad.id)).toMatchObject({ errors: 1 });
    const good = await writeDraft(local.scope, { html: fixed });
    expect(await publishDraft(local.scope, { title: "Map", draftId: good.id })).not.toHaveProperty("unchecked");
    expect(local.checked).toEqual([broken, fixed]);
    expect(local.versions).toHaveLength(1);
  });

  it("keeps a draft the screenshot look stopped from publishing, until it is checked again unchanged", async () => {
    const { scope, versions, drafts } = chat(() => ({ ...report([]), screenshot: "SHOT", text: "Prices" }));
    let looks = 0;
    scope.look = async () => (looks++, { look: { by: "Jev", verdict: "blank", probability: 0.95 } });
    const { id } = await writeDraft(scope, { html: fixed });
    const first = await checkDraft(scope, id, {});
    expect(first.report?.errors).toEqual([expect.stringContaining("looks blank")]);
    const why = "The screenshot looks blank (Jev, 95% sure)";
    expect(await drafts.get(id)).toMatchObject({ errors: 1, lookStopped: why });
    await expect(publishDraft(scope, { title: "Prices", draftId: id })).rejects.toThrow("found 1 error");
    // Written again unchanged, the page keeps what stopped it.
    expect(await writeDraft(scope, { html: fixed })).toMatchObject({ lookStopped: why });
    const again = await checkDraft(scope, id, {});
    expect(again.draft).toMatchObject({ errors: 0, warnings: 1, lookStopped: why });
    expect(looks).toBe(1);
    await publishDraft(scope, { title: "Prices", draftId: id });
    expect(versions).toEqual([{ id: undefined, html: fixed }]);
  });
});

describe("writeDraft", () => {
  it("saves a new page unchecked, and refuses mixed or missing input", async () => {
    const { scope, checked } = chat(() => report([]));
    expect(await writeDraft(scope, { html: "<p>a</p>" })).toMatchObject({ id: await draftId("<p>a</p>", {}), errors: null, bytes: 8 });
    expect(checked).toEqual([]);
    await expect(writeDraft(scope, { draftId: "0000000000000001", edits: [] })).rejects.toThrow("No draft");
    await expect(writeDraft(scope, { html: "<p>a</p>", edits: [{ old: "a", new: "b" }] })).rejects.toThrow("not both");
    await expect(writeDraft(scope, { html: "<p>a</p>", version: 1 })).rejects.toThrow("with artifact_id alone");
    await expect(writeDraft(scope, {})).rejects.toThrow("Pass a new page as html");
  });

  it("keeps how a page's check went when the same page is written again", async () => {
    const { scope, drafts } = chat(() => report([]));
    const id = await draftId("<p>a</p>", {});
    await drafts.save({ id, html: "<p>a</p>", manifest: {} }, { errors: 0, warnings: 1 });
    expect(await writeDraft(scope, { html: "<p>a</p>" })).toMatchObject({ id, errors: 0, warnings: 1 });
  });

  it("edits an artifact's latest version, or the version named, and restores one with no edits", async () => {
    const { scope } = chat(() => report([]));
    scope.artifacts.readHtml = async (_id: string, version: number) => (version <= 2 ? `<p>v${version}</p>` : null);
    expect(await writeDraft(scope, { artifact: a1, edits: [{ old: "v2", new: "v3" }] })).toMatchObject({ html: "<p>v3</p>", artifactId: "a1" });
    expect(await writeDraft(scope, { artifact: a1, version: 1 })).toMatchObject({ html: "<p>v1</p>", artifactId: "a1" });
    await expect(writeDraft(scope, { artifact: a1, version: 5 })).rejects.toThrow("has versions 1 to 2");
  });
});

describe("skill files in pages", () => {
  const page = '<html><head><script src="skill:kit/dist/ds.js"></script></head><body><div id="app"></div></body></html>';
  const files = { "kit/dist/ds.js": "window.DS = 1; // </script> inside" };

  it("keeps the reference in the draft, checks and publishes the page with the file inlined", async () => {
    const { scope, versions, checked } = chat(() => report([]), false, files);
    const draft = await writeDraft(scope, { html: page });
    expect(draft.html).toBe(page);
    await checkDraft(scope, draft.id, {});
    expect(checked[0]).toContain('<script data-skill-file="kit/dist/ds.js">window.DS = 1; // <\\/script> inside</script>');
    await publishDraft(scope, { title: "Kit", draftId: draft.id });
    expect(versions[0].html).toBe(checked[0]);
  });

  it("publishes the skill files the check ran with, or nothing once the skill was imported again", async () => {
    const skillSet = { id: "0123456789abcdef" };
    const { scope, versions } = chat(() => report([]), false, files, skillSet);
    const draft = await writeDraft(scope, { html: page });
    expect(draft.skillSets).toEqual({ kit: "0123456789abcdef" });
    await checkDraft(scope, draft.id, {});
    skillSet.id = "fedcba9876543210";
    await expect(publishDraft(scope, { title: "Kit", draftId: draft.id })).rejects.toThrow(/imported again or deleted since this draft was saved/);
    expect(versions).toEqual([]);
    const again = await writeDraft(scope, { draftId: draft.id, edits: [] });
    expect(again.id).not.toBe(draft.id);
    expect(again.errors).toBeNull();
  });

  it("refuses to save a page naming a file the skill does not have", async () => {
    const { scope } = chat(() => report([]), false, {});
    await expect(writeDraft(scope, { html: page })).rejects.toThrow(/Not saved\. No such skill file: skill:kit\/dist\/ds\.js/);
  });

  it("edits a published version as the agent reads it: with references, not the inlined file", async () => {
    const { scope, versions } = chat(() => report([]), true, files);
    await publishDraft(scope, { title: "Kit", draftId: (await writeDraft(scope, { html: page })).id });
    expect(versions[0].html).toContain("window.DS = 1");
    (scope.artifacts as unknown as { readHtml: () => Promise<string> }).readHtml = async () => versions[0].html;
    const edited = await writeDraft(scope, { artifact: a1, edits: [{ old: '<div id="app"></div>', new: '<div id="app" class="x"></div>' }] });
    expect(edited.html).toBe(page.replace('<div id="app">', '<div id="app" class="x">'));
  });

  it("keeps a file inlined when its skill no longer has it, so the published page can still be edited", async () => {
    const mine: Record<string, string> = { ...files };
    const { scope, versions } = chat(() => report([]), true, mine);
    await publishDraft(scope, { title: "Kit", draftId: (await writeDraft(scope, { html: page })).id });
    (scope.artifacts as unknown as { readHtml: () => Promise<string> }).readHtml = async () => versions[0].html;
    delete mine["kit/dist/ds.js"];
    const edited = await writeDraft(scope, { artifact: a1, edits: [{ old: '<div id="app"></div>', new: '<div id="app" class="x"></div>' }] });
    expect(edited.html).toContain('<script data-skill-file="kit/dist/ds.js">window.DS = 1;');
    expect(edited.skillSets).toBeUndefined();
  });

  it("reports the check's errors at the lines of the draft, not of the page with the files in it", async () => {
    const lines: number[] = [];
    const { scope } = chat(() => report([]), false, { "kit/dist/ds.js": "a\nb\nc\nd" });
    scope.checkPage = async (input) => {
      lines.push(...[1, 3, 5, 6].map((line) => input.pageLine?.(line) ?? line));
      return report([]);
    };
    const draft = await writeDraft(scope, { html: `<head>\n${page.slice("<html><head>".length)}\n<p>after</p>` });
    await checkDraft(scope, draft.id, {});
    expect(lines).toEqual([1, 2, 2, 3]);
  });
});

describe("applyEdits", () => {
  const page = "<h1>Prices</h1><p>a</p><p>a</p>";

  it("applies each edit in order, to the page as the edits before left it", () => {
    expect(
      applyEdits(page, [
        { old: "Prices", new: "Rates" },
        { old: "<h1>Rates", new: "<h2>Rates" },
      ]),
    ).toBe("<h2>Rates</h1><p>a</p><p>a</p>");
    expect(applyEdits(page, [])).toBe(page);
  });

  it("refuses text that is missing, empty or not unique, naming each edit", () => {
    expect(() => applyEdits(page, [{ old: "<p>a</p>", new: "" }])).toThrow("edit 1: its old text occurs more than once");
    expect(() =>
      applyEdits(page, [
        { old: "Prices", new: "x" },
        { old: "nope", new: "" },
        { old: "", new: "y" },
      ]),
    ).toThrow(/edit 2: its old text is not in the page; edit 3: its old text is not in the page \(it is empty\)/);
  });
});

describe("checkInBrowser", () => {
  it("turns a check that ran out of time into a report with one error and no screenshot", async () => {
    const { scope } = chat(() => new CheckTimedOut("the check did not finish in 60 s"));
    const { report } = await checkInBrowser(scope, { html: "<p>x</p>", manifest: {}, viewport: "mobile" });
    expect(report?.errors).toEqual([expect.stringContaining("the check did not finish in 60 s")]);
    expect(report).toMatchObject({ screenshot: "", thumb: "", width: 390 });
  });
});

describe("FailedChecks", () => {
  it(`stops checks after ${MAX_FAILED_CHECKS} failed in a row, until one passes or the user writes`, () => {
    const checks = new FailedChecks();
    for (let n = 1; n < MAX_FAILED_CHECKS; n++) expect(checks.record(true)).toBe("");
    expect(checks.record(true)).toContain("do not check again");
    checks.record(true, "0000000000000001");
    expect(() => checks.allow()).toThrow(/draft "0000000000000001"/);
    checks.reset();
    expect(() => checks.allow()).not.toThrow();
    checks.record(true);
    checks.record(false);
    for (let n = 1; n < MAX_FAILED_CHECKS; n++) checks.record(true);
    expect(() => checks.allow()).not.toThrow();
  });

  it("refuses a whole new page once after a check found errors, until a check passes or the user writes", () => {
    const checks = new FailedChecks();
    expect(checks.refuseRewrite()).toBeUndefined();
    checks.record(true, "0000000000000001");
    // A check no browser ran counts without changing which draft is broken.
    checks.record(true);
    expect(checks.refuseRewrite()).toBe("0000000000000001");
    expect(checks.refuseRewrite()).toBeUndefined();
    checks.record(true, "0000000000000002");
    expect(checks.refuseRewrite()).toBe("0000000000000002");
    checks.record(true, "0000000000000003");
    checks.record(false);
    expect(checks.refuseRewrite()).toBeUndefined();
    checks.record(true, "0000000000000004");
    checks.reset();
    expect(checks.refuseRewrite()).toBeUndefined();
  });
});
