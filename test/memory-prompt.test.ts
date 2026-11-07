import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, Type, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTool, GenerationTask, Harness, hook, MemoryStorage, section } from "@earendil-works/pi-durable";
import { MEMORY_FORGET_TOOL, MEMORY_RECALL_TOOL } from "../shared/memory.ts";
import { text } from "../worker/agent/output.ts";
import { freshPrompt, withoutSummaries } from "../worker/memory/fresh.ts";

/**
 * pi over a faux model with one `memory` section whose text the test sets, a memory_recall that finds the owner's
 * note and a memory_forget that quotes one, the messages each request carried, and the replies to give (`replies`,
 * else "ok"). A compaction's summary is `summary`, given once `summarizing` (when set) resolves; a large
 * `contextWindow` keeps pi from compacting on its own.
 */
async function piWithMemory(
  replies: AssistantMessage[] = [],
  {
    summary = "Summary: nothing to note.",
    summarizing,
    contextWindow,
  }: { summary?: string; summarizing?: (signal?: AbortSignal) => Promise<void>; contextWindow?: number } = {},
) {
  const faux = fauxProvider({ models: [{ id: "m", contextWindow }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: Message[][] = [];
  faux.setResponses(
    Array.from({ length: 8 }, () => (context: { messages: Message[]; systemPrompt?: string }, options?: { signal?: AbortSignal }) => {
      // A compaction's request asks for a summary, in its own instructions.
      if (JSON.stringify(context).includes("context summarization assistant"))
        return summarizing ? summarizing(options?.signal).then(() => fauxAssistantMessage(summary)) : fauxAssistantMessage(summary);
      requests.push(structuredClone(context.messages));
      return replies.shift() ?? fauxAssistantMessage("ok");
    }),
  );
  const notes = { text: "" };
  const registry = createRegistry();
  const recall = defineTool({
    name: MEMORY_RECALL_TOOL,
    description: "Look through the memory notes.",
    parameters: Type.Object({}),
    execute: async () => ({ output: text("- [a2] (just me) My bonus is private too.") }),
  });
  const forget = defineTool({
    name: MEMORY_FORGET_TOOL,
    description: "Forget a memory note.",
    parameters: Type.Object({}),
    execute: async () => ({ output: text("Forgot [a3]: “My bonus is private too.”") }),
  });
  // While `leaving`, each request leaves out summaries, as the memory extension's hook does (MemoryHost.leavesOutSummaries).
  const leaving = { on: false };
  const leaveOut = hook(GenerationTask, { beforeRequest: ({ messages }) => (leaving.on ? { messages: withoutSummaries(messages) } : undefined) });
  registry.install(defineExtension({ name: "memory", sections: [section("memory", () => notes.text)], tools: [recall, forget], hooks: [leaveOut] }));
  const pi = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  const root = await pi.root(BACKGROUND_CONTEXT);
  await root.configure({ model: { provider: faux.provider.id, modelId: "m" } }, BACKGROUND_CONTEXT);
  const ask = async (text: string) => (await root.submit({ type: "input", content: text }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
  return { pi, root, notes, ask, requests, leaving };
}

describe("a prompt that held the owner's own notes", () => {
  it("is not in the next request once the conversation starts its prompt afresh", async () => {
    const { pi, root, notes, ask, requests } = await piWithMemory();
    try {
      notes.text = "- [a1] (just me) My salary is private.";
      await ask("hello");
      expect(JSON.stringify(requests[0])).toContain("salary");
      // Shared: the section no longer holds the note, but the first prompt entry stays in the transcript.
      notes.text = "No notes yet.";
      await freshPrompt(root, pi);
      await ask("and now?");
      const next = JSON.stringify(requests[1]);
      expect(next).not.toContain("salary");
      expect(next).toContain("No notes yet.");
      expect(next).toContain("hello");
    } finally {
      await pi.close(BACKGROUND_CONTEXT);
    }
  });

  it("leaves out what memory_recall found, keeping the call answered", async () => {
    const { pi, root, notes, ask, requests } = await piWithMemory([
      fauxAssistantMessage(fauxToolCall(MEMORY_RECALL_TOOL, {}, { id: "c1" }), { stopReason: "toolUse" }),
    ]);
    try {
      notes.text = "No notes yet.";
      await ask("what do you know?");
      expect(JSON.stringify(requests.at(-1))).toContain("bonus");
      await freshPrompt(root, pi);
      await ask("and now?");
      const next = JSON.stringify(requests.at(-1));
      expect(next).not.toContain("bonus");
      expect(next).toContain("left out");
      expect(next).toContain("c1");
    } finally {
      await pi.close(BACKGROUND_CONTEXT);
    }
  });

  it("leaves out a summary of the conversation, which may have kept the notes", async () => {
    const { pi, root, notes, ask, requests } = await piWithMemory([], { summary: "Summary: the owner's bonus is private." });
    try {
      notes.text = "No notes yet.";
      await ask(`first ${"words ".repeat(30_000)}`);
      await ask(`second ${"words ".repeat(30_000)}`);
      await pi.waitForTask(await root.compact(undefined, BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
      await ask("third");
      expect(JSON.stringify(requests.at(-1))).toContain("bonus");
      await freshPrompt(root, pi);
      await ask("and now?");
      expect(JSON.stringify(requests.at(-1))).not.toContain("bonus");
    } finally {
      await pi.close(BACKGROUND_CONTEXT);
    }
  });

  it("leaves out what an earlier memory_forget said (results once quoted the note)", async () => {
    const { pi, root, notes, ask, requests } = await piWithMemory([
      fauxAssistantMessage(fauxToolCall(MEMORY_FORGET_TOOL, {}, { id: "c2" }), { stopReason: "toolUse" }),
    ]);
    try {
      notes.text = "No notes yet.";
      await ask("forget that note");
      expect(JSON.stringify(requests.at(-1))).toContain("bonus");
      await freshPrompt(root, pi);
      await ask("and now?");
      expect(JSON.stringify(requests.at(-1))).not.toContain("bonus");
    } finally {
      await pi.close(BACKGROUND_CONTEXT);
    }
  });

  /**
   * pi whose prompt held the owner's salary, two long messages in, and a compaction's summarizer (whose summary keeps
   * the salary) held at a gate: `summarizing` once it got there, until `release`d or stopped. `compacts` starts it by
   * hand (pi then never compacts on its own); else the second message's turn compacts first, and waits for it (`turn`).
   * The note is out of the section by then.
   */
  async function compacting(compacts: boolean) {
    let started!: () => void;
    const summarizing = new Promise<void>((resolve) => (started = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const wait = (signal?: AbortSignal) => {
      started();
      return Promise.race([released, new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()))]);
    };
    const summary = "Summary: the owner's salary is private.";
    const pi = await piWithMemory([], { summary, summarizing: wait, ...(compacts && { contextWindow: 10_000_000 }) });
    pi.notes.text = "- [a1] (just me) My salary is private.";
    await pi.ask(`first ${"words ".repeat(30_000)}`);
    const turn = pi.ask(`second ${"words ".repeat(30_000)}`);
    if (compacts) await turn;
    const compaction = compacts ? await pi.root.compact(undefined, BACKGROUND_CONTEXT) : undefined;
    await summarizing;
    pi.notes.text = "No notes yet.";
    return { ...pi, turn, compaction, release };
  }

  it("stops a compaction summarizing the context as it was, so its summary never comes in", async () => {
    const { pi, root, ask, requests, compaction, release } = await compacting(true);
    try {
      expect((await freshPrompt(root, pi)).compacting).toBeUndefined();
      expect((await pi.waitForTask(compaction!, BACKGROUND_CONTEXT)).state.outcome.status).toBe("aborted");
      await ask("and now?");
      expect(JSON.stringify(requests.at(-1))).not.toContain("salary");
      expect(JSON.stringify(requests.at(-1))).toContain("second");
    } finally {
      release();
      await pi.close(BACKGROUND_CONTEXT);
    }
  });

  it("leaves out a summary placed while it stopped the compactions", async () => {
    const { pi, root, ask, requests, compaction, release } = await compacting(true);
    try {
      // It finishes before it is stopped: its summary comes in after the first edits.
      const fresh = freshPrompt(root, pi);
      release();
      expect((await fresh).compacting).toBeUndefined();
      await pi.waitForTask(compaction!, BACKGROUND_CONTEXT);
      await ask("and now?");
      expect(JSON.stringify(requests.at(-1))).not.toContain("salary");
    } finally {
      await pi.close(BACKGROUND_CONTEXT);
    }
  });

  it("leaves out the summary of a compaction a turn waits for, from the turn's next request on", async () => {
    const { pi, root, ask, requests, turn, release, leaving } = await compacting(false);
    try {
      const { compacting } = await freshPrompt(root, pi);
      expect(compacting).toBeDefined();
      leaving.on = true;
      release();
      await compacting;
      const again = await freshPrompt(root, pi);
      expect(again.compacting).toBeUndefined();
      await turn;
      // The turn went on before the edits were in: its requests left the summary out themselves.
      expect(JSON.stringify(requests.at(-1))).toContain("second");
      expect(JSON.stringify(requests.at(-1))).not.toContain("salary");
      await again.placed;
      leaving.on = false;
      await ask("and now?");
      expect(JSON.stringify(requests.at(-1))).not.toContain("salary");
    } finally {
      release();
      await pi.close(BACKGROUND_CONTEXT);
    }
  });

  it("would carry the summary of a compaction a turn waits for without leaving it out", async () => {
    const { pi, root, requests, turn, release } = await compacting(false);
    try {
      await freshPrompt(root, pi);
      release();
      await turn;
      expect(JSON.stringify(requests.at(-1))).toContain("salary");
    } finally {
      release();
      await pi.close(BACKGROUND_CONTEXT);
    }
  });

  it("would still be there without it (what the fresh start is for)", async () => {
    const { pi, notes, ask, requests } = await piWithMemory();
    try {
      notes.text = "- [a1] (just me) My salary is private.";
      await ask("hello");
      notes.text = "No notes yet.";
      await ask("and now?");
      expect(JSON.stringify(requests[1])).toContain("salary");
    } finally {
      await pi.close(BACKGROUND_CONTEXT);
    }
  });
});
