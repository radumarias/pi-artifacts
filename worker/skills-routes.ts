import { SKILL_NAME_PATTERN, type SkillResult } from "../shared/skills.ts";
import { formatSkillFile } from "./skills/index.ts";
import type { UserDirectory } from "./users.ts";

/**
 * The skills of a verified user (`directory` is their UserDirectory), which apply in all their chats:
 *   GET    /api/skills                    built-in and own skills
 *   POST   /api/skills                    save one: {name, description, instructions, tools, enabled?} or {markdown, enabled?}
 *   PATCH  /api/skills/:name              {enabled, updatedAt?}: turn one on or off, built-in ones included
 *   DELETE /api/skills/:name              delete one of the user's own
 *   GET    /api/skills/:name/SKILL.md     one skill as a SKILL.md file
 * Returns null for any other path.
 */
export async function skillsRoute(request: Request, directory: DurableObjectStub<UserDirectory>): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const method = request.method;
  const answer = (result: SkillResult | null) => (result && "error" in result ? Response.json(result, { status: 400 }) : Response.json(result ?? {}));
  if (path === "/api/skills" && method === "GET") return Response.json(await directory.listSkills());
  if (path === "/api/skills" && method === "POST") {
    // A JSON content type cannot be sent cross-site without a CORS preflight, so another
    // site cannot post a skill, turned on, into a signed-in user's chats from a plain form.
    if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
      return Response.json({ error: "Expected a skill as JSON (content-type: application/json)." }, { status: 415 });
    }
    // The directory checks every field, and parses a SKILL.md.
    const body = await request.json<{ enabled?: unknown } | null>().catch(() => null);
    if (!body || typeof body !== "object") return Response.json({ error: "Expected a skill as JSON." }, { status: 400 });
    return answer(await directory.saveSkill(body, "user", body.enabled !== false));
  }
  const one = path.match(/^\/api\/skills\/([a-z0-9-]+)(\/SKILL\.md)?$/);
  if (!one || !SKILL_NAME_PATTERN.test(one[1])) return null;
  const name = one[1];
  if (one[2]) {
    if (method !== "GET") return null;
    const skill = await directory.getSkill(name);
    if (!skill) return Response.json({ error: `No skill named "${name}".` }, { status: 404 });
    return new Response(formatSkillFile(skill), {
      headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${name}.SKILL.md"` },
    });
  }
  if (method === "PATCH") {
    const body = await request.json<{ enabled?: unknown; updatedAt?: unknown }>().catch(() => null);
    const seen = body?.updatedAt;
    if (typeof body?.enabled !== "boolean" || (seen !== undefined && typeof seen !== "number")) {
      return Response.json({ error: "Expected {enabled: true | false, updatedAt?: number}." }, { status: 400 });
    }
    return answer(await directory.setSkillEnabled(name, body.enabled, seen));
  }
  if (method === "DELETE") return answer(await directory.deleteSkill(name));
  return null;
}
