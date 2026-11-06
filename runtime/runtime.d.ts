/**
 * The artifact page runtime: what a published page can call. The agent reads
 * this file in its system prompt, so it is written for that reader too.
 *
 * A page has no network of its own. Its MCP calls go to the MCP connections
 * of the chat that published it, through the viewer page and the Worker. They
 * run as the chat's author, and only the (server, tool) pairs the page
 * declared at publish can be called.
 *
 *     const mcp = await pi.use("mcp");
 *     if (!mcp) return renderStatic();          // not framed by a viewer: no live data
 *     const stop = mcp.watchTool("CoinGecko", "execute", { code }, (ev) => {
 *       if (ev.type === "data") render(ev.result.payload, ev.result.cache?.storedAt);
 *       else showSectionError(ev.error);
 *     }, { refetchInterval: 30_000 });
 *
 *     const coins = await mcp.CoinGecko.search_docs({ query: "markets" }); // one-off, resolves to the payload
 *
 * A page can also keep what each viewer changes (pi.use("storage"): a layout they dragged, filters, hidden cards) and
 * ask a small model about something the viewer typed (pi.use("ai")):
 *
 *     const store = await pi.use("storage");     // values load once; read and write synchronously after
 *     const layout = JSON.parse(store?.getItem("layout") ?? "null") ?? DEFAULT_LAYOUT;
 *     mount(layout, (next) => store?.setItem("layout", JSON.stringify(next)));
 *
 *     const ai = await pi.use("ai");
 *     const { json } = await ai.complete({
 *       system: "You rearrange a dashboard. Cards: " + JSON.stringify(cards) + ". Reply with {order: string[], hidden: string[]}.",
 *       messages: [{ role: "user", content: typedText }],
 *       json: true,
 *     });
 */

interface Window {
  pi: Pi;
}
declare const pi: Pi;

interface Pi {
  /**
   * The capability's namespace, or `null` when this view cannot run it (the
   * page was opened outside a viewer, or the viewer never connected within
   * 10 s). Resolves after your script's first run: render first, then light
   * up live sections. Memoized. Any other name resolves `null`.
   */
  use(name: "mcp"): Promise<PiMcp | null>;
  use(name: "storage"): Promise<PiStorage | null>;
  use(name: "ai"): Promise<PiAi | null>;
}

/**
 * What the page saves for the person viewing it, kept on the server, so it follows them to any browser: layouts,
 * filters, collapsed sections, settings. Each viewer has their own values for the page. The page's author's values are
 * everyone's starting point: what the author arranges is the default layout, and a viewer's own changes go over it.
 * Everyone who opens the page reads the author's values, so never save data from MCP calls or anything private.
 *
 * Values load once, when `use("storage")` resolves; from then on reads and writes are synchronous, like localStorage,
 * and writes are saved in the background half a second after the last one. Await it before the first read that
 * decides the layout. Strings only: JSON.stringify objects. Limits: keys up to 256 characters and a value up to
 * 100 000 (more throws a QuotaExceededError), and 500 keys and 500 000 characters of the viewer's own per page (a write
 * over those is refused: flush() rejects with `too_large`, and the page keeps the value only until it is reloaded).
 *
 * `window.localStorage` is this same store (the frame's opaque origin has no localStorage of its own), so a library
 * that saves its state there with getItem and setItem keeps it (not with property access: `localStorage.theme`). It
 * reads empty until `use("storage")` resolved, and what is set before then counts only for keys with nothing saved.
 * sessionStorage lives as long as the page.
 */
interface PiStorage extends Storage {
  /** The keys saved. */
  keys(): string[];
  /** The viewer is the page's author: what they save is everyone's default. Say so near a "Reset layout" control. */
  readonly isAuthor: boolean;
  /** Save the pending writes now. Rejects with a PiPageError when they were not saved. */
  flush(): Promise<void>;
  /**
   * Drop the viewer's own values and go back to the author's (for the author: drop the defaults for everyone). Once it
   * resolves, re-render from getItem. Use it for "Reset layout".
   */
  reset(): Promise<void>;
}

/**
 * A small, fast model for what the viewer types into the page: "move revenue to the top", "only show EU", "explain
 * this spike". One answer per call, no tools, no web, nothing remembered between calls: send what it needs to know
 * (the page's current layout, the visible numbers) in `system` or the messages, and keep earlier turns yourself.
 * The viewer who types pays for it, within a daily allowance. Call it only for something a viewer asked, never on
 * load or on a timer. Show a busy state while it runs (a few seconds), and its errors.
 */
interface PiAi {
  /**
   * A prompt string is one user message. With `json: true` the model is told to answer with JSON only and `json` is
   * the parsed value (a reply that is not JSON rejects with `bad_output`): validate it before applying it.
   * `maxTokens` defaults to 1 000, at most 2 000.
   */
  complete(
    request: string | { system?: string; messages: { role: "user" | "assistant"; content: string }[]; maxTokens?: number; json?: boolean },
    options?: { signal?: AbortSignal },
  ): Promise<{ text: string; json?: unknown }>;
}

type PiPageErrorCode =
  | "bad_request" //   a malformed call: a page bug
  | "too_large" //     over the storage limits
  | "rate_limited" //  too many calls; wait `retryAfterMs`
  | "limit_reached" // the viewer used today's model allowance; it renews at midnight UTC
  | "unavailable" //   no model answered, or this view has none (the check, a page outside a viewer)
  | "bad_output" //    asked for JSON, the model answered something else
  | "upstream_error" // the request to the Worker failed; try again later
  | "cancelled"; //    the call's AbortSignal fired

/** Storage and model rejections are Errors carrying `code` (and `retryAfterMs` on rate_limited). Branch on `code`. */
interface PiPageError extends Error {
  code: PiPageErrorCode;
  retryAfterMs?: number;
}

type PiMcpErrorCode =
  | "server_not_connected" // the chat has no server by that name
  | "server_unavailable" //   upstream down or slow; retryable
  | "auth_required" //        the page's author must sign in to this server in the app (it needs their own login)
  | "not_in_manifest" //      (server, tool) not declared at publish: a page bug
  | "not_granted" //          a write tool and the viewer is not the page's author, or a server with private data and the viewer is not in the author's chat
  | "tool_error" //           the tool ran and reported failure; `message` says why
  | "bad_request" //          bad arguments, or watchTool on a tool that is not read-only
  | "rate_limited" //         too many calls; wait `retryAfterMs`
  | "cancelled" //            the call's AbortSignal fired
  | "upstream_error"; //      anything else

/** Rejections and watch errors are Errors carrying these fields. Branch on `code`, never on `message`. */
interface PiMcpError extends Error {
  code: PiMcpErrorCode;
  server?: string;
  /** Present only as `true`: one retry after a short delay may succeed. Never loop. */
  retryable?: true;
  retryAfterMs?: number;
  /** The tool's own result envelope, on `tool_error`. */
  result?: unknown;
}

interface PiCallToolResult {
  content: ({ type: "text"; text: string } | { type: string; [k: string]: unknown })[];
  structuredContent?: unknown;
  /**
   * The JSON answer: `structuredContent`, else the first text block parsed as
   * JSON, else that text. Read this rather than `content`.
   */
  payload?: unknown;
  /**
   * Present when served from a cache. `storedAt` (epoch ms) is when the data
   * was produced: drive "updated N s ago" labels from it, not from Date.now().
   * `revalidating: true` on a watch replay whose refresh is already in flight.
   */
  cache?: { storedAt: number; revalidating: boolean };
}

type PiWatchEvent = { type: "data"; result: PiCallToolResult } | { type: "error"; error: PiMcpError };

interface PiMcp {
  /**
   * DISPLAY data that should stay current. Replays the last result at once
   * (marked with `cache`), fetches when it is missing or stale, then delivers
   * every newer result. `refetchInterval` (ms, floor 30 000) polls; polling
   * pauses while the viewer's tab is hidden and catches up when it returns.
   * Identical watches share one request, and every viewer of the page shares
   * one result per interval. Read-only tools only.
   *
   * Returns a synchronous unsubscribe. Every failure arrives on the handler
   * as an `error` event: keep last-good data on `server_unavailable`,
   * `rate_limited` and `tool_error`; clear it on `not_in_manifest` and
   * `server_not_connected`.
   */
  watchTool(
    server: string,
    tool: string,
    input: unknown,
    handler: (event: PiWatchEvent) => void,
    options?: { refetchInterval?: number; cache?: { staleTime?: number } },
  ): () => void;

  /**
   * ACTIONS, or a one-off read. Resolves with the result, rejects with a
   * PiMcpError. `cache.staleTime` lets a read reuse a result that young (ms);
   * `cache.refresh` forces a fresh one. Write tools (not read-only) run only
   * for the page's author and are never cached. While the viewer's tab is
   * hidden, calls to read-only tools wait until it is visible again (identical
   * ones then share one request), so polling with callTool on a timer costs
   * nothing in a background tab; prefer watchTool for data on display.
   */
  callTool(
    server: string,
    tool: string,
    input?: unknown,
    options?: { cache?: false | { staleTime?: number; refresh?: boolean }; signal?: AbortSignal },
  ): Promise<PiCallToolResult>;

  /** Drop cached results and refetch matching watches; call after a write. Narrow by server, tool, exact input. */
  invalidate(server?: string, tool?: string, input?: unknown): Promise<void>;

  /** The servers and tools this page declared. Never asks anything. */
  listTools(server?: string): Promise<{ servers: { server: string; kind: "connector"; authStatus: "connected"; tools: { name: string; description: string }[] }[] }>;

  /** One tool's description and input JSON Schema. */
  describeTool(server: string, tool: string): Promise<{ name: string; description: string; inputSchema: unknown; annotations?: { readOnlyHint?: boolean } }>;

  /** A handle whose methods are one server's declared tools; each resolves to the call's `payload`. */
  server(name: string): Promise<Readonly<Record<string, (input?: unknown) => Promise<unknown>>>>;

  /**
   * The same handles as properties, one per declared server:
   * `await mcp.CoinGecko.execute({ code })` resolves to the payload.
   */
  readonly [server: string]: unknown;
}
