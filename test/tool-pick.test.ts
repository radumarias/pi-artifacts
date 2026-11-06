import { describe, expect, it } from "vitest";
import type { ClassifierModel } from "@earendil-works/pi-ai";
import { CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai.models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createToolSearchExtension, TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";
import { MCP_DISCOVER_TOOL } from "../shared/protocol.ts";
import { mcpExtension } from "../worker/agent/mcp.ts";
import {
  deferredTools,
  MAX_PICKED,
  NO_TOOL,
  pickerId,
  pickTools,
  selectTools,
  toolPicker,
  toolsToOffer,
  type PickableTool,
} from "../worker/agent/tool-pick.ts";
import { McpHub } from "../worker/mcp/hub.ts";

const jev = CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS["typesafe/jev"] as ClassifierModel<"cloudflare-workers-ai-system-one">;

const tools = (n: number): PickableTool[] =>
  Array.from({ length: n }, (_, i) => ({ name: `portal__tool_${i}`, description: `[MCP server "portal", tool "tool_${i}"] Tool number ${i}` }));

/** The AI binding, answering each run with `reply` (given the run's input). */
const binding = (reply: (input: Record<string, unknown>) => unknown) => {
  const runs: { model: string; input: Record<string, unknown>; signal?: AbortSignal }[] = [];
  const ai = {
    run: async (model: string, input: object, options?: { signal?: AbortSignal }) => {
      runs.push({ model, input: input as Record<string, unknown>, signal: options?.signal });
      return reply(input as Record<string, unknown>);
    },
  };
  return { ai, runs };
};

const answer = (probabilities: Record<string, number>) => {
  const [choice] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
  return { answers: { tool: { type: "choice", choice, confidence: probabilities[choice], probabilities } }, usage: { input_tokens: 500 } };
};

type Question = { type: string; instructions: string; criteria: Record<string, string> };

describe("the tool picker", () => {
  it("is the System One model TOOL_PICK_MODEL names, or none", () => {
    expect(toolPicker("system-one:typesafe/jev")).toBe(jev);
    expect(toolPicker(" system-one:typesafe/jev ")).toBe(jev);
    expect(toolPicker("typesafe/jev")).toBeUndefined();
    expect(toolPicker("")).toBeUndefined();
    expect(toolPicker(undefined)).toBeUndefined();
    expect(toolPicker("nobody/unlisted")).toBeUndefined();
    expect(pickerId(jev)).toBe("cloudflare-workers-ai/typesafe/jev");
  });

  it("asks Jev one choice among the tools and none, through the AI binding, and offers the likely ones", async () => {
    const { ai, runs } = binding(() => answer({ [NO_TOOL]: 0.05, portal__tool_3: 0.6, portal__tool_7: 0.3, portal__tool_1: 0.02 }));
    const picked = await pickTools(
      ai,
      jev,
      { message: "sales by region", history: [{ from: "person", text: "hi" }], tools: tools(20) },
      AbortSignal.timeout(1_000),
    );
    expect(picked.tools).toEqual(["portal__tool_3", "portal__tool_7"]);
    expect(picked.usage.input).toBe(500);
    expect(picked.usage.cost.total).toBeCloseTo(0.000021, 12);
    expect(runs).toHaveLength(1);
    expect(runs[0].model).toBe("typesafe/jev");
    expect(runs[0].signal).toBeInstanceOf(AbortSignal);
    const { tool } = runs[0].input.questions as { tool: Question };
    expect(tool.type).toBe("choice");
    expect(Object.keys(tool.criteria)).toEqual([NO_TOOL, ...tools(20).map((t) => t.name)]);
    expect(tool.criteria.portal__tool_3).toBe('[MCP server "portal", tool "tool_3"] Tool number 3');
    expect(runs[0].input.state).toEqual({ conversation: [{ from: "person", text: "hi" }], message: "sales by region" });
  });

  it("offers none when the message needs none", async () => {
    const { ai } = binding(() => answer({ [NO_TOOL]: 0.98, portal__tool_3: 0.01, portal__tool_7: 0.01 }));
    const picked = await pickTools(ai, jev, { message: "thanks!", history: [], tools: tools(20) }, AbortSignal.timeout(1_000));
    expect(picked.tools).toEqual([]);
  });

  it("asks about more than one question holds in parallel, and adds up what they cost", async () => {
    const { ai, runs } = binding((input) => {
      const { tool } = input.questions as { tool: Question };
      const names = Object.keys(tool.criteria).filter((name) => name !== NO_TOOL);
      return answer({ [NO_TOOL]: 0.1, [names[0]]: 0.9 });
    });
    const picked = await pickTools(ai, jev, { message: "x", history: [], tools: tools(300) }, AbortSignal.timeout(1_000));
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => Object.keys((run.input.questions as { tool: Question }).tool.criteria).length)).toEqual([151, 151]);
    expect(picked.tools).toEqual(["portal__tool_0", "portal__tool_150"]);
    expect(picked.usage.input).toBe(1_000);
  });

  it("fails when the binding throws, takes too long, or answers no choice", async () => {
    const failing = binding(() => {
      throw new Error("model not found");
    });
    await expect(pickTools(failing.ai, jev, { message: "x", history: [], tools: tools(20) }, AbortSignal.timeout(1_000))).rejects.toThrow(
      "model not found",
    );
    const slow = { run: () => new Promise<never>(() => {}) };
    await expect(pickTools(slow, jev, { message: "x", history: [], tools: tools(20) }, AbortSignal.timeout(50))).rejects.toThrow();
    const odd = binding(() => ({ answers: {} }));
    await expect(pickTools(odd.ai, jev, { message: "x", history: [], tools: tools(20) }, AbortSignal.timeout(1_000))).rejects.toThrow();
  });
});

describe("the tools picked", () => {
  const names = new Set(tools(20).map((tool) => tool.name));

  it("are the likely ones, best first, within MAX_PICKED, and only tools that are listed", () => {
    const probabilities = Object.entries({ portal__tool_1: 0.2, portal__tool_2: 0.5, made_up: 0.3, [NO_TOOL]: 0.0 });
    expect(selectTools(probabilities, names)).toEqual(["portal__tool_2", "portal__tool_1"]);
    const flat = tools(20).map((tool): [string, number] => [tool.name, 0.05]);
    expect(selectTools(flat, names)).toHaveLength(MAX_PICKED);
  });

  it("leave out the unlikely: under 3%, or under a tenth of the best", () => {
    expect(selectTools(Object.entries({ portal__tool_1: 0.9, portal__tool_2: 0.08, portal__tool_3: 0.02 }), names)).toEqual(["portal__tool_1"]);
  });

  it("are offered in the given order, with a running reply's kept, and not again when nothing changes", () => {
    const registered = tools(5);
    expect(toolsToOffer(registered, ["portal__tool_3", "portal__tool_1"], [], false)?.map((tool) => tool.name)).toEqual([
      "portal__tool_1",
      "portal__tool_3",
    ]);
    expect(toolsToOffer(registered, ["portal__tool_3"], ["portal__tool_0"], false)?.map((tool) => tool.name)).toEqual(["portal__tool_3"]);
    expect(toolsToOffer(registered, ["portal__tool_3"], ["portal__tool_0"], true)?.map((tool) => tool.name)).toEqual([
      "portal__tool_0",
      "portal__tool_3",
    ]);
    expect(toolsToOffer(registered, ["portal__tool_3", "portal__tool_0"], ["portal__tool_0", "portal__tool_3"], false)).toBeUndefined();
    expect(toolsToOffer(registered, [], [], false)).toBeUndefined();
    // One no longer registered (its server is gone) is not offered.
    expect(toolsToOffer(registered, ["gone__tool"], ["portal__tool_0"], false)).toEqual([]);
  });
});

describe("deferred MCP tools", () => {
  const hub = new McpHub([], async () => {
    throw new Error("unused");
  });
  const catalog = new Map([["portal", { tools: [{ name: "reports_run", description: "Run a report" }] }]]);
  const discover = async () => "";

  it("are pi's deferred tools, which the prompt says to load with tool_search; mcp_discover is always offered", () => {
    const { extension, summary } = mcpExtension(hub, catalog, new Map(), discover, { deferred: true });
    const byName = new Map(extension.tools!.map((tool) => [tool.name, tool]));
    expect(byName.get("portal__reports_run")?.deferred).toBe(true);
    expect(byName.get(MCP_DISCOVER_TOOL)?.deferred).toBeUndefined();
    expect(summary).toContain(TOOL_SEARCH_TOOL_NAME);
  });

  it("are offered as before without a picker", () => {
    const { extension, summary } = mcpExtension(hub, catalog, new Map(), discover);
    expect(extension.tools!.every((tool) => tool.deferred === undefined)).toBe(true);
    expect(summary).not.toContain(TOOL_SEARCH_TOOL_NAME);
  });
});

describe("pi, with the MCP tools deferred", () => {
  it("offers the model only the picks, tool_search and mcp_discover, and the next message's picks in their place", async () => {
    const hub = new McpHub([], async () => {
      throw new Error("unused");
    });
    const catalog = new Map([["portal", { tools: ["a", "b", "c", "d"].map((name) => ({ name, description: `Tool ${name}` })) }]]);
    const { extension } = mcpExtension(hub, catalog, new Map(), async () => "", { deferred: true });
    const registry = createRegistry();
    registry.install(extension);
    registry.install(createToolSearchExtension());
    const pi = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, BACKGROUND_CONTEXT);
    try {
      const root = await pi.root(BACKGROUND_CONTEXT);
      const offered = async () => (await root.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name);
      expect(await offered()).toEqual([MCP_DISCOVER_TOOL, TOOL_SEARCH_TOOL_NAME]);
      // As the chat does it (#applyTools).
      const offer = async (picks: string[], busy = false) => {
        const agent = await root.agent(BACKGROUND_CONTEXT);
        const now = agent.tools.filter((tool) => tool.deferred).map((tool) => tool.name);
        const tools = toolsToOffer(deferredTools(agent), picks, now, busy);
        if (tools) await root.configure({ modelTools: { add: tools } }, BACKGROUND_CONTEXT);
      };
      await offer(["portal__c", "portal__a"]);
      expect(await offered()).toEqual([MCP_DISCOVER_TOOL, TOOL_SEARCH_TOOL_NAME, "portal__a", "portal__c"]);
      await offer(["portal__b"]);
      expect(await offered()).toEqual([MCP_DISCOVER_TOOL, TOOL_SEARCH_TOOL_NAME, "portal__b"]);
      await offer(["portal__d"], true);
      expect(await offered()).toEqual([MCP_DISCOVER_TOOL, TOOL_SEARCH_TOOL_NAME, "portal__b", "portal__d"]);
      expect((await root.agent(BACKGROUND_CONTEXT)).deferred.map((tool) => tool.name)).toEqual(["portal__a", "portal__c"]);
    } finally {
      await pi.close(BACKGROUND_CONTEXT);
    }
  });
});
