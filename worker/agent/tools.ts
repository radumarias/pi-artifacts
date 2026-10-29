import { Type } from "@earendil-works/pi-ai";
import { exports } from "cloudflare:workers";
import { defineExtension, defineTool, section, type Extension } from "@earendil-works/pi-durable";
import { createTwoFilesPatch } from "diff";
import { isOwnedBy, isReadOnly, manifestOf, PUBLISH_TOOL, type ArtifactManifest, type ArtifactMeta, type ArtifactSummary, type PublishedDetails, type ToolInfo } from "../../shared/protocol.ts";
import { MAX_SKILL_DESCRIPTION, type SkillInput, type SkillResult } from "../../shared/skills.ts";
import { formatBytes, listSome } from "../../shared/util.ts";
import { checkManifest, MAX_HTML_BYTES } from "../artifacts/manifest.ts";
import type { McpHub } from "../mcp/hub.ts";
import type { SandboxFile, SandboxRun } from "../sandbox.ts";
import { normalisePath, PathError, type ArtifactStore, type FileEntry, type UserFiles } from "../storage/index.ts";
import { FileRefError, MAX_SANDBOX_BYTES, resolveFile, resolveRef, sandboxLayout } from "./file-refs.ts";

/** What the tools need from the chat they run in. */
export interface ChatScope {
  uid: string;
  chatId: string;
  hub: McpHub;
  artifacts: ArtifactStore;
  /** This chat's user's files: scoped to the uid and encrypted with that user's key. */
  files: () => Promise<UserFiles>;
  onPublished(artifact: Omit<ArtifactSummary, "chatId">): Promise<void>;
  /** Save a skill for the user, turned off until they turn it on. */
  proposeSkill(skill: SkillInput): Promise<SkillResult>;
}

const MAX_TOOL_TEXT = 16_000;

const text = (value: string) => [{ type: "text" as const, text: value }];

function clip(value: string): string {
  return value.length <= MAX_TOOL_TEXT ? value : `${value.slice(0, MAX_TOOL_TEXT)}\n… [${value.length - MAX_TOOL_TEXT} more characters cut]`;
}

/** Tool names the providers accept: the server's name as a slug, then the MCP tool's name. */
export function mcpToolName(server: string, tool: string): string {
  return `${server.toLowerCase().replace(/[^a-z0-9]+/g, "_")}__${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64);
}

/** What one MCP server told the chat about itself. */
export interface ServerCatalog {
  tools: ToolInfo[];
  instructions?: string;
}

/**
 * One pi tool per MCP tool, calling through the hub the artifacts also use.
 * The agent knows only what the servers say about themselves. Servers that
 * could not be listed (down, or the user has not signed in) are named in the
 * prompt with the reason, so the agent can tell the user.
 */
export function mcpExtension(hub: McpHub, catalog: Map<string, ServerCatalog>, unavailable: Map<string, string>): Extension {
  // Slugging and the 64-character cut can map two tools to one name ("My Server" and "my-server", "a.b" and "a_b"),
  // and providers reject a request whose tool names repeat: number the later ones.
  const used = new Set<string>();
  const tools = [];
  const servers: string[] = [];
  for (const [server, { tools: serverTools, instructions }] of catalog) {
    const list: string[] = [];
    for (const tool of serverTools) {
      const base = mcpToolName(server, tool.name);
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base.slice(0, 64 - String(n).length - 1)}_${n}`;
      used.add(name);
      const readOnly = isReadOnly(tool);
      list.push(`${tool.name}${readOnly ? " (read-only)" : ""} — agent tool ${name}`);
      tools.push(
        defineTool({
          name,
          description: `[MCP server "${server}", tool "${tool.name}"${readOnly ? ", read-only" : ""}] ${tool.description}`,
          parameters: Type.Unsafe<Record<string, unknown>>((tool.inputSchema as object) ?? { type: "object" }),
          replay: readOnly ? "safe" : "unsafe",
          execute: async (args) => {
            const result = await hub.call(server, tool.name, args);
            const payload = result.payload ?? result.content;
            return { output: text(clip(typeof payload === "string" ? payload : JSON.stringify(payload, null, 1))) };
          },
        }),
      );
    }
    const about = instructions?.trim() ? `\n  Says about itself: ${instructions.trim().replace(/\s+/g, " ").slice(0, 1_500)}` : "";
    servers.push(`- "${server}"${about}\n  Tools: ${list.join("; ")}`);
  }
  return defineExtension({
    name: "mcp",
    tools,
    sections: [
      section("mcp_servers", () => {
        const connected =
          "MCP servers connected to this chat. Pages declare them by these exact names. Use the servers and tools the user names; " +
          "when they don't, pick by the tool descriptions. A tool may answer with a link the user must open (to sign in, for example); " +
          `pass such links on as they are.\n${servers.join("\n")}`;
        if (unavailable.size === 0) return connected;
        const missing = [...unavailable].map(([name, reason]) => `- "${name}": ${reason}`);
        return `${connected}\n\nServers this chat cannot use right now. If the user asks for one, say why, and pass on any sign-in link exactly, ` +
          `as a Markdown link (a path such as /api/mcp/sign-in/<name> is only clickable that way):\n${missing.join("\n")}`;
      }),
    ],
  });
}

/** `path` as a stored path, or undefined when it cannot be one ("data/", a name with characters paths do not allow). */
function literalPath(path: string): string | undefined {
  try {
    return normalisePath(path);
  } catch (error) {
    if (error instanceof PathError) return undefined;
    throw error;
  }
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
        name: "files_write",
        description: "Write a UTF-8 text file into the user's files, replacing any file at that path.",
        parameters: Type.Object({ path: Type.String(), content: Type.String() }),
        execute: async (args) => {
          const path = await (await scope.files()).put(args.path, args.content, "text/plain; charset=utf-8");
          return { output: text(`Wrote ${path} (${args.content.length} characters).`) };
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
  return Promise.all(
    [...layout].map(async ([name, path]): Promise<SandboxFile> => {
      const object = await files.get(path);
      if (!object) throw missing(path);
      if (!sizes.has(path) && listedBytes + (unlisted += object.size) > MAX_SANDBOX_BYTES) {
        await object.body.cancel();
        throw new Error(tooMuch(listedBytes + unlisted));
      }
      // Each body is read as soon as it opens: a Worker keeps only a few connections open at once.
      return { name, bytes: await object.arrayBuffer() };
    }),
  );
}

function tooMuch(bytes: number): string {
  return `Those files hold ${formatBytes(bytes)}; one run takes at most ${formatBytes(MAX_SANDBOX_BYTES)}. Pass fewer.`;
}

/**
 * Copy the named user files in, run in this chat's sandbox, save ./out back to
 * the user's files. The files go through the user's UserFiles, so they are
 * decrypted on the way in and encrypted with the user's key on the way out.
 */
async function runInSandbox(scope: ChatScope, refs: string[] | undefined, run: (sandbox: ReturnType<typeof exports.Sandbox.getByName>, inputs: SandboxFile[]) => Promise<SandboxRun>) {
  const files = await scope.files();
  const inputs = await sandboxInputs(files, refs ?? []);
  const result = await run(exports.Sandbox.getByName(`${scope.uid}-${scope.chatId}`), inputs);
  const toSave = new Map<string, ArrayBuffer>();
  const skipped = [];
  for (const output of result.outputs) {
    // A name the user's files do not allow must not throw away the run's output and the files already saved.
    try {
      // Names that differ only in what normalising trims ("a.csv" and "a.csv ") would overwrite each other.
      const path = normalisePath(`out/${output.name}`);
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
    saved.length && `saved: ${saved.join(", ")}`,
    skipped.length && `not saved: ${skipped.join("; ")}`,
  ];
  return { output: text(clip(report.filter(Boolean).join("\n\n"))), isError: result.exitCode !== 0 };
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
        name: "run_python",
        description: `Run a Python 3.13 script (pandas and numpy installed) in this chat's isolated Linux sandbox: no internet, 60 s limit. ${SANDBOX_FILES}`,
        parameters: Type.Object({ code: Type.String(), files: inputFiles }),
        execute: async (args) => runInSandbox(scope, args.files, (sandbox, inputs) => sandbox.runPython(args.code, inputs)),
      }),
      defineTool({
        name: "run_bash",
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

/** Check the declaration, store a new version and index it for the user. Throws with what to fix. */
export async function publishArtifact(scope: ChatScope, input: PublishInput): Promise<ArtifactMeta> {
  if (new TextEncoder().encode(input.html).byteLength > MAX_HTML_BYTES) throw new Error("The page is over 2 MB; summarise the data instead of inlining it.");
  const manifest: ArtifactManifest = input.mcp?.length ? { mcp: { servers: input.mcp } } : {};
  const problems = await checkManifest(scope.hub, manifest);
  if (problems.length) throw new Error(`Not published. Fix the mcp declaration:\n${problems.join("\n")}`);
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

/** An artifact this chat published. Anything else reads as missing. */
async function ownArtifact(scope: ChatScope, id: string): Promise<ArtifactMeta> {
  const meta = await scope.artifacts.readMeta(id);
  if (!meta || !isOwnedBy(meta, scope.uid, scope.chatId)) throw new Error(`No artifact ${id} in this chat.`);
  return meta;
}

export function artifactExtension(scope: ChatScope): Extension {
  return defineExtension({
    name: "artifacts",
    tools: [
      defineTool({
        name: PUBLISH_TOOL,
        description:
          "Publish an HTML page as an artifact the user sees in the preview panel. Pass artifact_id to publish a new version of an artifact " +
          "you published in this chat; omit it to create a new one. Declare in `mcp` every server and tool the page calls; the page can call nothing else.",
        parameters: Type.Object({
          title: Type.String({ description: "Two to five words." }),
          html: Type.String({ description: "The page: a full HTML document, or a body fragment." }),
          artifact_id: Type.Optional(Type.String()),
          message: Type.Optional(
            Type.String({ description: "One line on what this version changes, e.g. \"Add a 7-day sparkline\". It becomes the version's commit message." }),
          ),
          mcp: Type.Optional(
            Type.Array(Type.Object({ server: Type.String(), tools: Type.Array(Type.String()) }), {
              description: 'e.g. [{"server": "CoinGecko", "tools": ["execute"]}]',
            }),
          ),
        }),
        execute: async (args) => {
          const meta = await publishArtifact(scope, { title: args.title, html: args.html, artifactId: args.artifact_id, mcp: args.mcp, message: args.message });
          return {
            output: text(`Published artifact ${meta.id} version ${meta.latest} ("${meta.title}"). The user now sees it in the preview panel.`),
            details: { artifactId: meta.id, version: meta.latest, title: meta.title } satisfies PublishedDetails,
          };
        },
      }),
      defineTool({
        name: "artifact_read",
        description: "Read the HTML of an artifact published in this chat, to revise it.",
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
        description: "List the versions of an artifact published in this chat: when each was published and what it changed.",
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
