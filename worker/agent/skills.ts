import type { SkillContent, SkillSource } from "agents/skills";
import type { SkillInfo, SkillInput } from "../../shared/skills.ts";

/**
 * The enabled skills as one source for `skills()` from agents/harness/pi, which
 * lists their descriptions in the system prompt and adds `activate_skill`.
 * Where a built-in and a user skill share a name, the user's (when on) wins.
 * `version` is the user's skills version (UserDirectory.skillsVersion), so the
 * chat reinstalls only when it changes.
 */
export function skillSource(skills: readonly SkillInfo[], version: string): SkillSource {
  // The agent activates by name alone: a built-in skill the user replaced with their own is left out.
  const enabled = skills.filter((skill) => skill.enabled && !skill.replaced);
  const byName = new Map(enabled.map((skill) => [skill.name, skill]));
  const descriptor = (skill: SkillInfo) => ({ name: skill.name, description: skill.description, sourceId: "pi-artifacts", version: skill.updatedAt ? String(skill.updatedAt) : undefined });
  return {
    id: "pi-artifacts",
    fingerprint: version,
    list: async () => enabled.map(descriptor),
    load: async (name): Promise<SkillContent | null> => {
      const skill = byName.get(name);
      return skill ? { ...descriptor(skill), body: skillBody(skill) } : null;
    },
  };
}

/** What `activate_skill` hands the agent: the instructions, then the tools the skill works with. */
export function skillBody(skill: SkillInput): string {
  if (!skill.tools.length) return skill.instructions;
  return `${skill.instructions}\n\nTools this skill works with: ${skill.tools.join(", ")}. Prefer these; a tool not in this chat is unavailable, so say so instead of guessing.`;
}
