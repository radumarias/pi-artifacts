import { describe, expect, it } from "vitest";
import { checkSkill, MAX_SKILL_INSTRUCTIONS, SkillError, type SkillInfo } from "../shared/skills.ts";
import { BUILTIN_SKILLS, formatSkillMarkdown, isBuiltinSkill, parseSkillMarkdown, skillBody, skillSource, skillsFingerprint } from "../worker/agent/skills.ts";

const skill = { name: "weekly-report", description: "Use when the user asks for the weekly report.", instructions: "1. Read the data.\n2. Publish.", tools: ["files_read", "run_python"] };
const info = (over: Partial<SkillInfo> = {}): SkillInfo => ({ ...skill, origin: "user", enabled: true, updatedAt: 1, ...over });

describe("checkSkill", () => {
  it("trims, collapses the description and deduplicates tools", () => {
    expect(checkSkill({ ...skill, name: " weekly-report ", description: "Use when\n  asked.", tools: ["run_python", " run_python"] })).toEqual({
      ...skill,
      description: "Use when asked.",
      tools: ["run_python"],
    });
  });

  it("defaults tools to none", () => {
    expect(checkSkill({ ...skill, tools: undefined }).tools).toEqual([]);
  });

  it.each([
    ["an upper-case name", { name: "Weekly" }],
    ["a name with spaces", { name: "weekly report" }],
    ["a double hyphen", { name: "weekly--report" }],
    ["a long name", { name: "a".repeat(65) }],
    ["no description", { description: "  " }],
    ["no instructions", { instructions: "" }],
    ["long instructions", { instructions: "x".repeat(MAX_SKILL_INSTRUCTIONS + 1) }],
    ["a tool that is not a name", { tools: ["rm -rf"] }],
    ["tools that are not a list", { tools: "run_python" }],
    ["too many tools", { tools: Array.from({ length: 31 }, (_, n) => `t${n}`) }],
  ])("rejects %s", (_, change) => {
    expect(() => checkSkill({ ...skill, ...change })).toThrow(SkillError);
  });

  it("rejects what is not an object", () => {
    expect(() => checkSkill(null)).toThrow(SkillError);
    expect(() => checkSkill("weekly-report")).toThrow(SkillError);
  });
});

describe("SKILL.md", () => {
  it("round-trips through format and parse", () => {
    expect(parseSkillMarkdown(formatSkillMarkdown(skill))).toEqual(skill);
  });

  it("quotes a description YAML would misread", () => {
    const tricky = { ...skill, description: "Use when: the user says \"report\" # weekly", tools: [] };
    const markdown = formatSkillMarkdown(tricky);
    expect(markdown).not.toContain("allowed-tools");
    expect(parseSkillMarkdown(markdown)).toEqual(tricky);
  });

  it("reads allowed-tools as a space- or comma-separated string, or a list", () => {
    const head = "---\nname: a\ndescription: Use when.\n";
    expect(parseSkillMarkdown(`${head}allowed-tools: files_read, run_python\n---\nGo.`).tools).toEqual(["files_read", "run_python"]);
    expect(parseSkillMarkdown(`${head}allowed-tools:\n  - files_read\n---\nGo.`).tools).toEqual(["files_read"]);
  });

  it("accepts CRLF line ends and a byte-order mark", () => {
    expect(parseSkillMarkdown("﻿---\r\nname: a\r\ndescription: Use when.\r\n---\r\nGo.").name).toBe("a");
  });

  it.each([
    ["no frontmatter", "# Weekly report\nDo things."],
    ["invalid YAML", "---\nname: [a\ndescription: x\n---\nGo."],
    ["no name", "---\ndescription: Use when.\n---\nGo."],
    ["no body", "---\nname: a\ndescription: Use when.\n---\n"],
  ])("rejects %s", (_, markdown) => {
    expect(() => parseSkillMarkdown(markdown)).toThrow(SkillError);
  });
});

describe("built-in skills", () => {
  it("are valid and have distinct names", () => {
    expect(BUILTIN_SKILLS.length).toBeGreaterThan(0);
    for (const builtin of BUILTIN_SKILLS) expect(checkSkill(builtin)).toEqual(builtin);
    expect(new Set(BUILTIN_SKILLS.map((s) => s.name)).size).toBe(BUILTIN_SKILLS.length);
    expect(isBuiltinSkill(BUILTIN_SKILLS[0].name)).toBe(true);
    expect(isBuiltinSkill("weekly-report")).toBe(false);
  });
});

describe("skillSource", () => {
  it("lists and loads only enabled skills", async () => {
    const source = skillSource([info(), info({ name: "draft", origin: "agent", enabled: false })]);
    expect((await source.list()).map((d) => d.name)).toEqual(["weekly-report"]);
    expect(await source.load("draft")).toBeNull();
    const loaded = await source.load("weekly-report");
    expect(loaded?.description).toBe(skill.description);
    expect(loaded?.body).toBe(skillBody(skill));
    expect(loaded?.body).toContain("files_read, run_python");
  });

  it("leaves the tools line out when a skill names none", () => {
    expect(skillBody({ ...skill, tools: [] })).toBe(skill.instructions);
  });

  it("changes its fingerprint when an enabled skill changes, and only then", () => {
    const base = skillsFingerprint([info(), info({ name: "draft", enabled: false })]);
    expect(skillsFingerprint([info(), info({ name: "draft", enabled: false, updatedAt: 9 })])).toBe(base);
    expect(skillsFingerprint([info({ updatedAt: 2 })])).not.toBe(base);
    expect(skillsFingerprint([info(), info({ name: "draft" })])).not.toBe(base);
    expect(skillSource([info()]).fingerprint).toBe(skillsFingerprint([info()]));
  });
});
