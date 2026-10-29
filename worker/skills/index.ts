import { parse, stringify } from "yaml";
import { errorMessage } from "../../shared/util.ts";
import { checkSkill, SkillError, splitTools, type SkillInput } from "../../shared/skills.ts";
import analyzeFiles from "./builtin/analyze-files/SKILL.md?raw";
import exploreMcpServer from "./builtin/explore-mcp-server/SKILL.md?raw";
import reviseArtifact from "./builtin/revise-artifact/SKILL.md?raw";

/**
 * A skill from a SKILL.md file (the Agent Skills format): YAML frontmatter with
 * `name`, `description` and an optional space-separated `allowed-tools`, then
 * the instructions. Throws with what to fix.
 */
export function parseSkillFile(markdown: string): SkillInput {
  const match = markdown.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/);
  if (!match) throw new SkillError("A SKILL.md starts with a --- block holding name: and description:.");
  let data: unknown;
  try {
    data = parse(match[1]);
  } catch (error) {
    throw new SkillError(`The --- block is not valid YAML: ${errorMessage(error).split("\n")[0]}`);
  }
  const front = (data && typeof data === "object" && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
  const allowed = front["allowed-tools"];
  const tools = typeof allowed === "string" ? splitTools(allowed) : Array.isArray(allowed) ? allowed : allowed == null ? [] : null;
  return checkSkill({ name: front.name, description: front.description, instructions: match[2] ?? "", tools });
}

/** A skill as a SKILL.md file, which parseSkillFile reads back. */
export function formatSkillFile(skill: SkillInput): string {
  const front: Record<string, string> = { name: skill.name, description: skill.description };
  if (skill.tools.length) front["allowed-tools"] = skill.tools.join(" ");
  return `---\n${stringify(front, { lineWidth: 0 })}---\n${skill.instructions}\n`;
}

/** The skills every user has, unless they turn one off. They ship as SKILL.md files in ./builtin/. */
export const BUILTIN_SKILLS: readonly SkillInput[] = [analyzeFiles, reviseArtifact, exploreMcpServer].map(parseSkillFile);

export function builtinSkill(name: string): SkillInput | undefined {
  return BUILTIN_SKILLS.find((skill) => skill.name === name);
}
