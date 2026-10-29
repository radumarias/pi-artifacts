import type { SkillContent, SkillSource } from "agents/skills";
import { parse, stringify } from "yaml";
import { checkSkill, SkillError, type SkillInfo, type SkillInput } from "../../shared/skills.ts";
import analyzeFiles from "./skills/analyze-files/SKILL.md?raw";
import exploreMcpServer from "./skills/explore-mcp-server/SKILL.md?raw";
import reviseArtifact from "./skills/revise-artifact/SKILL.md?raw";

/**
 * A skill from a SKILL.md file (the Agent Skills format): YAML frontmatter with
 * `name`, `description` and an optional space-separated `allowed-tools`, then
 * the instructions. Throws with what to fix.
 */
export function parseSkillMarkdown(markdown: string): SkillInput {
  const match = markdown.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/);
  if (!match) throw new SkillError("A SKILL.md starts with a --- block holding name: and description:.");
  let data: unknown;
  try {
    data = parse(match[1]);
  } catch (error) {
    throw new SkillError(`The --- block is not valid YAML: ${(error as Error).message.split("\n")[0]}`);
  }
  const front = (data && typeof data === "object" && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
  const allowed = front["allowed-tools"];
  const tools = typeof allowed === "string" ? allowed.split(/[\s,]+/).filter(Boolean) : Array.isArray(allowed) ? allowed : allowed == null ? [] : null;
  return checkSkill({ name: front.name, description: front.description, instructions: match[2] ?? "", tools });
}

/** A skill as a SKILL.md file, which parseSkillMarkdown reads back. */
export function formatSkillMarkdown(skill: SkillInput): string {
  const front: Record<string, string> = { name: skill.name, description: skill.description };
  if (skill.tools.length) front["allowed-tools"] = skill.tools.join(" ");
  return `---\n${stringify(front, { lineWidth: 0 })}---\n${skill.instructions}\n`;
}

/** The skills every user has, unless they turn one off. They ship as SKILL.md files beside this module. */
export const BUILTIN_SKILLS: readonly SkillInput[] = [analyzeFiles, reviseArtifact, exploreMcpServer].map(parseSkillMarkdown);

export function isBuiltinSkill(name: string): boolean {
  return BUILTIN_SKILLS.some((skill) => skill.name === name);
}

/**
 * The enabled skills as one source for `skills()` from agents/harness/pi, which
 * lists their descriptions in the system prompt and adds `activate_skill`.
 * The fingerprint changes whenever a skill does, so the chat reinstalls only then.
 */
export function skillSource(skills: readonly SkillInfo[]): SkillSource {
  const enabled = skills.filter((skill) => skill.enabled);
  const byName = new Map(enabled.map((skill) => [skill.name, skill]));
  const descriptor = (skill: SkillInfo) => ({ name: skill.name, description: skill.description, sourceId: "pi-artifacts", version: skill.updatedAt ? String(skill.updatedAt) : undefined });
  return {
    id: "pi-artifacts",
    fingerprint: skillsFingerprint(enabled),
    list: async () => enabled.map(descriptor),
    load: async (name): Promise<SkillContent | null> => {
      const skill = byName.get(name);
      return skill ? { ...descriptor(skill), body: skillBody(skill) } : null;
    },
  };
}

export function skillsFingerprint(skills: readonly SkillInfo[]): string {
  return JSON.stringify(skills.filter((skill) => skill.enabled).map((skill) => [skill.name, skill.origin, skill.updatedAt]));
}

/** What `activate_skill` hands the agent: the instructions, then the tools the skill works with. */
export function skillBody(skill: SkillInput): string {
  if (!skill.tools.length) return skill.instructions;
  return `${skill.instructions}\n\nTools this skill works with: ${skill.tools.join(", ")}. Prefer these; a tool not in this chat is unavailable, so say so instead of guessing.`;
}
