import { isReadOnly, type CallToolResult, type McpError, type ToolInfo } from "../../shared/protocol.ts";
import type { GateContext, GateVerdict, WriteGate } from "../agents/limits/gate.ts";
import { callIdentity, derivePayload, firstText } from "../../shared/canonical.ts";
import { errorMessage } from "../../shared/util.ts";
import { ResultCache, type CachedResult, type EvictReason, type OwnerStats } from "./result-cache.ts";
import { sharesResults, type McpServerConfig } from "./servers.ts";

/** A tool result as an MCP server returns it. */
export interface RawToolResult {
  content: CallToolResult["content"];
  structuredContent?: unknown;
  isError?: boolean;
}

/** One open MCP session. The real one wraps the MCP SDK client (see connect.ts); tests pass fakes. */
export interface McpConnection {
  /** The server's own description of itself, from the MCP handshake. */
  instructions?: string;
  listTools(): Promise<ToolInfo[]>;
  callTool(name: string, args: unknown): Promise<RawToolResult>;
  close(): Promise<void>;
}

export type Connector = (server: McpServerConfig) => Promise<McpConnection>;

/** Thrown by the hub with a code the page runtime understands. */
export class McpFailure extends Error {
  constructor(readonly error: McpError) {
    super(error.message);
  }
}

/** A call the write gate refused or held for its owner: `verdict` says which, and `message` what the caller is told. */
export class CallHeld extends McpFailure {
  constructor(
    server: string,
    readonly verdict: Extract<GateVerdict, { run: false }>,
  ) {
    super({ code: "not_granted", server, message: verdict.message });
  }
}

/** A tool that changes data, called where nothing may change any (a read, or a hub with no write gate). */
function changesData(server: string, tool: string): McpFailure {
  return new McpFailure({ code: "not_granted", server, message: `${server}.${tool} changes data, and nothing may change data here.` });
}

export interface ReadResult {
  result: CallToolResult;
  /** When the result was produced upstream (epoch ms). */
  storedAt: number;
  /** When a fresh result is next worth asking for: the server hint pages poll by. */
  nextRefreshAt: number;
}

/**
 * Told how the hub's read cache does, per owner (who reads: an agent's id, "pi", or "pages"): `hit` for a read served
 * from the cache, `miss` for one that went upstream (or joined a call already on its way), `evict` for a result that
 * left the cache to make room.
 */
export interface CacheObserver {
  hit(owner: string): void;
  miss(owner: string): void;
  evict(owner: string, bytes: number, reason: EvictReason): void;
}

export interface McpHubOptions {
  /** Told of the read cache's hits, misses and evictions. */
  observer?: CacheObserver;
}

/** What one chat object may hold in cached results. Durable Objects have 128 MB; results vary from bytes to megabytes. */
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const CACHE_LIFETIME_MS = 10 * 60_000;
/** How long a server's tool list holds before it is listed again: the servers behind a portal come and go. */
const TOOLS_LIFETIME_MS = 5 * 60_000;

/**
 * The chat's MCP connections. Pi's tools and artifact pages call through the
 * same hub, so a page reaches exactly the servers the agent used to build it.
 *
 * Reads go through `read()`, which caches successful results and lets
 * concurrent identical calls share one upstream request. Writes go through
 * `call()` and are never cached. With a write gate installed (`guard`), every
 * call of a tool that is not read-only asks it first, with who is calling
 * (worker/agents/limits/gate.ts); a hub with none (a Source's) only reads.
 */
export class McpHub {
  readonly #connector: Connector;
  readonly #now: () => number;
  readonly #servers = new Map<string, McpServerConfig>();
  readonly #connections = new Map<string, Promise<McpConnection>>();
  readonly #tools = new Map<string, { list: Promise<ToolInfo[]>; listedAt: number }>();
  readonly #cache: ResultCache;
  readonly #inflight = new Map<string, Promise<CachedResult>>();
  #gate: WriteGate | undefined;
  #observer: CacheObserver | undefined;

  constructor(servers: McpServerConfig[], connector: Connector, now: () => number = Date.now, { observer }: McpHubOptions = {}) {
    for (const server of servers) this.#servers.set(server.name, server);
    this.#connector = connector;
    this.#now = now;
    this.#observer = observer;
    this.#cache = new ResultCache(MAX_CACHE_BYTES, CACHE_LIFETIME_MS, now, {
      onEvict: (owner, bytes, reason) => this.#observer?.evict(owner, bytes, reason),
    });
  }

  /** Tell `observer` about the read cache from now on (undefined stops): for when it is known only after the hub is made. */
  observe(observer: CacheObserver | undefined): void {
    this.#observer = observer;
  }

  /** What each owner holds in the read cache now. */
  cacheStats(): Map<string, OwnerStats> {
    return this.#cache.stats();
  }

  /** The bytes `owner` holds in the read cache now. */
  cacheBytes(owner: string): number {
    return this.#cache.bytesOf(owner);
  }

  servers(): McpServerConfig[] {
    return [...this.#servers.values()];
  }

  server(name: string): McpServerConfig | undefined {
    return this.#servers.get(name);
  }

  /** The server's tools, from a list younger than `maxAgeMs` (0 lists afresh: for when the user asks what is there now). */
  async tools(server: string, { maxAgeMs = TOOLS_LIFETIME_MS } = {}): Promise<ToolInfo[]> {
    const now = this.#now();
    const cached = this.#tools.get(server);
    if (cached && now - cached.listedAt < maxAgeMs) return cached.list;
    const fresh = {
      listedAt: now,
      list: this.#withConnection(server, (connection) => connection.listTools()).catch((error) => {
        // A server that listed before and does not answer now keeps its last list (and is listed again on the next call),
        // so a passing failure neither drops its tools from the agent nor fails the pages calling it. A sign-in failure does.
        if (!cached || !(error instanceof McpFailure && error.error.retryable)) throw error;
        fresh.listedAt = cached.listedAt;
        return cached.list;
      }),
    };
    this.#tools.set(server, fresh);
    fresh.list.catch(() => {
      if (this.#tools.get(server) === fresh) this.#tools.delete(server);
    });
    return fresh.list;
  }

  /** What the server says about itself when it connects (MCP `instructions`), if anything. */
  async instructions(server: string): Promise<string | undefined> {
    return this.#withConnection(server, async (connection) => connection.instructions);
  }

  async tool(server: string, name: string): Promise<ToolInfo | undefined> {
    return (await this.tools(server)).find((tool) => tool.name === name);
  }

  /** Install the write gate every call of a tool that changes data goes through. Once: a gate is never swapped. */
  guard(gate: WriteGate): void {
    if (this.#gate) throw new Error("This hub has a write gate already.");
    this.#gate = gate;
  }

  /**
   * Execute a tool once, uncached. A read-only tool runs at once. Any other (or one the server does not list) goes
   * through the write gate first, with `context` saying who calls; a refused or held call rejects with CallHeld, before
   * anything reaches the server. A hub with no gate (a Source's) changes nothing. Rejects with McpFailure.
   */
  async call(server: string, tool: string, input: unknown, context?: GateContext): Promise<CallToolResult> {
    const info = await this.tool(server, tool);
    if (info && isReadOnly(info)) return this.#execute(server, tool, input);
    const gate = this.#gate;
    if (!gate || !context) throw changesData(server, tool);
    const call = { server, tool, input: (input ?? {}) as Parameters<WriteGate["check"]>[0]["input"], ...(info && { info }) };
    const verdict = await gate.check(call, context);
    if (!verdict.run) throw new CallHeld(server, verdict);
    try {
      const result = await this.#execute(server, tool, input);
      gate.ran(call, verdict);
      return result;
    } catch (error) {
      gate.ran(call, verdict, errorMessage(error));
      throw error;
    }
  }

  async #execute(server: string, tool: string, input: unknown): Promise<CallToolResult> {
    const raw = await this.#withConnection(server, (connection) => connection.callTool(tool, input ?? {}));
    if (raw.isError) {
      throw new McpFailure({ code: "tool_error", server, message: firstText(raw.content) ?? "The tool reported an error.", result: raw });
    }
    const result: CallToolResult = { content: raw.content };
    if (raw.structuredContent !== undefined) result.structuredContent = raw.structuredContent;
    result.payload = derivePayload(raw as Parameters<typeof derivePayload>[0]);
    return result;
  }

  /**
   * A read-only call through the cache. Serves an entry younger than
   * `staleMs`, otherwise executes; identical calls in flight share one
   * execution. `viewer` keys the cache when the server keeps viewers apart (see sharesResults). `owner` says who reads
   * (an agent's id, "pi", or "pages"): what it stores counts against its share of the cache (see ResultCache).
   */
  async read(server: string, tool: string, input: unknown, options: { staleMs: number; viewer: string; owner?: string }): Promise<ReadResult> {
    const scope = sharesResults(this.#config(server)) ? "*" : options.viewer;
    const key = `${scope}\u0000${callIdentity(server, tool, input)}`;
    const owner = options.owner ?? "";
    const hit = this.#cache.fresh(key, options.staleMs);
    if (hit) {
      this.#observer?.hit(owner);
      return hit;
    }
    this.#observer?.miss(owner);

    let flight = this.#inflight.get(key);
    if (!flight) {
      // Only a tool the server lists as read-only: a read names no one who calls, so nothing that changes data.
      flight = this.tool(server, tool)
        .then((info) => {
          if (!info || !isReadOnly(info)) throw changesData(server, tool);
          return this.#execute(server, tool, input);
        })
        .then((result) => {
          const entry = { result, storedAt: this.#now() };
          this.#cache.set(key, entry, owner);
          return entry;
        });
      this.#inflight.set(key, flight);
      const settle = () => this.#inflight.delete(key);
      flight.then(settle, settle);
    }
    const entry = await flight;
    return { result: entry.result, storedAt: entry.storedAt, nextRefreshAt: entry.storedAt + options.staleMs };
  }

  async close(): Promise<void> {
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    await Promise.allSettled(connections.map(async (connection) => (await connection).close()));
  }

  #config(server: string): McpServerConfig {
    const config = this.server(server);
    if (!config) throw new McpFailure({ code: "server_not_connected", server, message: `No MCP server named "${server}" is connected to this chat.` });
    return config;
  }

  /**
   * Run `fn` on the server's connection. Any failure drops the connection, so
   * the next call connects afresh (its MCP session may have expired, or the
   * user has signed in since). A failure that is not already an McpFailure is
   * tried once more on a fresh connection.
   */
  async #withConnection<T>(server: string, fn: (connection: McpConnection) => Promise<T>): Promise<T> {
    const config = this.#config(server);
    for (let attempt = 0; ; attempt++) {
      const connection = this.#connect(config);
      try {
        return await fn(await connection);
      } catch (error) {
        if (this.#connections.get(server) === connection) this.#connections.delete(server);
        connection.then((c) => c.close()).catch(() => {});
        if (error instanceof McpFailure) throw error;
        if (attempt === 0) continue;
        throw new McpFailure({ code: "server_unavailable", server, retryable: true, message: `${server} did not answer: ${errorMessage(error)}` });
      }
    }
  }

  #connect(config: McpServerConfig): Promise<McpConnection> {
    let connection = this.#connections.get(config.name);
    if (!connection) {
      connection = this.#connector(config);
      this.#connections.set(config.name, connection);
    }
    return connection;
  }
}
