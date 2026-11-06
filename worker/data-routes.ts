import { exports } from "cloudflare:workers";
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  formatCursor,
  importedArtifactId,
  MAX_IMPORT_BODY_BYTES,
  MAX_IMPORT_FILE_BYTES,
  NEXT_PART_HEADER,
  parseCursor,
  type ArtifactVersionImport,
  type ChatDumpPage,
  type ChatDumpPart,
  type ChatImportStart,
  type ExportedChat,
  type ExportedPageValues,
  type ExportedSkill,
  type ExportedSkillFiles,
  type ExportStart,
  type ImportedSettings,
  type ImportPlan,
  type ImportPlanRequest,
} from "../shared/data-export.ts";
import { ID_PATTERN, isOwnedBy } from "../shared/protocol.ts";
import { MAX_SKILL_FILE_BYTES, MAX_SKILL_FILES } from "../shared/skill-files.ts";
import { SKILL_NAME_PATTERN } from "../shared/skills.ts";
import { formatBytes, fromBase64, isObject, mapLimit, toBase64 } from "../shared/util.ts";
import { chatAgentName, type ChatRefusal } from "./chat-agent.ts";
import { urlPath } from "./files-routes.ts";
import { json, readJson } from "./http.ts";
import { saveSkillWithFiles } from "./skills-routes.ts";
import { ArtifactImportError, normalisePath, type Draft, type Storage } from "./storage/index.ts";
import type { UserDirectory } from "./users.ts";

const EXPORT_CHAT = /^\/api\/me\/export\/chats\/([a-z0-9]+)(\/drafts)?$/;
const IMPORT_CHAT = /^\/api\/me\/import\/chats\/([a-z0-9]+)\/(begin|rows|drafts|finish)$/;
const EXPORT_ARTIFACT = /^\/api\/me\/export\/artifacts\/([a-z0-9]+)$/;
const IMPORT_VERSION = /^\/api\/me\/import\/artifacts\/([a-z0-9]+)\/versions$/;
const EXPORT_SKILL = /^\/api\/me\/export\/skills\/([a-z0-9-]+)$/;
const IMPORT_FILE = "/api/me/import/files/";

type Directory = DurableObjectStub<UserDirectory>;

/**
 * Export and import of everything a verified user has (shared/data-export.ts). The browser reads an export a piece at a
 * time and zips it (src/data/), and reads a zip back the same way, so no request carries more than one piece:
 *   GET  /api/me/export                       the account (ExportStart): settings, skills, page values, and what else there is
 *   GET  /api/me/export/chats/:id?cursor=     one part of an own chat's storage (ChatDumpPart), the next one's cursor in NEXT_PART_HEADER
 *   GET  /api/me/export/chats/:id/drafts      its unpublished pages
 *   GET  /api/me/export/artifacts/:id         an own artifact's versions (ArtifactMeta); each page from /u/:id/v:n/source
 *   GET  /api/me/export/skills/:name          a skill's files (ExportedSkillFiles)
 *   POST /api/me/import/plan                  what importing the zip's chats and artifacts does here (ImportPlan)
 *   POST /api/me/import/account               the settings, where the user has none of their own yet
 *   POST /api/me/import/skills                one skill with its files; skipped when the user has one of that name
 *   PUT  /api/me/import/files/<path>          one file, as the body; skipped when there is one at that path
 *   POST /api/me/import/chats/:id/begin|rows|drafts|finish
 *                                             a chat: begin (ChatImportStart), each part, its drafts, then finish, which
 *                                             puts it in the user's list
 *   POST /api/me/import/artifacts/:id/versions one version, in order (ArtifactVersionImport)
 *   POST /api/me/import/page-values           what pages saved ([ExportedPageValues]), for pages that saved nothing here
 * Imports add to what is here and never replace it, so an import that stopped part way is run again from the start.
 * JSON bodies take a JSON content type only, and a file comes by PUT: neither can be sent by another site's form.
 * Returns null for any other path.
 */
export async function dataRoute(request: Request, uid: string, directory: Directory, storage: Storage): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path.startsWith("/api/me/export")) return exportRoute(request, uid, directory, storage, path);
  if (!path.startsWith("/api/me/import/")) return null;
  if (request.method === "PUT" && path.startsWith(IMPORT_FILE)) return importFile(request, uid, storage, path.slice(IMPORT_FILE.length));
  if (request.method !== "POST") return null;
  if (Number(request.headers.get("content-length") ?? 0) > MAX_IMPORT_BODY_BYTES) {
    return json({ error: `One part of an import may be at most ${formatBytes(MAX_IMPORT_BODY_BYTES)}.` }, 413);
  }

  const chat = path.match(IMPORT_CHAT);
  if (chat && ID_PATTERN.test(chat[1])) return importChat(request, uid, directory, storage, chat[1], chat[2]);
  const version = path.match(IMPORT_VERSION);
  if (version && ID_PATTERN.test(version[1])) return importVersion(request, uid, directory, storage, version[1]);
  if (path === "/api/me/import/plan") {
    const body = await readJson<ImportPlanRequest>(request);
    if (!Array.isArray(body?.chats) || !Array.isArray(body.artifacts)) return json({ error: "Expected {chats, artifacts}." }, 400);
    return json(await importPlan(body, uid, directory, storage));
  }
  if (path === "/api/me/import/account") {
    const body = await readJson<ImportedSettings>(request);
    if (!isObject(body)) return json({ error: "Expected the export's account settings." }, 400);
    return json({ applied: await directory.importSettings(body) });
  }
  if (path === "/api/me/import/skills") return importSkill(request, uid, directory, storage);
  if (path === "/api/me/import/page-values") return importPageValues(request, uid, directory, storage);
  return null;
}

async function exportRoute(request: Request, uid: string, directory: Directory, storage: Storage, path: string): Promise<Response | null> {
  if (path === "/api/me/export") {
    const [account, files] = await Promise.all([directory.exportAccount(), storage.userFiles(uid).then((store) => store.list("", Number.POSITIVE_INFINITY))]);
    return json({
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: Date.now(),
      uid,
      ...account,
      files: files.map(({ path: file, size }) => ({ path: file, size })),
    } satisfies ExportStart);
  }

  const chat = path.match(EXPORT_CHAT);
  if (chat && ID_PATTERN.test(chat[1])) {
    const chatId = chat[1];
    if (!(await directory.hasChat(chatId))) return json({ error: "No such chat of yours." }, 404);
    if (chat[2]) {
      const drafts = await storage.chatDrafts(uid, chatId);
      return json((await Promise.all((await drafts.list()).map((draft) => drafts.get(draft.id)))).filter(Boolean).reverse());
    }
    const chatAgent = exports.ChatAgent.getByName(chatAgentName(uid, chatId));
    // The stub's type of the answer loses the union: it is the method's own.
    const page = (await chatAgent.exportPart(parseCursor(new URL(request.url).searchParams.get("cursor")))) as ChatDumpPage | ChatRefusal;
    if ("error" in page) return json({ error: page.error }, page.status);
    return json(page.part, 200, page.next ? { [NEXT_PART_HEADER]: formatCursor(page.next) } : {});
  }

  const artifact = path.match(EXPORT_ARTIFACT);
  if (artifact && ID_PATTERN.test(artifact[1])) {
    const meta = await storage.artifacts.readMeta(artifact[1]);
    if (!meta || meta.ownerUid !== uid) return json({ error: "No such artifact of yours." }, 404);
    return json(meta);
  }

  const skill = path.match(EXPORT_SKILL);
  if (skill && SKILL_NAME_PATTERN.test(skill[1])) {
    const found = await directory.getSkill(skill[1]);
    if (!found) return json({ error: `No skill named "${skill[1]}".` }, 404);
    const listed = found.files ?? [];
    const bytes = found.fileSet
      ? await (
          await storage.skillFiles(uid)
        ).readAll(
          found.name,
          found.fileSet,
          listed.map((file) => file.path),
        )
      : [];
    const files = listed.flatMap((file, i) => (bytes[i] ? [{ path: file.path, data: toBase64(bytes[i]), ...(file.binary && { binary: true as const }) }] : []));
    return json({ files } satisfies ExportedSkillFiles);
  }
  return null;
}

/**
 * What importing the zip's chats and artifacts does here (ImportPlan). An artifact keeps its id, unless someone else's
 * artifact (or another chat's of the user's) has it here; then it takes the one importedArtifactId gives it, unless that
 * is taken too.
 */
async function importPlan(body: ImportPlanRequest, uid: string, directory: Directory, storage: Storage): Promise<ImportPlan> {
  const chatIds = body.chats.filter((id) => typeof id === "string" && ID_PATTERN.test(id));
  const listed = body.artifacts.filter((entry) => isObject(entry) && ID_PATTERN.test(String(entry.id)) && ID_PATTERN.test(String(entry.chatId)));
  const entries = await Promise.all(listed.map(async ({ id, chatId }) => ({ id, chatId, candidates: [id, await importedArtifactId(uid, id)] })));
  const [ownChats, ownArtifacts] = await Promise.all([directory.ownChats(chatIds), directory.ownArtifacts(entries.flatMap((entry) => entry.candidates))]);
  const own = new Map(ownArtifacts.map((row) => [row.id, row]));
  const has = new Set(ownChats);

  const artifacts = await mapLimit(entries, 8, async ({ id, chatId, candidates }): Promise<[string, ImportPlan["artifacts"][string]]> => {
    for (const candidate of candidates) {
      const mine = own.get(candidate);
      if (mine) {
        if (mine.chat_id === chatId) return [id, { id: candidate, latest: mine.latest }];
        continue;
      }
      // Not in the user's list: nobody's here, someone else's, or one of theirs an import stopped before listing.
      const meta = await storage.artifacts.readMeta(candidate);
      if (!meta) return [id, { id: candidate, latest: 0 }];
      if (isOwnedBy(meta, uid, chatId)) return [id, { id: candidate, latest: meta.latest }];
    }
    return [id, { error: "Its id is taken here." }];
  });
  return { chats: Object.fromEntries(chatIds.map((id) => [id, has.has(id) ? "exists" : "new"])), artifacts: Object.fromEntries(artifacts) };
}

/** One step of a chat's import: begin, each part (rows), its drafts, then finish. */
async function importChat(request: Request, uid: string, directory: Directory, storage: Storage, chatId: string, step: string): Promise<Response | null> {
  // A chat in the user's list is theirs already: an import never writes over one.
  if (await directory.hasChat(chatId)) return json({ error: "You have this chat already." }, 409);
  const chat = exports.ChatAgent.getByName(chatAgentName(uid, chatId));
  const answer = (result: ChatRefusal | null) => (result ? json({ error: result.error }, result.status) : json({}));
  const body = await readJson<unknown>(request);
  if (step === "begin") {
    const start = body as Partial<ChatImportStart> | null;
    if (typeof start?.from !== "string" || !isObject(start.artifacts)) return json({ error: "Expected {from, artifacts}." }, 400);
    const artifacts = Object.fromEntries(
      Object.entries(start.artifacts).filter(
        (pair): pair is [string, string] => ID_PATTERN.test(pair[0]) && typeof pair[1] === "string" && ID_PATTERN.test(pair[1]),
      ),
    );
    return answer(await chat.importBegin({ from: start.from, artifacts }));
  }
  if (step === "rows") {
    if (!isObject(body) || !Array.isArray(body.tables)) return json({ error: "Expected a part of a chat's export." }, 400);
    return answer(await chat.importPart(body as unknown as ChatDumpPart));
  }
  if (step === "drafts") {
    if (!Array.isArray(body)) return json({ error: "Expected a list of drafts." }, 400);
    const drafts = await storage.chatDrafts(uid, chatId);
    // Oldest first, as they were saved: the store keeps the newest MAX_DRAFTS.
    for (const draft of body) {
      if (!isObject(draft) || typeof draft.id !== "string" || typeof draft.html !== "string" || !isObject(draft.manifest)) continue;
      const { id, html, manifest, artifactId, skillSets, errors, warnings } = draft as unknown as Draft;
      const check = typeof errors === "number" ? { errors, warnings: Number(warnings) || 0 } : null;
      const page = { id, html, manifest, ...(typeof artifactId === "string" && { artifactId }), ...(isObject(skillSets) && { skillSets }) };
      // A draft whose id is not one the store takes is left out; the others still go in.
      await drafts.save(page, check).catch(() => {});
    }
    return json({});
  }
  // finish
  const info = body as Partial<ExportedChat> | null;
  if (typeof info?.title !== "string") return json({ error: "Expected {title, createdAt, updatedAt}." }, 400);
  const refused = await chat.importFinish();
  if (refused) return answer(refused);
  await directory.importChat({ id: chatId, title: info.title, createdAt: Number(info.createdAt) || 0, updatedAt: Number(info.updatedAt) || 0 });
  return json({});
}

/** One version of one of the user's artifacts, in order; the artifact joins their list with it, already seen. */
async function importVersion(request: Request, uid: string, directory: Directory, storage: Storage, id: string): Promise<Response> {
  const body = await readJson<ArtifactVersionImport>(request);
  const version = body?.version;
  if (
    !body ||
    !ID_PATTERN.test(String(body.chatId)) ||
    typeof body.html !== "string" ||
    typeof body.title !== "string" ||
    !isObject(version) ||
    !Number.isSafeInteger(version.version) ||
    version.version < 1 ||
    !isObject(version.manifest)
  ) {
    return json({ error: "Expected {chatId, title, createdAt, version, html}." }, 400);
  }
  // Only into a chat of the user's: the artifact lives there, and its page's live calls go to it.
  if (!(await directory.hasChat(body.chatId))) return json({ error: "Import the artifact's chat first." }, 409);
  try {
    const meta = await storage.artifacts.importVersion({
      id,
      ownerUid: uid,
      chatId: body.chatId,
      title: body.title.slice(0, 200),
      createdAt: Number(body.createdAt) || Date.now(),
      version: {
        version: version.version,
        publishedAt: Number(version.publishedAt) || Date.now(),
        manifest: version.manifest,
        ...(typeof version.message === "string" && { message: version.message }),
      },
      html: body.html,
    });
    await directory.recordArtifact({ id, title: meta.title, chatId: body.chatId, latest: meta.latest, updatedAt: meta.updatedAt }, true);
    return json({ latest: meta.latest });
  } catch (error) {
    if (error instanceof ArtifactImportError) return json({ error: error.message }, 409);
    throw error;
  }
}

/** One skill of the user's own, with its files: skipped when they have a skill of that name. */
async function importSkill(request: Request, uid: string, directory: Directory, storage: Storage): Promise<Response> {
  const body = await readJson<{ skill?: ExportedSkill; files?: ExportedSkillFiles["files"] }>(request);
  const skill = body?.skill;
  if (!isObject(skill) || typeof skill.name !== "string" || !SKILL_NAME_PATTERN.test(skill.name)) return json({ error: "Expected {skill, files?}." }, 400);
  if (await directory.getSkill(skill.name)) return json({ skipped: "You have a skill of that name." });
  const files = (Array.isArray(body?.files) ? body.files.slice(0, MAX_SKILL_FILES) : []).flatMap((file) => {
    if (!isObject(file) || typeof file.path !== "string" || typeof file.data !== "string") return [];
    const bytes = fromBase64(file.data);
    return bytes.byteLength <= MAX_SKILL_FILE_BYTES ? [{ path: normalisePath(file.path), bytes, binary: file.binary === true }] : [];
  });
  const input = { name: skill.name, description: skill.description, instructions: skill.instructions, tools: skill.tools };
  const origin = skill.origin === "agent" ? "agent" : "user";
  const saved = await saveSkillWithFiles(
    directory,
    await storage.skillFiles(uid),
    skill.name,
    input,
    origin,
    skill.enabled === true,
    files.length ? files : undefined,
  );
  return json(saved, "error" in saved ? 400 : 200);
}

/** One file, at its own path: skipped when there is a file there, which stays as it is. */
async function importFile(request: Request, uid: string, storage: Storage, encoded: string): Promise<Response> {
  const path = urlPath(encoded);
  const size = Number(request.headers.get("content-length"));
  if (!request.headers.has("content-length") || !Number.isSafeInteger(size)) return json({ error: "Send the file with its length." }, 411);
  if (size > MAX_IMPORT_FILE_BYTES) return json({ error: `${path} is over ${formatBytes(MAX_IMPORT_FILE_BYTES)}, the most one import request carries.` }, 413);
  const files = await storage.userFiles(uid);
  if (await files.has(path)) return json({ skipped: true });
  await files.put(path, request.body ?? new ArrayBuffer(0));
  return json({});
}

/** What pages saved for the user, kept for each page that is here (one of another deployment's is nobody's here). */
async function importPageValues(request: Request, uid: string, directory: Directory, storage: Storage): Promise<Response> {
  const body = await readJson<ExportedPageValues[]>(request);
  if (!Array.isArray(body)) return json({ error: "Expected a list of {artifactId, values}." }, 400);
  const listed = body.flatMap((page: unknown) => {
    if (!isObject(page)) return [];
    const { artifactId, values } = page;
    if (typeof artifactId !== "string" || !ID_PATTERN.test(artifactId) || !isObject(values)) return [];
    const strings = Object.entries(values).filter((entry): entry is [string, string | null] => entry[1] === null || typeof entry[1] === "string");
    return [{ artifactId, values: Object.fromEntries(strings) }];
  });
  const own = new Set((await directory.ownArtifacts(listed.map((page) => page.artifactId))).map((row) => row.id));
  const here = await mapLimit(listed, 8, async (page) => (own.has(page.artifactId) || (await storage.artifacts.readMeta(page.artifactId)) ? [page] : []));
  const pages = here.flat();
  return json({ imported: pages.length ? await directory.importPageValues(pages) : 0 });
}
