import { describe, expect, it, vi } from "vitest";
import { McpHub, type McpConnection } from "../worker/mcp/hub.ts";
import { Metrics } from "../worker/metrics.ts";

interface Point {
  indexes?: (string | null)[];
  blobs?: (string | null)[];
  doubles?: number[];
}

// An Analytics Engine dataset that keeps what is written.
function dataset() {
  const points: Point[] = [];
  return { points, writeDataPoint: (point?: Point) => void points.push(point!) };
}

const base = { uid: "u1", chatId: "c1" };

describe("Metrics", () => {
  it("does nothing without a dataset", () => {
    const metrics = new Metrics(undefined, base);
    metrics.hit("pi");
    metrics.turn({ agent: "pi", status: "done", wallMs: 1, tokens: 1, costUsd: 0, toolCalls: 0, byOwner: true, cacheBytes: 0 });
    metrics.router({ picked: [], candidates: 0, ms: 0 });
    expect(() => metrics.flush()).not.toThrow();
  });

  it("writes cache events as one point per owner on flush, not one per event", () => {
    const data = dataset();
    const metrics = new Metrics(data, base);
    metrics.hit("pages");
    metrics.hit("pages");
    metrics.miss("pages");
    metrics.miss("agent-1");
    metrics.evict("agent-1", 300, "over-share");
    metrics.evict("agent-1", 200, "expired");
    metrics.evict("pages", 50, "oldest");
    expect(data.points).toEqual([]);
    metrics.flush();
    expect(data.points).toEqual([
      { indexes: ["cache"], blobs: ["cache", "u1", "c1", "pages", "", ""], doubles: [2, 1, 0, 0, 1, 50] },
      { indexes: ["cache"], blobs: ["cache", "u1", "c1", "agent-1", "", ""], doubles: [0, 1, 1, 1, 0, 500] },
    ]);
    metrics.flush();
    expect(data.points).toHaveLength(2);
  });

  it("flushes by itself once 200 cache events are held", () => {
    const data = dataset();
    const metrics = new Metrics(data, base);
    for (let i = 0; i < 199; i++) metrics.hit("pi");
    expect(data.points).toEqual([]);
    metrics.miss("pi");
    expect(data.points).toEqual([{ indexes: ["cache"], blobs: ["cache", "u1", "c1", "pi", "", ""], doubles: [199, 1, 0, 0, 0, 0] }]);
  });

  it("writes a turn, then the cache counts, and a run likewise", () => {
    const data = dataset();
    const metrics = new Metrics(data, base);
    metrics.hit("agent-1");
    const turn = { wallMs: 1_200, tokens: 900, costUsd: 0.01, toolCalls: 3, byOwner: false, unprompted: true, cacheBytes: 4_096 };
    metrics.turn({ agent: "agent-1", status: "done", ...turn });
    expect(data.points).toEqual([
      { indexes: ["turn"], blobs: ["turn", "u1", "c1", "agent-1", "done", ""], doubles: [1_200, 900, 0.01, 3, 0, 1, 4_096] },
      { indexes: ["cache"], blobs: ["cache", "u1", "c1", "agent-1", "", ""], doubles: [1, 0, 0, 0, 0, 0] },
    ]);
    metrics.miss("agent-1");
    metrics.run({ agent: "agent-1", outcome: "posted", wallMs: 5_000, costUsd: 0.02, items: 4 });
    expect(data.points.slice(2)).toEqual([
      { indexes: ["run"], blobs: ["run", "u1", "c1", "agent-1", "posted", ""], doubles: [5_000, 0.02, 4] },
      { indexes: ["cache"], blobs: ["cache", "u1", "c1", "agent-1", "", ""], doubles: [0, 1, 0, 0, 0, 0] },
    ]);
  });

  it("lays out router, funnel and budget points", () => {
    const data = dataset();
    const metrics = new Metrics(data, base);
    metrics.router({ picked: ["a", "b"], candidates: 5, ms: 120 });
    metrics.router({ picked: [], candidates: 5, ms: 3_000, failed: "timeout" });
    metrics.funnel({ agent: "a", stage: "interest", passed: false, score: 0.4 });
    metrics.funnel({ agent: "a", stage: "gates", passed: true });
    metrics.budget({ scope: "chat", usedTokens: 10_000 });
    metrics.budget({ scope: "user", usedUsd: 1.5 });
    expect(data.points).toEqual([
      { indexes: ["router"], blobs: ["router", "u1", "c1", "", "a,b", ""], doubles: [5, 2, 120, 0] },
      { indexes: ["router"], blobs: ["router", "u1", "c1", "", "", "timeout"], doubles: [5, 0, 3_000, 1] },
      { indexes: ["funnel"], blobs: ["funnel", "u1", "c1", "a", "interest", ""], doubles: [0, 1, 0.4] },
      { indexes: ["funnel"], blobs: ["funnel", "u1", "c1", "a", "gates", ""], doubles: [1, 0, 0] },
      { indexes: ["budget"], blobs: ["budget", "u1", "c1", "chat", "capped", ""], doubles: [10_000, 0] },
      { indexes: ["budget"], blobs: ["budget", "u1", "c1", "user", "capped", ""], doubles: [0, 1.5] },
    ]);
  });

  it("never breaks its caller when a write fails, and says so once", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const metrics = new Metrics(
      {
        writeDataPoint: () => {
          throw new Error("over the limit");
        },
      },
      base,
    );
    expect(() => metrics.router({ picked: ["a"], candidates: 1, ms: 1 })).not.toThrow();
    expect(() => metrics.run({ agent: "a", outcome: "done", wallMs: 1, costUsd: 0, items: 0 })).not.toThrow();
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("counts the hub's reads when it observes them", async () => {
    const data = dataset();
    const metrics = new Metrics(data, base);
    const connection: McpConnection = {
      // A read goes only to a tool the server lists as read-only.
      listTools: async () => [{ name: "t", description: "", annotations: { readOnlyHint: true } }],
      callTool: async () => ({ content: [{ type: "text", text: "{}" }] }),
      close: async () => {},
    };
    const hub = new McpHub([{ name: "Open", url: "https://example.invalid/mcp" }], async () => connection, Date.now, { observer: metrics });
    await hub.read("Open", "t", {}, { staleMs: 30_000, viewer: "ann", owner: "pages" });
    await hub.read("Open", "t", {}, { staleMs: 30_000, viewer: "ann", owner: "pages" });
    metrics.flush();
    expect(data.points).toEqual([{ indexes: ["cache"], blobs: ["cache", "u1", "c1", "pages", "", ""], doubles: [1, 1, 0, 0, 0, 0] }]);
  });
});
