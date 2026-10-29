// Skills: named ways of working the agent picks for itself. Each one says
// when to use it, how to work (instructions and guardrails) and which tools
// it works with. Only names and descriptions are in the system prompt; the
// agent activates a skill to read the rest.

/** Lowercase words joined by hyphens, as in the Agent Skills format. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SKILL_NAME = 64;
export const MAX_SKILL_DESCRIPTION = 1_024;
export const MAX_SKILL_INSTRUCTIONS = 20_000;
export const MAX_SKILL_TOOLS = 30;
/** Agent tool names: what the model calls, e.g. run_python or a server's slug and tool. */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Per user, not counting the built-in ones. */
export const MAX_USER_SKILLS = 50;
/** Proposals from the agent waiting for review, within MAX_USER_SKILLS: one chat cannot fill the user's list. */
export const MAX_SKILL_PROPOSALS = 10;

/** What a skill is made of, whoever wrote it. */
export interface SkillInput {
  name: string;
  /** When to use it: the only part the agent sees before activating it. */
  description: string;
  /** How to work: steps, rules and guardrails, in Markdown. */
  instructions: string;
  /** The agent tools it works with. Shown on activation as guidance; not a sandbox. */
  tools: string[];
}

/**
 * Where a skill comes from: shipped with the app, written by the user,
 * or proposed by the agent in a chat (saved off until the user turns it on).
 */
export type SkillOrigin = "builtin" | "user" | "agent";
/** The origins a saved skill can have. */
export type SavedSkillOrigin = Exclude<SkillOrigin, "builtin">;

/** A skill as GET /api/skills lists it. */
export interface SkillInfo extends SkillInput {
  origin: SkillOrigin;
  enabled: boolean;
  /** Epoch ms; 0 for built-in skills. */
  updatedAt: number;
  /** A built-in skill that one of the user's own, turned on, has the same name as: the agent gets the user's. */
  replaced?: true;
}

/** Whether the agent gets this skill: it is on, and no skill of the user's own with its name replaces it. */
export function isActive(skill: Pick<SkillInfo, "enabled" | "replaced">): boolean {
  return skill.enabled && !skill.replaced;
}

/**
 * Built-in and user skills are kept apart: each kind has its own names and its own
 * routes, so a built-in added later never takes over a user's skill. The agent
 * activates skills by name alone, so where names meet, the user's own (when on) wins.
 */
export function skillPath(skill: Pick<SkillInfo, "name" | "origin">): string {
  return skill.origin === "builtin" ? `/api/skills/builtin/${skill.name}` : `/api/skills/${skill.name}`;
}

/** A failed skill change, with what to fix: RPC keeps an error's message but not its class. */
export type SkillResult = SkillInfo | { error: string };

/** A tool list as people write it: names separated by spaces or commas. */
export function splitTools(list: string): string[] {
  return list.split(/[\s,]+/).filter(Boolean);
}

/** A skill's fields trimmed, with the tool list deduplicated. Throws with what to fix. */
export function checkSkill(input: unknown): SkillInput {
  const value = (input ?? {}) as Partial<Record<keyof SkillInput, unknown>>;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const description = typeof value.description === "string" ? value.description.trim().replace(/\s+/g, " ") : "";
  const instructions = typeof value.instructions === "string" ? value.instructions.trim() : "";
  const listed = Array.isArray(value.tools) ? value.tools : value.tools === undefined ? [] : null;
  const tools = listed && [...new Set(listed.map((tool) => (typeof tool === "string" ? tool.trim() : "")))];
  const problems: string[] = [];
  if (!SKILL_NAME_PATTERN.test(name) || name.length > MAX_SKILL_NAME) {
    problems.push(`The name must be up to ${MAX_SKILL_NAME} lowercase letters, digits and single hyphens, e.g. "weekly-report".`);
  }
  if (!description) problems.push("Say when to use the skill in its description.");
  else if (description.length > MAX_SKILL_DESCRIPTION) problems.push(`The description is over ${MAX_SKILL_DESCRIPTION} characters.`);
  if (!instructions) problems.push("Give the skill instructions.");
  else if (instructions.length > MAX_SKILL_INSTRUCTIONS) problems.push(`The instructions are over ${MAX_SKILL_INSTRUCTIONS} characters.`);
  if (!tools || tools.some((tool) => !TOOL_NAME_PATTERN.test(tool))) problems.push("Tools must be a list of tool names (letters, digits, _ and -).");
  else if (tools.length > MAX_SKILL_TOOLS) problems.push(`A skill can name up to ${MAX_SKILL_TOOLS} tools.`);
  if (problems.length || !tools) throw new SkillError(problems.join(" "));
  return { name, description, instructions, tools };
}

/** A skill that cannot be saved as given; the message says why. */
export class SkillError extends Error {
  override name = "SkillError";
}
