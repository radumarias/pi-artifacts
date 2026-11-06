import { MAX_SKILL_ZIP_BYTES, type SkillFileInfo } from "../shared/skill-files.ts";
import { SKILL_NAME_PATTERN, SkillError, type SkillResult } from "../shared/skills.ts";
import { formatBytes } from "../shared/util.ts";
import { json, readJson } from "./http.ts";
import { formatSkillFile, parseSkillFile } from "./skills/index.ts";
import { readSkillPackage } from "./skills/package.ts";
import type { SkillFiles } from "./storage/index.ts";
import type { UserDirectory } from "./users.ts";

/** What a zip upload may be sent as. Neither is a type a form on another site can send without asking first (CORS). */
const ZIP_TYPES = new Set(["application/zip", "application/x-zip-compressed"]);

/**
 * The skills of a verified user (`directory` is their UserDirectory), which apply in all their chats:
 *   GET    /api/skills                    built-in and own skills
 *   POST   /api/skills                    save one: {name, description, instructions, tools, enabled?} or {markdown, enabled?}
 *   POST   /api/skills/import             a skill package: a zip with a SKILL.md and the skill's files; turned on
 *   PATCH  /api/skills/:name              {enabled, updatedAt?}: turn one of the user's own on or off
 *   DELETE /api/skills/:name              delete one of the user's own
 *   GET    /api/skills/:name/SKILL.md     one of the user's own as a SKILL.md file
 *   PATCH  /api/skills/builtin/:name      {enabled}: turn a built-in skill on or off
 *   GET    /api/skills/builtin/:name/SKILL.md
 * Built-in and user skills have separate paths (see skillPath), so a name can be both.
 * Returns null for any other path.
 */
export async function skillsRoute(
  request: Request,
  directory: DurableObjectStub<UserDirectory>,
  skillFiles: () => Promise<SkillFiles>,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const method = request.method;
  const answer = (result: SkillResult | null) => (result && "error" in result ? json(result, 400) : json(result ?? {}));
  if (path === "/api/skills" && method === "GET") return json(await directory.listSkills());
  if (path === "/api/skills" && method === "POST") {
    // readJson takes only a JSON content type, so another site cannot post a skill, turned on, into a signed-in user's chats.
    // The directory checks every field, and parses a SKILL.md.
    const body = await readJson<{ enabled?: unknown }>(request);
    if (!body || typeof body !== "object") return json({ error: "Expected a skill as JSON (content-type: application/json)." }, 400);
    return answer(await directory.saveSkill(body, "user", body.enabled !== false));
  }
  if (path === "/api/skills/import" && method === "POST") return importPackage(request, directory, skillFiles);
  const one = path.match(/^\/api\/skills\/(builtin\/)?([a-z0-9-]+)(\/SKILL\.md)?$/);
  if (!one || !SKILL_NAME_PATTERN.test(one[2])) return null;
  const [builtin, name, file] = [Boolean(one[1]), one[2], Boolean(one[3])];
  if (file) {
    if (method !== "GET") return null;
    const skill = await (builtin ? directory.getBuiltinSkill(name) : directory.getSkill(name));
    if (!skill) return json({ error: `No skill named "${name}".` }, 404);
    return new Response(formatSkillFile(skill), {
      headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${name}.SKILL.md"` },
    });
  }
  if (method === "PATCH") {
    const body = await request.json<{ enabled?: unknown; updatedAt?: unknown }>().catch(() => null);
    const seen = body?.updatedAt;
    if (typeof body?.enabled !== "boolean" || (seen !== undefined && typeof seen !== "number")) {
      return json({ error: "Expected {enabled: true | false, updatedAt?: number}." }, 400);
    }
    return answer(await (builtin ? directory.setBuiltinSkillEnabled(name, body.enabled) : directory.setSkillEnabled(name, body.enabled, seen)));
  }
  if (method === "DELETE" && !builtin) return answer(await deleteSkill(name, directory, skillFiles));
  return null;
}

/** Read a skill package from the request and import it (importSkillPackage). */
async function importPackage(request: Request, directory: DurableObjectStub<UserDirectory>, skillFiles: () => Promise<SkillFiles>): Promise<Response> {
  if (!ZIP_TYPES.has(request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "")) {
    return json({ error: "Send the skill package as a zip (content-type: application/zip)." }, 415);
  }
  const tooBig = json({ error: `The zip is over ${formatBytes(MAX_SKILL_ZIP_BYTES)}.` }, 413);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_SKILL_ZIP_BYTES) return tooBig;
  const zip = new Uint8Array(await request.arrayBuffer());
  if (zip.byteLength > MAX_SKILL_ZIP_BYTES) return tooBig;
  try {
    const saved = await importSkillPackage(zip, directory, await skillFiles());
    return json(saved, "error" in saved ? 400 : 200);
  } catch (error) {
    if (error instanceof SkillError) return json({ error: error.message }, 400);
    throw error;
  }
}

/**
 * Import a skill package as one of the user's skills, turned on, with its files. The files are written first, as a new
 * set, then the skill saved naming that set, so a skill never names files that are not there; the set it named until
 * then (as the save says, so that two imports at once each delete the one they replaced) is deleted after. A refused
 * skill leaves no files. Throws a SkillError for a package that cannot be read.
 */
async function importSkillPackage(
  zip: Uint8Array,
  directory: DurableObjectStub<UserDirectory>,
  skillFiles: SkillFiles,
): Promise<SkillResult & { skipped?: string[] }> {
  const pkg = await readSkillPackage(zip);
  const { name } = parseSkillFile(pkg.markdown);
  const list: SkillFileInfo[] = pkg.files.map((file) => ({ path: file.path, size: file.bytes.byteLength }));
  const set = await skillFiles.write(name, pkg.files);
  const saved = await directory.saveSkill({ markdown: pkg.markdown }, "user", true, { set, list });
  if ("error" in saved) {
    await skillFiles.drop(name, set);
    return saved;
  }
  const { replacedFileSet, ...skill } = saved;
  if (replacedFileSet) await skillFiles.drop(name, replacedFileSet).catch(() => {});
  return { ...skill, skipped: pkg.skipped };
}

/** Delete one of the user's skills, and its files when it has any. */
async function deleteSkill(name: string, directory: DurableObjectStub<UserDirectory>, skillFiles: () => Promise<SkillFiles>): Promise<SkillResult | null> {
  const fileSet = (await directory.getSkill(name))?.fileSet;
  const deleted = await directory.deleteSkill(name);
  if (!deleted && fileSet) await (await skillFiles()).dropAllBut(name);
  return deleted;
}
