import { Type } from "@earendil-works/pi-ai";
import { exports } from "cloudflare:workers";
import { defineExtension, defineTool, section, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { createTwoFilesPatch } from "diff";
import {
  CHECK_TOOL,
  DRAFTS_TOOL,
  isOwnedBy,
  manifestOf,
  PUBLISH_TOOL,
  type ArtifactMeta,
  type CheckedDetails,
  type PublishedDetails,
  type SavedFilesDetails,
} from "../../shared/protocol.ts";
import { MAX_SKILL_DESCRIPTION, type SkillInput, type SkillResult } from "../../shared/skills.ts";
import { formatBytes, listSome, plural } from "../../shared/util.ts";
import { describeReport, type CheckReport } from "../artifacts/check.ts";
import { FILES_WRITE_TOOL, RUN_BASH_TOOL, RUN_PYTHON_TOOL, SANDBOX_OUT, savedReport, wroteReport } from "../chat-traces.ts";
import type { SandboxFile, SandboxRun } from "../sandbox.ts";
import { draftId, literalPath, MAX_DRAFTS, normalisePath, PathError, type FileEntry, type UserFiles } from "../storage/index.ts";
import { checkInBrowser, draftCheck, draftLine, publishChecked, validPage, type PublishInput, type PublishScope } from "./publish.ts";
import { FileRefError, MAX_SANDBOX_BYTES, resolveFile, resolveRef, sandboxLayout } from "./file-refs.ts";
import { clip, MAX_TOOL_TEXT, text } from "./output.ts";

/** What the tools need from the chat they run in. */
export interface ChatScope extends PublishScope {
  /** This chat's user's files: scoped to the uid and encrypted with that user's key. */
  files: () => Promise<UserFiles>;
  /** Whether the owner named this artifact from another of their chats with "@" here, so the agent may read it. */
  broughtIn(id: string): boolean;
  /** Save a skill for the user, turned off until they turn it on. */
  proposeSkill(skill: SkillInput): Promise<SkillResult>;
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

/** An artifact of this chat, the only kind a publish can add a version to (ArtifactStore.publishVersion). */
async function chatArtifact(scope: ChatScope, id: string): Promise<ArtifactMeta> {
  const meta = await scope.artifacts.readMeta(id);
  if (!meta || !isOwnedBy(meta, scope.uid, scope.chatId)) throw new Error(`No artifact ${id} in this chat to publish a new version of. Check the page without artifact_id to make a new artifact.`);
  return meta;
}

const mcpParameter = Type.Optional(
  Type.Array(Type.Object({ server: Type.String(), tools: Type.Array(Type.String()) }), {
    description: 'e.g. [{"server": "CoinGecko", "tools": ["execute"]}]',
  }),
);

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
          artifact_id: Type.Optional(Type.String({ description: "The artifact of this chat this page is a new version of: publishing the page goes there, unless the publish names another or new_artifact." })),
        }),
        execute: async (args) => {
          if (args.artifact_id !== undefined) await chatArtifact(scope, args.artifact_id);
          const manifest = await validPage(scope, args.html, args.mcp, "Not checked.");
          const [id, drafts, checked] = await Promise.all([
            draftId(args.html, manifest),
            scope.drafts(),
            checkInBrowser(scope, { html: args.html, manifest, tests: args.tests, viewport: args.viewport }),
          ]);
          const { report, unchecked } = checked;
          await drafts.save({ id, html: args.html, manifest, artifactId: args.artifact_id }, draftCheck(report));
          if (!report) {
            const next = scope.publishUnchecked
              ? "Publish it with its html; it is published unchecked."
              : "A page is published only once a check passes: check it again in a while.";
            return { output: text(`The page could not be checked: ${unchecked}. It is saved as draft "${id}"; nothing was published. ${next}`) };
          }
          const failed = report.errors.length > 0;
          const headline = failed
            ? `The check found ${plural(report.errors.length, "error")}. The page is saved as draft "${id}"; fix them and check again. Nothing was published.`
            : `${passedLine(report)} To publish this page, call ${PUBLISH_TOOL} with check_id "${id}" instead of html and mcp.`;
          return { output: checkOutput(headline, report), details: { check: checkedDetails(report) }, isError: failed };
        },
      }),
      defineTool({
        name: PUBLISH_TOOL,
        description:
          "Publish an HTML page as an artifact the user sees in the preview panel. Pass artifact_id to publish a new version of an artifact " +
          "you published in this chat. Without it, a page titled like one of this chat's artifacts becomes its next version; anything else, or new_artifact: true, " +
          "creates a new artifact (also to build on an artifact from another chat, which stays as it is). A fix or a change is a new version, never a new artifact. " +
          "Declare in `mcp` every server and tool the page calls; the page can call nothing else. " +
          `Pass check_id from a passed ${CHECK_TOOL} instead of html and mcp; a page sent as html that has not passed a check gets checked first, and is not published while the check finds errors.`,
        parameters: Type.Object({
          title: Type.String({ description: "Two to five words." }),
          check_id: Type.Optional(Type.String({ description: `The page that passed ${CHECK_TOOL}, with what it declared.` })),
          html: Type.Optional(Type.String({ description: "The page: a full HTML document, or a body fragment. Leave out with check_id." })),
          artifact_id: Type.Optional(Type.String()),
          new_artifact: Type.Optional(Type.Boolean({ description: "A separate artifact, even if this chat has one with this title." })),
          message: Type.Optional(
            Type.String({ description: "One line on what this version changes, e.g. \"Add a 7-day sparkline\". It becomes the version's commit message." }),
          ),
          mcp: mcpParameter,
        }),
        execute: async (args): Promise<ToolExecutionResult<Partial<PublishedDetails>>> => {
          const target = { title: args.title, artifactId: args.artifact_id, newArtifact: args.new_artifact, message: args.message };
          let input: PublishInput;
          if (args.check_id !== undefined) {
            if (args.html !== undefined || args.mcp !== undefined) throw new Error("Pass check_id alone, or the page as html with its mcp: not both.");
            input = { ...target, checkId: args.check_id };
          } else if (args.html !== undefined) input = { ...target, html: args.html, mcp: args.mcp };
          else throw new Error("Pass check_id, or the page as html.");
          const outcome = await publishChecked(scope, input);
          const { meta, report, draft } = outcome;
          if (!meta) {
            const saved = `The page is saved as draft "${draft!.id}"; no version was made.`;
            if (!report) {
              const why = `Not published: no browser could check the page (${outcome.unchecked}), and a page is published only once a check passes. ${saved} Check it again in a while.`;
              return { output: text(why), isError: true };
            }
            const headline = `Not published: the check found ${plural(report.errors.length, "error")}. ${saved} Fix them and publish again.`;
            return { output: checkOutput(headline, report), details: { check: checkedDetails(report) }, isError: true };
          }
          const done =
            `Published artifact ${meta.id} version ${meta.latest} ("${meta.title}"). The user now sees it in the preview panel.` +
            (outcome.byTitle
              ? ` It went to this chat's artifact with that title, as its next version: pass artifact_id ${meta.id} for it next time, or new_artifact: true for a separate one.`
              : "") +
            (outcome.unchecked ? ` It was not checked in a browser: ${outcome.unchecked}.` : "");
          const details: PublishedDetails = { artifactId: meta.id, version: meta.latest, title: meta.title, ...(report && { check: checkedDetails(report) }) };
          return { output: report ? checkOutput(`${done} ${passedLine(report)}`, report) : text(done), details };
        },
      }),
      defineTool({
        name: DRAFTS_TOOL,
        description:
          `List this chat's drafts, newest first: pages you checked or tried to publish that are not published yet (the newest ${MAX_DRAFTS} are kept; ` +
          "a published page's draft goes). Pass draft_id to get one back, its html and mcp, to carry on from it: after a fix went wrong, " +
          "when the user asks for an earlier attempt, or when you no longer have the page you were working on.",
        parameters: Type.Object({ draft_id: Type.Optional(Type.String()) }),
        replay: "safe",
        execute: async (args) => {
          const drafts = await scope.drafts();
          if (args.draft_id === undefined) {
            const list = await drafts.list();
            const lines = list.length ? `${plural(list.length, "draft")}, newest first:\n${list.map(draftLine).join("\n")}` : "This chat has no drafts.";
            return { output: text(lines) };
          }
          const draft = await drafts.get(args.draft_id);
          if (!draft) throw new Error(`No draft "${args.draft_id}" in this chat. List them without draft_id.`);
          const declared = JSON.stringify(draft.manifest.mcp?.servers ?? []);
          return { output: text(`Draft ${draftLine(draft)}, mcp ${declared}:\n\n${draft.html}`) };
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
