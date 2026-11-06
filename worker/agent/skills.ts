import type { SkillContent, SkillResource, SkillResourceDescriptor, SkillSource } from "agents/skills";
import { mediaType, skillFilesNote, type SkillFileInfo } from "../../shared/skill-files.ts";
import { isActive, type SkillInfo, type SkillInput } from "../../shared/skills.ts";
import { formatBytes } from "../../shared/util.ts";

/** How much of one skill file the agent reads at once: a library a page names by reference need not fill its context. */
export const MAX_SKILL_FILE_READ = 60_000;

/** Reads the bytes of one of a skill's files, or null when it is not there. */
export type SkillFileReader = (skill: SkillInfo, path: string) => Promise<Uint8Array | null>;

/** How the agent gets at the skills' files: `read` reads one; `sandbox` says whether their scripts can run in this chat. */
export interface SkillFilesAccess {
  read: SkillFileReader;
  sandbox: boolean;
}

/**
 * The enabled skills as one source for `skills()` from agents/harness/pi, which
 * lists their descriptions in the system prompt and adds `activate_skill` and
 * `read_skill_resource`, which reads a skill's files through `files`.
 * Where a built-in and a user skill share a name, the user's (when on) wins.
 * `shown`, when given, keeps only the skills of those names (the ones picked for
 * the chat, worker/agent/skill-pick.ts). `version` is the user's skills version
 * (UserDirectory.skillsVersion); the fingerprint adds the names listed, so the
 * chat reinstalls only when either changes.
 */
export function skillSource(skills: readonly SkillInfo[], version: string, shown?: ReadonlySet<string>, access?: SkillFilesAccess): SkillSource {
  // The agent activates by name alone: a built-in skill the user replaced with their own is left out.
  const enabled = skills.filter((skill) => isActive(skill) && (!shown || shown.has(skill.name)));
  const byName = new Map(enabled.map((skill) => [skill.name, skill]));
  const descriptor = (skill: SkillInfo) => ({
    name: skill.name,
    description: skill.description,
    sourceId: "pi-artifacts",
    version: skill.updatedAt ? String(skill.updatedAt) : undefined,
  });
  return {
    id: "pi-artifacts",
    fingerprint: shown ? `${version}|${enabled.map(({ name }) => name).sort().join(",")}` : version,
    list: async () => enabled.map(descriptor),
    load: async (name): Promise<SkillContent | null> => {
      const skill = byName.get(name);
      if (!skill) return null;
      const files = access ? (skill.files ?? []) : [];
      const note = skillFilesNote(skill.name, files, access?.sandbox ?? false);
      return { ...descriptor(skill), body: skillBody(skill) + note, ...(files.length && { resources: files.map(resource) }) };
    },
    readResource: async (name, path): Promise<SkillResource | null> => {
      const skill = byName.get(name);
      const file = skill?.files?.find((f) => f.path === path);
      if (!skill || !file || !access) return null;
      if (file.binary)
        return {
          ...resource(file),
          content:
            `[A binary file (${mediaType(path)}, ${formatBytes(file.size)}), not shown. A page uses it as skill:${name}/${path} ` +
            `(an <img> src, or from the skill's stylesheet)${access.sandbox ? `; a script finds it at ./skills/${name}/${path} when run with skills: ["${name}"]` : ""}.]`,
        };
      const bytes = await access.read(skill, path);
      if (bytes === null) return null;
      const text = new TextDecoder().decode(bytes);
      const content =
        text.length > MAX_SKILL_FILE_READ
          ? `${text.slice(0, MAX_SKILL_FILE_READ)}\n\n[Cut at ${MAX_SKILL_FILE_READ.toLocaleString("en")} of ${text.length.toLocaleString("en")} characters (${formatBytes(file.size)}). A page uses this file by reference, skill:${name}/${path}, ` +
            "never by copying it, so there is no need to read the rest.]"
          : text;
      return { ...resource(file), content };
    },
  };
}

/** A skill file as the agent's skill tools describe it. */
function resource(file: SkillFileInfo): SkillResourceDescriptor {
  const kind = /^references?\//.test(file.path) || /\.(md|txt)$/i.test(file.path) ? "reference" : /^(scripts|tools|bin)\//.test(file.path) ? "script" : "asset";
  return { path: file.path, kind, size: file.size, encoding: "text", ...(file.binary && { mimeType: mediaType(file.path) }) };
}

/** What `activate_skill` hands the agent: the instructions, then the tools the skill works with. */
export function skillBody(skill: SkillInput): string {
  if (!skill.tools.length) return skill.instructions;
  return `${skill.instructions}\n\nTools this skill works with: ${skill.tools.join(", ")}. Prefer these; a tool not in this chat is unavailable, so say so instead of guessing.`;
}
