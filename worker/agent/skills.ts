import type { SkillContent, SkillResource, SkillResourceDescriptor, SkillSource } from "agents/skills";
import { skillFilesNote, type SkillFileInfo } from "../../shared/skill-files.ts";
import { isActive, type SkillInfo, type SkillInput } from "../../shared/skills.ts";
import { formatBytes } from "../../shared/util.ts";

/** How much of one skill file the agent reads at once: a library a page names by reference need not fill its context. */
export const MAX_SKILL_FILE_READ = 60_000;

/** Reads the text of one of a skill's files, or null when it is not there. */
export type SkillFileReader = (skill: SkillInfo, path: string) => Promise<string | null>;

/**
 * The enabled skills as one source for `skills()` from agents/harness/pi, which
 * lists their descriptions in the system prompt and adds `activate_skill` and
 * `read_skill_resource`, which reads a skill's files through `readFile`.
 * Where a built-in and a user skill share a name, the user's (when on) wins.
 * `version` is the user's skills version (UserDirectory.skillsVersion), so the
 * chat reinstalls only when it changes.
 */
export function skillSource(skills: readonly SkillInfo[], version: string, readFile?: SkillFileReader): SkillSource {
  // The agent activates by name alone: a built-in skill the user replaced with their own is left out.
  const enabled = skills.filter(isActive);
  const byName = new Map(enabled.map((skill) => [skill.name, skill]));
  const descriptor = (skill: SkillInfo) => ({
    name: skill.name,
    description: skill.description,
    sourceId: "pi-artifacts",
    version: skill.updatedAt ? String(skill.updatedAt) : undefined,
  });
  return {
    id: "pi-artifacts",
    fingerprint: version,
    list: async () => enabled.map(descriptor),
    load: async (name): Promise<SkillContent | null> => {
      const skill = byName.get(name);
      if (!skill) return null;
      const files = readFile ? (skill.files ?? []) : [];
      return { ...descriptor(skill), body: skillBody(skill) + skillFilesNote(skill.name, files), ...(files.length && { resources: files.map(resource) }) };
    },
    readResource: async (name, path): Promise<SkillResource | null> => {
      const skill = byName.get(name);
      const file = skill?.files?.find((f) => f.path === path);
      if (!skill || !file || !readFile) return null;
      const text = await readFile(skill, path);
      if (text === null) return null;
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
  return { path: file.path, kind, size: file.size, encoding: "text" };
}

/** What `activate_skill` hands the agent: the instructions, then the tools the skill works with. */
export function skillBody(skill: SkillInput): string {
  if (!skill.tools.length) return skill.instructions;
  return `${skill.instructions}\n\nTools this skill works with: ${skill.tools.join(", ")}. Prefer these; a tool not in this chat is unavailable, so say so instead of guessing.`;
}
