import { describe, expect, it } from "vitest";
import { SKILL_THRESHOLD, skillClassifier, skillMessage, SKILLS_PER_CALL, type SkillPickRequest } from "../worker/agent/skill-pick.ts";
import { skillSource } from "../worker/agent/skills.ts";
import type { SkillInfo } from "../shared/skills.ts";

/** The AI binding, answering each run with `reply` (given the run's questions). */
function binding(reply: (questions: Record<string, unknown>) => unknown) {
  const runs: { model: string; input: Record<string, unknown> }[] = [];
  const ai = {
    run: async (model: string, input: object) => {
      runs.push({ model, input: input as Record<string, unknown> });
      return reply((input as { questions: Record<string, unknown> }).questions);
    },
  };
  return { ai, runs };
}

/** Jev's answer: each question's probability of yes, from `yes`. */
const answers = (yes: (name: string) => number) => (questions: Record<string, unknown>) => ({
  answers: Object.fromEntries(Object.keys(questions).map((name) => [name, { type: "noul", noul: yes(name) }])),
  usage: { input_tokens: 500 },
});

const skills = [
  { name: "analyze-files", description: "Use when the user asks about their uploaded files." },
  { name: "revise-artifact", description: "Use when the user wants to change a published page." },
  { name: "explore-mcp-server", description: "Use when the user asks what a server can do." },
];
const request = (over: Partial<SkillPickRequest> = {}): SkillPickRequest => ({
  message: "What is the average in sales.csv?",
  history: [{ from: "agent", text: "Hi! What shall we build?" }],
  skills,
  ...over,
});

describe("the skill classifier", () => {
  it("is the System One model SKILLS_MODEL names by its id, or none, so every skill is shown", () => {
    const { ai } = binding(() => ({}));
    expect(skillClassifier("typesafe/jev", ai)?.id).toBe("cloudflare-workers-ai/typesafe/jev");
    expect(skillClassifier("", ai)).toBeUndefined();
    expect(skillClassifier("nobody/unknown", ai)).toBeUndefined();
    // By its id alone, as CALL_HINT_MODEL names it: ROUTER_MODEL's marker is not part of it.
    expect(skillClassifier("system-one:typesafe/jev", ai)).toBeUndefined();
  });

  it("asks Jev one yes-or-no question per skill, with the message and the conversation, and keeps the likely ones", async () => {
    const { ai, runs } = binding(answers((name) => (name === "analyze-files" ? 0.92 : name === "explore-mcp-server" ? SKILL_THRESHOLD : 0.05)));
    const pick = await skillClassifier("typesafe/jev", ai)!.pick(request());
    expect(pick.add).toEqual(["analyze-files", "explore-mcp-server"]);
    expect(pick.errors).toEqual([]);
    expect(pick.usage.input).toBe(500);
    expect(runs).toHaveLength(1);
    expect(runs[0].model).toBe("typesafe/jev");
    const questions = runs[0].input.questions as Record<string, { type: string; instructions: string }>;
    expect(Object.keys(questions)).toEqual(skills.map(({ name }) => name));
    expect(questions["analyze-files"].type).toBe("noul");
    expect(questions["analyze-files"].instructions).toContain(skills[0].description);
    expect(runs[0].input.state).toEqual({ conversation: [{ from: "agent", text: "Hi! What shall we build?" }], message: request().message });
  });

  it("asks about many skills in calls of SKILLS_PER_CALL at once, and adds up what they cost", async () => {
    const many = Array.from({ length: SKILLS_PER_CALL + 3 }, (_, i) => ({ name: `skill-${i}`, description: `Skill ${i}.` }));
    const { ai, runs } = binding(answers((name) => (name === "skill-17" ? 0.8 : 0)));
    const pick = await skillClassifier("typesafe/jev", ai)!.pick(request({ skills: many }));
    expect(runs.map((run) => Object.keys(run.input.questions as object).length)).toEqual([SKILLS_PER_CALL, 3]);
    expect(pick.add).toEqual(["skill-17"]);
    expect(pick.usage.input).toBe(1_000);
  });

  it("leaves the skills of a call that fails, or takes too long, unanswered, so they are shown as before", async () => {
    const failing = binding(() => {
      throw new Error("model not found");
    });
    const failed = await skillClassifier("typesafe/jev", failing.ai)!.pick(request());
    expect(failed.add).toEqual(skills.map(({ name }) => name));
    expect(failed.errors[0]).toMatch(/model not found/);

    const slow = { run: () => new Promise<never>(() => {}) };
    const late = await skillClassifier("typesafe/jev", slow)!.pick(request(), 30);
    expect(late.add).toHaveLength(skills.length);

    const odd = binding(() => ({ answers: {} }));
    expect((await skillClassifier("typesafe/jev", odd.ai)!.pick(request())).add).toHaveLength(skills.length);
  });
});

describe("the skills shown", () => {
  it("are all the agent's skill source lists, and they name its fingerprint", async () => {
    const info = (name: string): SkillInfo => ({
      name,
      description: `${name}.`,
      instructions: "Do it.",
      tools: [],
      origin: "user",
      enabled: true,
      updatedAt: 1,
    });
    const listed = [info("analyze-files"), info("revise-artifact"), { ...info("drafted"), enabled: false }];
    const shown = new Set(["revise-artifact", "drafted"]);
    const source = skillSource(listed, "v1", shown);
    expect((await source.list()).map((skill) => skill.name)).toEqual(["revise-artifact"]);
    expect(await source.load("analyze-files")).toBeNull();
    // The names listed: one shown but turned off changes nothing.
    expect(source.fingerprint).toBe("v1|revise-artifact");
    expect(skillSource(listed, "v1").fingerprint).toBe("v1");
    expect(skillSource(listed, "v1", new Set()).fingerprint).toBe("v1|");
  });

  it("are picked from the message's text and the names of the files it attaches", () => {
    expect(skillMessage("Sum this", ["uploads/2026/sales.csv"])).toBe("Sum this\n[attached: sales.csv]");
    expect(skillMessage("", ["uploads/a.csv", "b.json"])).toBe("[attached: a.csv, b.json]");
    expect(skillMessage("Hi", [])).toBe("Hi");
  });
});
