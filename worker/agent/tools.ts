import { Type } from "@earendil-works/pi-ai";
import { exports } from "cloudflare:workers";
import { defineExtension, defineTool, section, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { createTwoFilesPatch } from "diff";
import {
  CHECK_TOOL,
  isOwnedBy,
  manifestOf,
  PUBLISH_TOOL,
  type ArtifactManifest,
  type ArtifactMeta,
  type ArtifactSummary,
  type CheckedDetails,
  type PublishedDetails,
  type SavedFilesDetails,
} from "../../shared/protocol.ts";
import { MAX_SKILL_DESCRIPTION, type SkillInput, type SkillResult } from "../../shared/skills.ts";
import { canonicalJson } from "../../shared/canonical.ts";
import { formatBytes, listSome, plural, sha256Hex } from "../../shared/util.ts";
import { BrowserUnavailable } from "../artifacts/browser.ts";
import { describeReport, type CheckInput, type CheckReport } from "../artifacts/check.ts";
import { checkManifest, MAX_HTML_BYTES } from "../artifacts/manifest.ts";
import { FILES_WRITE_TOOL, RUN_BASH_TOOL, RUN_PYTHON_TOOL, SANDBOX_OUT, savedReport, wroteReport } from "../chat-traces.ts";
import type { McpHub } from "../mcp/hub.ts";
import type { SandboxFile, SandboxRun } from "../sandbox.ts";
import { literalPath, normalisePath, PathError, type ArtifactStore, type FileEntry, type UserFiles } from "../storage/index.ts";
import { FileRefError, MAX_SANDBOX_BYTES, resolveFile, resolveRef, sandboxLayout } from "./file-refs.ts";
import { clip, MAX_TOOL_TEXT, text } from "./output.ts";

/** What the tools need from the chat they run in. */
export interface ChatScope {
  uid: string;
  chatId: string;
  hub: McpHub;
  artifacts: ArtifactStore;
  /** This chat's user's files: scoped to the uid and encrypted with that user's key. */
  files: () => Promise<UserFiles>;
  onPublished(artifact: Omit<ArtifactSummary, "chatId">): Promise<void>;
  /** Whether the owner named this artifact from another of their chats with "@" here, so the agent may read it. */
  broughtIn(id: string): boolean;
  /** Save a skill for the user, turned off until they turn it on. */
  proposeSkill(skill: SkillInput): Promise<SkillResult>;
  /** Render a page in a headless browser and report on it (worker/artifacts/check.ts). Throws BrowserUnavailable without one. */
  checkPage(input: CheckInput): Promise<CheckReport>;
}

/**
 * The stored paths `refs` name, from one listing of the user's files (see
 * resolveRef). The listing stops at MAX_LISTED files, so a ref it cannot
 * match is still tried as a path as it is: reading that path, if it is not
 * there either, throws `missing(path)`, which says why the ref matched nothing.
 */
async function findFiles(files: UserFiles, refs: readonly string[], resolve: (entries: FileEntry[], ref: string) => string[]) {
  const entries = await files.list();
  const paths = new Set<string>();
  const unmatched = new Map<string, FileRefError>();
  for (const ref of new Set(refs)) {
    try {
      for (const path of resolve(entries, ref)) paths.add(path);
    } catch (error) {
      const literal = literalPath(ref);
      if (!(error instanceof FileRefError) || literal === undefined) throw error;
      paths.add(literal);
      unmatched.set(literal, error);
    }
  }
  return { entries, paths: [...paths], missing: (path: string) => unmatched.get(path) ?? new Error(`No file "${path}".`) };
}

export function filesExtension(scope: ChatScope): Extension {
  return defineExtension({
    name: "files",
    tools: [
      defineTool({
        name: "files_list",
        description: "List the user's files (uploads, kept in their folders under uploads/, and files your scripts saved), with sizes.",
        parameters: Type.Object({ folder: Type.Optional(Type.String({ description: "Only files in this folder, e.g. uploads or uploads/reports." })) }),
        replay: "safe",
        execute: async (args) => {
          const entries = await (await scope.files()).list(args.folder ?? "");
          const lines = entries.map((e) => `${e.path}\t${formatBytes(e.size)}`);
          return { output: text(clip(lines.length ? lines.join("\n") : "No files.")) };
        },
      }),
      defineTool({
        name: "files_read",
        description:
          `Read one of the user's files as UTF-8 text (the first ${MAX_TOOL_TEXT.toLocaleString("en")} characters). ` +
          "Takes its path, or its name or the end of its path when only one file matches.",
        parameters: Type.Object({ path: Type.String() }),
        replay: "safe",
        execute: async (args) => {
          const files = await scope.files();
          // Only what clip() can show: at most 4 bytes per character.
          const range = { offset: 0, length: MAX_TOOL_TEXT * 4 };
          // A stored path names itself (resolveFile would pick it too): read it without listing every file first.
          const literal = literalPath(args.path);
          let path = literal;
          let object = path === undefined ? null : await files.get(path, range);
          if (!object) {
            const found = await findFiles(files, [args.path], (entries, ref) => [resolveFile(entries, ref)]);
            path = found.paths[0];
            // The listing did not match it either and fell back to the path just read: it is not there.
            object = path === literal ? null : await files.get(path, range);
            if (!object) throw found.missing(path);
          }
          const content = clip(await object.text());
          return { output: text(path === args.path ? content : `${path}:\n${content}`) };
        },
      }),
      defineTool({
        name: FILES_WRITE_TOOL,
        description: "Write a UTF-8 text file into the user's files, replacing any file at that path.",
        parameters: Type.Object({ path: Type.String(), content: Type.String() }),
        execute: async (args) => {
          const path = await (await scope.files()).put(args.path, args.content, "text/plain; charset=utf-8");
          return { output: text(wroteReport(path, args.content.length)), details: { saved: [path] } satisfies SavedFilesDetails };
        },
      }),
    ],
  });
}

/** The prompt's list of the user's files (see filesIndex), installed again whenever it changes. */
export function filesIndexExtension(index: string): Extension {
  return defineExtension({ name: "files-index", sections: [section("user_files", () => index)] });
}

const SANDBOX_FILES =
  "Files you name are copied from the user's files into ./files/, in their folders but without the leading uploads/ " +
  "(uploads/q3/sales.csv is ./files/q3/sales.csv, out/report.csv is ./files/out/report.csv). " +
  "Anything written to ./out/ (top level, not subfolders) is saved back to the user's files under out/. " +
  "Each run starts with fresh ./files and ./out; other files under the working directory stay while the sandbox is up (10 minutes after the last run). " +
  "Returns exit code, stdout and stderr.";

/** The files `refs` name, read, keyed by where they go under ./files/ (see sandboxLayout). */
async function sandboxInputs(files: UserFiles, refs: readonly string[]): Promise<SandboxFile[]> {
  if (refs.length === 0) return [];
  const { entries, paths, missing } = await findFiles(files, refs, resolveRef);
  const layout = sandboxLayout(paths);
  const sizes = new Map(entries.map((e) => [e.path, e.size]));
  const listedBytes = paths.reduce((sum, path) => sum + (sizes.get(path) ?? 0), 0);
  if (listedBytes > MAX_SANDBOX_BYTES) throw new Error(tooMuch(listedBytes));
  // Paths past the end of the listing had no size above: they count as they come, before their body is read.
  let unlisted = 0;
  // Once one file fails the run is refused: the others still opening are not read.
  let failed = false;
  return Promise.all(
    [...layout].map(async ([name, path]): Promise<SandboxFile> => {
      const object = await files.get(path);
      if (!object) {
        failed = true;
        throw missing(path);
      }
      let error: Error | undefined;
      if (failed) error = new Error("Another file failed.");
      else if (!sizes.has(path) && listedBytes + (unlisted += object.size) > MAX_SANDBOX_BYTES) error = new Error(tooMuch(listedBytes + unlisted));
      if (error) {
        failed = true;
        // Thrown before the cancel settles, so the first failure is the one Promise.all reports.
        void object.body.cancel().catch(() => {});
        throw error;
      }
      // Each body is read as soon as it opens: a Worker keeps only a few connections open at once.
      return { name, bytes: await object.arrayBuffer() };
    }),
  );
}

function tooMuch(bytes: number): string {
  return `Those files hold ${formatBytes(bytes)}; one run takes at most ${formatBytes(MAX_SANDBOX_BYTES)}. Pass fewer.`;
}

/** The name of a chat's sandbox object. */
export function sandboxName(uid: string, chatId: string): string {
  return `${uid}-${chatId}`;
}

/**
 * Copy the named user files in, run in this chat's sandbox, save ./out back to
 * the user's files. The files go through the user's UserFiles, so they are
 * decrypted on the way in and encrypted with the user's key on the way out.
 */
async function runInSandbox(scope: ChatScope, refs: string[] | undefined, run: (sandbox: ReturnType<typeof exports.Sandbox.getByName>, inputs: SandboxFile[]) => Promise<SandboxRun>) {
  const files = await scope.files();
  const inputs = await sandboxInputs(files, refs ?? []);
  const result = await run(exports.Sandbox.getByName(sandboxName(scope.uid, scope.chatId)), inputs);
  const toSave = new Map<string, ArrayBuffer>();
  const skipped = [];
  for (const output of result.outputs) {
    // A name the user's files do not allow must not throw away the run's output and the files already saved.
    try {
      // Names that differ only in what normalising trims ("a.csv" and "a.csv ") would overwrite each other.
      const path = normalisePath(`${SANDBOX_OUT}${output.name}`);
      if (toSave.has(path)) skipped.push(`${output.name} (same file as ${path})`);
      else toSave.set(path, output.bytes);
    } catch (error) {
      if (!(error instanceof PathError)) throw error;
      skipped.push(`${output.name} (${error.message})`);
    }
  }
  const saved = await Promise.all([...toSave].map(([path, bytes]) => files.put(path, bytes)));
  const report = [
    inputs.length && `copied in: ${listSome(inputs.map((input) => `./files/${input.name}`), 20)}`,
    `exit code ${result.exitCode}`,
    `stdout:\n${result.stdout}`,
    result.stderr && `stderr:\n${result.stderr}`,
    ...savedReport(saved, skipped),
  ];
  return { output: text(clip(report.filter(Boolean).join("\n\n"))), details: { saved } satisfies SavedFilesDetails, isError: result.exitCode !== 0 };
}

const inputFiles = Type.Optional(
  Type.Array(Type.String(), {
    description: "The user's files to copy in: paths, a file's name or the end of its path when only one file matches, or a folder for every file in it.",
  }),
);

export function sandboxExtension(scope: ChatScope): Extension {
  return defineExtension({
    name: "sandbox",
    tools: [
      defineTool({
        name: RUN_PYTHON_TOOL,
        description: `Run a Python 3.13 script (pandas and numpy installed) in this chat's isolated Linux sandbox: no internet, 60 s limit. ${SANDBOX_FILES}`,
        parameters: Type.Object({ code: Type.String(), files: inputFiles }),
        execute: async (args) => runInSandbox(scope, args.files, (sandbox, inputs) => sandbox.runPython(args.code, inputs)),
      }),
      defineTool({
        name: RUN_BASH_TOOL,
        description:
          "Run a bash script in the same sandbox as run_python (Debian with coreutils, grep, sed, awk, tar, gzip, python3): no internet, so no package installs or downloads; 60 s limit. " +
          `Runs as written; start with set -e to stop at the first failing command. ${SANDBOX_FILES}`,
        parameters: Type.Object({ script: Type.String(), files: inputFiles }),
        execute: async (args) => runInSandbox(scope, args.files, (sandbox, inputs) => sandbox.runBash(args.script, inputs)),
      }),
    ],
  });
}

export interface PublishInput {
  title: string;
  html: string;
  artifactId?: string;
  mcp?: NonNullable<ArtifactManifest["mcp"]>["servers"];
  message?: string;
}

/** The manifest a page declares, checked against the chat's servers, and the page's size. Throws with what to fix. */
async function validPage(scope: ChatScope, html: string, mcp: PublishInput["mcp"], what: string): Promise<ArtifactManifest> {
  if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) throw new Error("The page is over 2 MB; summarise the data instead of inlining it.");
  const manifest: ArtifactManifest = mcp?.length ? { mcp: { servers: mcp } } : {};
  const problems = await checkManifest(scope.hub, manifest);
  if (problems.length) throw new Error(`${what} Fix the mcp declaration:\n${problems.join("\n")}`);
  return manifest;
}

/** Store a new version with its checked manifest and index it for the user. */
async function publishArtifact(scope: ChatScope, input: PublishInput, manifest: ArtifactManifest): Promise<ArtifactMeta> {
  const meta = await scope.artifacts.publishVersion({
    id: input.artifactId,
    ownerUid: scope.uid,
    chatId: scope.chatId,
    title: input.title,
    html: input.html,
    manifest,
    message: input.message,
  });
  await scope.onPublished({ id: meta.id, title: meta.title, latest: meta.latest, updatedAt: meta.updatedAt });
  return meta;
}

/**
 * An artifact of this chat, or one of the owner's from another chat that the owner named here with "@": the agent may
 * read it, but publishes a new version only of this chat's (ArtifactStore.publishVersion). Anything else reads as missing.
 */
async function ownArtifact(scope: ChatScope, id: string): Promise<ArtifactMeta> {
  const meta = await scope.artifacts.readMeta(id);
  const readable = meta && (isOwnedBy(meta, scope.uid, scope.chatId) || (meta.ownerUid === scope.uid && scope.broughtIn(meta.id)));
  if (!readable) throw new Error(`No artifact ${id} in this chat. One from another chat must be named with @ by the chat's owner first.`);
  return meta;
}

const mcpParameter = Type.Optional(
  Type.Array(Type.Object({ server: Type.String(), tools: Type.Array(Type.String()) }), {
    description: 'e.g. [{"server": "CoinGecko", "tools": ["execute"]}]',
  }),
);

/**
 * The pages that passed a check in this chat lately, by an id the check gives the agent: it publishes one by that id,
 * rather than writing the whole page again, and a page sent again as it is needs no second check. Kept in memory, so a
 * restarted chat object has forgotten them, and the agent sends the page again.
 */
export class CheckedPages {
  static readonly MAX = 8;
  readonly #pages = new Map<string, { html: string; manifest: ArtifactManifest }>();

  /** The id of a page and its manifest: the start of a SHA-256 of both. */
  static async id(html: string, manifest: ArtifactManifest): Promise<string> {
    return (await sha256Hex(`${canonicalJson(manifest)}\u0000${html}`)).slice(0, 16);
  }

  get(id: string) {
    return this.#pages.get(id);
  }

  add(id: string, html: string, manifest: ArtifactManifest): void {
    this.#pages.delete(id);
    this.#pages.set(id, { html, manifest });
    if (this.#pages.size > CheckedPages.MAX) this.#pages.delete(this.#pages.keys().next().value!);
  }
}

/** What came of a publish: the version, else the check's report on why there is none. */
export interface PublishOutcome {
  meta?: ArtifactMeta;
  /** The check run here, if the page had not passed one already. */
  report?: CheckReport;
  /** Why no browser checked the page, when none did. */
  unchecked?: string;
}

/**
 * Publish a page, but only one without errors: one that passed a check as it is now, or passes one here. Without a
 * browser to check in, the page is published unchecked, and the outcome says why.
 */
export async function publishChecked(scope: ChatScope, input: PublishInput, checked = new CheckedPages()): Promise<PublishOutcome> {
  const manifest = await validPage(scope, input.html, input.mcp, "Not published.");
  const id = await CheckedPages.id(input.html, manifest);
  if (checked.get(id)) return { meta: await publishArtifact(scope, input, manifest) };
  let report: CheckReport;
  try {
    report = await scope.checkPage({ html: input.html, manifest });
  } catch (error) {
    if (!(error instanceof BrowserUnavailable)) throw error;
    return { meta: await publishArtifact(scope, input, manifest), unchecked: error.message };
  }
  if (report.errors.length) return { report };
  checked.add(id, input.html, manifest);
  return { meta: await publishArtifact(scope, input, manifest), report };
}

/** What a check's result gives the model: a line on what came of it, the report, then the screenshot. */
function checkOutput(headline: string, report: CheckReport) {
  const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = text(clip(`${headline}\n\n${describeReport(report)}`));
  content.push({ type: "image", data: report.screenshot, mimeType: "image/jpeg" });
  return content;
}

function checkedDetails(report: CheckReport): CheckedDetails {
  return { thumb: report.thumb, errors: report.errors.length, warnings: report.warnings.length };
}

function passedLine(report: CheckReport): string {
  return `The check passed${report.warnings.length ? ` with ${plural(report.warnings.length, "warning")}` : ""}.`;
}

export function artifactExtension(scope: ChatScope): Extension {
  const checked = new CheckedPages();
  return defineExtension({
    name: "artifacts",
    tools: [
      defineTool({
        name: CHECK_TOOL,
        description:
          "Render a page in a headless browser before publishing it, with its live MCP calls answered as the viewer's would be (read-only tools only; " +
          "a write tool gets a not_granted error instead of running). Returns errors (uncaught exceptions, console errors, blocked or failed loads, " +
          "calls the page got wrong, failed tests), warnings, how the live calls went, the visible text and a screenshot. Nothing is published, " +
          "so fixing and checking again uses up no versions. A page that passes gets a check_id to publish it by. " +
          "Pass `tests`: a few short checks of what the page must show once its data arrived.",
        parameters: Type.Object({
          html: Type.String({ description: "The page, exactly as you would publish it." }),
          mcp: mcpParameter,
          tests: Type.Optional(
            Type.Array(
              Type.Object({
                name: Type.String({ description: 'What it checks, e.g. "price table has rows".' }),
                run: Type.String({
                  description:
                    "The body of an async function run in the page after it settled: throw (or return false) to fail, return a string to report a value. " +
                    'e.g. "const rows = document.querySelectorAll(\'#prices tbody tr\').length; if (rows < 1) throw new Error(\'no rows\'); return rows + \' rows\';"',
                }),
              }),
              { maxItems: 10 },
            ),
          ),
          viewport: Type.Optional(Type.Union([Type.Literal("desktop"), Type.Literal("mobile")], { description: "desktop (1280 wide, the default) or mobile (390 wide)." })),
        }),
        execute: async (args) => {
          const manifest = await validPage(scope, args.html, args.mcp, "Not checked.");
          let report: CheckReport;
          try {
            report = await scope.checkPage({ html: args.html, manifest, tests: args.tests, viewport: args.viewport });
          } catch (error) {
            if (!(error instanceof BrowserUnavailable)) throw error;
            return { output: text(`The page could not be checked: ${error.message}. Publish it with its html; it is published unchecked.`) };
          }
          const failed = report.errors.length > 0;
          let headline = `The check found ${plural(report.errors.length, "error")}. Fix them and check again; nothing was published.`;
          if (!failed) {
            const id = await CheckedPages.id(args.html, manifest);
            checked.add(id, args.html, manifest);
            headline = `${passedLine(report)} To publish this page, call ${PUBLISH_TOOL} with check_id "${id}" instead of html and mcp.`;
          }
          return { output: checkOutput(headline, report), details: { check: checkedDetails(report) }, isError: failed };
        },
      }),
      defineTool({
        name: PUBLISH_TOOL,
        description:
          "Publish an HTML page as an artifact the user sees in the preview panel. Pass artifact_id to publish a new version of an artifact " +
          "you published in this chat; omit it to create a new one (also to build on an artifact from another chat, which stays as it is). Declare in `mcp` every server and tool the page calls; the page can call nothing else. " +
          `Pass check_id from a passed ${CHECK_TOOL} instead of html and mcp; a page sent as html that has not passed a check gets checked first, and is not published while the check finds errors.`,
        parameters: Type.Object({
          title: Type.String({ description: "Two to five words." }),
          check_id: Type.Optional(Type.String({ description: `The page that passed ${CHECK_TOOL}, with what it declared.` })),
          html: Type.Optional(Type.String({ description: "The page: a full HTML document, or a body fragment. Leave out with check_id." })),
          artifact_id: Type.Optional(Type.String()),
          message: Type.Optional(
            Type.String({ description: "One line on what this version changes, e.g. \"Add a 7-day sparkline\". It becomes the version's commit message." }),
          ),
          mcp: mcpParameter,
        }),
        execute: async (args): Promise<ToolExecutionResult<Partial<PublishedDetails>>> => {
          let page: { html: string; mcp: PublishInput["mcp"] };
          if (args.check_id !== undefined) {
            if (args.html !== undefined || args.mcp !== undefined) throw new Error("Pass check_id alone, or the page as html with its mcp: not both.");
            const passed = checked.get(args.check_id);
            if (!passed) throw new Error(`No passed check "${args.check_id}" is kept any more. Send the page as html, with its mcp.`);
            page = { html: passed.html, mcp: passed.manifest.mcp?.servers };
          } else if (args.html !== undefined) page = { html: args.html, mcp: args.mcp };
          else throw new Error("Pass check_id, or the page as html.");
          const outcome = await publishChecked(scope, { title: args.title, artifactId: args.artifact_id, message: args.message, ...page }, checked);
          const { meta, report } = outcome;
          if (!meta) {
            const headline = `Not published: the check found ${plural(report!.errors.length, "error")}. No version was made; fix them and publish again.`;
            return { output: checkOutput(headline, report!), details: { check: checkedDetails(report!) }, isError: true };
          }
          const done =
            `Published artifact ${meta.id} version ${meta.latest} ("${meta.title}"). The user now sees it in the preview panel.` +
            (outcome.unchecked ? ` It was not checked in a browser: ${outcome.unchecked}.` : "");
          const details: PublishedDetails = { artifactId: meta.id, version: meta.latest, title: meta.title, ...(report && { check: checkedDetails(report) }) };
          return { output: report ? checkOutput(`${done} ${passedLine(report)}`, report) : text(done), details };
        },
      }),
      defineTool({
        name: "artifact_read",
        description: "Read the HTML of an artifact published in this chat, to revise it, or of one the user named with @ from another of their chats, to build on it.",
        parameters: Type.Object({ artifact_id: Type.String(), version: Type.Optional(Type.Number()) }),
        replay: "safe",
        execute: async (args) => {
          const meta = await ownArtifact(scope, args.artifact_id);
          const version = args.version ?? meta.latest;
          const html = await scope.artifacts.readHtml(meta.id, version);
          if (html === null) throw new Error(`Artifact ${meta.id} has no version ${version}.`);
          const declared = JSON.stringify(manifestOf(meta, version) ?? {});
          return { output: text(`Version ${version} of ${meta.latest}, manifest ${declared}:\n\n${html}`) };
        },
      }),
      defineTool({
        name: "artifact_history",
        description: "List the versions of an artifact published in this chat (or named with @ from another): when each was published and what it changed.",
        parameters: Type.Object({ artifact_id: Type.String() }),
        replay: "safe",
        execute: async (args) => {
          const meta = await ownArtifact(scope, args.artifact_id);
          const lines = meta.versions.map((v) => `v${v.version}  ${new Date(v.publishedAt).toISOString()}  ${v.message ?? "(no message)"}`);
          return { output: text(`"${meta.title}", ${meta.latest} versions, newest last:\n${lines.join("\n")}`) };
        },
      }),
      defineTool({
        name: "artifact_diff",
        description: "Show what changed in an artifact's page between two versions, as a unified diff. Defaults to the latest version against the one before.",
        parameters: Type.Object({ artifact_id: Type.String(), from: Type.Optional(Type.Number()), to: Type.Optional(Type.Number()) }),
        replay: "safe",
        execute: async (args) => {
          const meta = await ownArtifact(scope, args.artifact_id);
          const to = args.to ?? meta.latest;
          const from = args.from ?? to - 1;
          const [before, after] = await Promise.all([scope.artifacts.readHtml(meta.id, from), scope.artifacts.readHtml(meta.id, to)]);
          if (before === null || after === null) throw new Error(`Artifact ${meta.id} has versions 1 to ${meta.latest}.`);
          const patch = createTwoFilesPatch(`v${from}/index.html`, `v${to}/index.html`, before, after, undefined, undefined, { context: 3 });
          return { output: text(clip(patch)) };
        },
      }),
    ],
  });
}

export function skillsExtension(scope: ChatScope): Extension {
  return defineExtension({
    name: "skill-proposals",
    tools: [
      defineTool({
        name: "skill_propose",
        description:
          "Save a reusable way of working as one of the user's skills, when the user asks for that (\"save this as a skill\", \"remember how to do this\"). " +
          "It is saved turned off; the user reviews and turns it on under Skills in the sidebar, and from then on it is offered in all their chats. " +
          "Write the instructions as steps and guardrails that work in a new chat, without this conversation's specifics unless they are the point.",
        parameters: Type.Object({
          name: Type.String({ description: 'Lowercase words joined by hyphens, e.g. "weekly-report".' }),
          description: Type.String({ description: `When to use the skill, in one or two sentences starting "Use when". Up to ${MAX_SKILL_DESCRIPTION} characters.` }),
          instructions: Type.String({ description: "Markdown: the steps, then the guardrails." }),
          tools: Type.Optional(Type.Array(Type.String(), { description: "The agent tool names the skill works with." })),
        }),
        execute: async (args) => {
          const saved = await scope.proposeSkill({ name: args.name, description: args.description, instructions: args.instructions, tools: args.tools ?? [] });
          if ("error" in saved) throw new Error(`Not saved: ${saved.error}`);
          return { output: text(`Saved the skill "${saved.name}", turned off. Tell the user to review it and turn it on under Skills in the sidebar.`) };
        },
      }),
    ],
  });
}
