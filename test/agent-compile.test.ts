import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "../shared/agents.ts";
import { compilePrompt, compileWorkflow, parseWorkflow } from "../worker/agents/runs/compile.ts";

const agent: AgentDefinition = {
  id: "a1b2c3d4e5f60718",
  name: "brief",
  avatar: "br",
  color: "blue",
  job: "Morning brief",
  instructions: "1. Look at the week's sales.\n2. Only if they fell more than 5%, say why.\n3. Tell me.",
  autonomy: 1,
  origin: "user",
  enabled: true,
  version: 3,
  createdAt: 1,
  updatedAt: 1,
  trigger: { kind: "schedule", at: "07:00", tz: "Europe/Bucharest" },
};

const steps = [
  { kind: "look", server: "crm", tool: "weekly_sales", input: {}, as: "sales" },
  { kind: "onlyIf", condition: "sales.total vs sales.lastYear < -5%" },
  { kind: "work", prompt: "Say why sales fell." },
  { kind: "tell", to: ["owner"], via: "chat" },
];

describe("compiling instructions to a workflow", () => {
  it("lists the agent's fields and its servers' tools, read-only marked", () => {
    const prompt = compilePrompt(agent, [
      { server: "crm", tools: [{ name: "weekly_sales", description: "Sales by week", annotations: { readOnlyHint: true } }, { name: "update", description: "Change" }] },
    ]);
    expect(prompt).toContain("<instructions>\n1. Look at the week's sales.");
    expect(prompt).toContain('"trigger":{"kind":"schedule","at":"07:00","tz":"Europe/Bucharest"}');
    expect(prompt).toContain("- weekly_sales (read-only): Sales by week");
    expect(prompt).toContain("- update (writes): Change");
  });

  it("takes the steps out of a reply, fenced or not, checked as the agent's workflow", () => {
    expect(parseWorkflow(`Here:\n\`\`\`json\n${JSON.stringify(steps)}\n\`\`\``, agent)).toEqual(steps);
    expect(() => parseWorkflow("No steps.", agent)).toThrow("no list of steps");
    expect(() => parseWorkflow("[{]", agent)).toThrow("not JSON");
    expect(() => parseWorkflow("[]", agent)).toThrow("empty");
    expect(() => parseWorkflow('[{"kind":"fly"}]', agent)).toThrow("Each step is one of");
    expect(() => parseWorkflow('[{"kind":"onlyIf","condition":"sales are down"}]', agent)).toThrow("does not read");
  });

  it("asks the model once, at low effort, and gives back the checked steps", async () => {
    const asked: { options: unknown }[] = [];
    const models = {
      completeSimple: async (_model: unknown, _context: unknown, options: unknown) => {
        asked.push({ options });
        return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify(steps) }], usage: {} };
      },
    } as unknown as Models;
    const model = { provider: "anthropic", id: "m", reasoning: true, thinkingLevels: ["low", "medium"] } as unknown as Model<Api>;
    const { workflow } = await compileWorkflow(models, model, agent, []);
    expect(workflow).toEqual(steps);
    expect(asked).toHaveLength(1);
    expect(asked[0].options).toMatchObject({ maxTokens: 6000 });
  });
});
