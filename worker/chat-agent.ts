import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type AgentEventStream } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle, LifecycleCapability, type DurableObjectCapability } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { DurableObject, exports } from "cloudflare:workers";
import { isOwnedBy, manifestOf, type ArtifactManifest, type ChatClientMessage, type DeclaredTool, type ChatServerMessage, type McpError, type ProxyRequest, type ProxyResponse } from "../shared/protocol.ts";
import { errorMessage } from "../shared/util.ts";
import { promptExtension } from "./agent/prompt.ts";
import { artifactExtension, filesExtension, mcpExtension, publishArtifact, sandboxExtension, type ChatScope, type PublishInput, type ServerCatalog } from "./agent/tools.ts";
import { Storage, type UserFiles } from "./storage/index.ts";
import { connectStreamableHttp, signInRequired } from "./mcp/connect.ts";
import { McpOAuthClient } from "./mcp/oauth.ts";
import { McpFailure, McpHub } from "./mcp/hub.ts";
import { mcpServers, type McpServerConfig } from "./mcp/servers.ts";
import { mcpAuthStore } from "./users.ts";

const SOCKET_TAG = "chat";
const OWNER = { owner: "chat-sockets" } as const;
const MAX_STALE_MS = 24 * 60 * 60_000;

/** The name of a user's chat object. The uid must come from a verified identity: it is what keeps users apart. */
export function chatAgentName(uid: string, chatId: string): string {
  return `${uid}:${chatId}`;
}

interface ArtifactCall {
  artifactId: string;
  viewer: string;
  request: ProxyRequest;
}

/**
 * One chat: its Pi agent, its MCP connections, and the live calls of the
 * artifacts it published. Named `<uid>:<chatId>`.
 *
 * An artifact's page calls MCP tools through `artifactCall`, which uses the
 * same McpHub as the agent's tools. No model is involved in those calls.
 */
export class ChatAgent extends DurableObject<Env> {
  readonly hub = new McpHub(mcpServers(this.env), (server) => this.#connect(server));
  readonly storage = new Storage(this.env);
  readonly ai = createAI({ binding: this.env.AI, gateway: this.env.AI_GATEWAY_ID, byokAlias: this.env.AI_BYOK_ALIAS || undefined });
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      const models = createModels();
      models.setProvider(this.ai.provider);
      return Harness.open(storage, { models, registry: this.registry, onWake }, context);
    },
    // Current Claude models reject pi's "off" (thinking: disabled), so new chats think at medium effort.
    defaults: { model: this.ai(this.env.MODEL), thinkingLevel: "medium" },
  });
  readonly sockets = new ChatSockets({
    events: () => this.harness.session().events(),
    prompt: (text) => this.prompt(text),
    abort: () => this.abort(),
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness).use(this.sockets);

  readonly scope: ChatScope;
  readonly #manifests = new Map<string, ArtifactManifest>();
  #mcpRefresh: Promise<void> | undefined;
  /** The servers whose tools the agent has now, so a refresh reinstalls only on a change. */
  #mcpInstalled = "";
  #files: Promise<UserFiles> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const scope: ChatScope = (this.scope = {
      uid: this.uid,
      chatId: this.chatId,
      hub: this.hub,
      artifacts: this.storage.artifacts,
      // The uid is this object's name, which the Worker sets from a verified identity.
      // Deriving the user's key is not free, so derive it once per object.
      files: () =>
        (this.#files ??= this.storage.userFiles(this.uid).catch((error) => {
          this.#files = undefined;
          throw error;
        })),
      onPublished: (artifact) => exports.UserDirectory.getByName(this.uid).recordArtifact({ ...artifact, chatId: this.chatId }),
    });
    this.registry.install(promptExtension);
    this.registry.install(artifactExtension(scope));
    this.registry.install(filesExtension(scope));
    if (env.SANDBOX_ENABLED === "true") this.registry.install(sandboxExtension(scope));
  }

  get uid(): string {
    return this.ctx.id.name!.split(":")[0];
  }

  get chatId(): string {
    return this.ctx.id.name!.split(":")[1];
  }

  /** Called by Lifecycle once capabilities have started, including after an eviction. */
  onStart(): void {
    void this.refreshMcpTools();
  }

  /**
   * List each MCP server's tools and install them as agent tools. Runs before
   * every prompt: tool lists are cached, and a server the user has signed in
   * to since (or whose sign-in expired) joins or leaves then.
   */
  refreshMcpTools(): Promise<void> {
    this.#mcpRefresh ??= (async () => {
      const catalog = new Map<string, ServerCatalog>();
      const unavailable = new Map<string, string>();
      // Servers are independent: list them all at once, so a slow one delays the prompt by its own time only.
      await Promise.all(
        this.hub.servers().map(async (server) => {
          try {
            const [tools, instructions] = await Promise.all([this.hub.tools(server.name), this.hub.instructions(server.name)]);
            catalog.set(server.name, { tools, instructions });
          } catch (error) {
            unavailable.set(server.name, error instanceof McpFailure ? error.error.message : errorMessage(error));
          }
        }),
      );
      const installed = JSON.stringify([[...catalog.keys()], [...unavailable.keys()]]);
      if (installed !== this.#mcpInstalled) {
        this.registry.install(mcpExtension(this.hub, catalog, unavailable));
        this.#mcpInstalled = installed;
      }
    })().finally(() => {
      this.#mcpRefresh = undefined;
    });
    return this.#mcpRefresh;
  }

  /** Public servers connect as they are; a server with `auth: "oauth"` connects with this chat's user's own tokens. */
  async #connect(server: McpServerConfig) {
    if (server.auth !== "oauth") return connectStreamableHttp(server);
    const store = mcpAuthStore(this.uid, server.name);
    const { tokens, redirectUrl } = await store.get();
    if (!tokens || !redirectUrl) throw signInRequired(server.name);
    return connectStreamableHttp(server, new McpOAuthClient(store, server.name, { redirectUrl, interactive: false }));
  }

  async prompt(text: string): Promise<void> {
    await this.refreshMcpTools().catch(() => {});
    await this.harness.submit(text);
    // touchChat only names a chat that is still called "New chat", so the first prompt names it.
    await exports.UserDirectory.getByName(this.uid).touchChat(this.chatId, text);
  }

  /** Publish without the model, through the same checks as the agent's tool. Only routed when DEV_TOOLS is on. */
  async devPublish(input: PublishInput) {
    const meta = await publishArtifact(this.scope, input);
    return { artifactId: meta.id, version: meta.latest };
  }

  async abort(): Promise<void> {
    await this.harness.abort();
  }

  /** The tools an artifact version declared, with their schemas: what the page's describeTool reads. */
  async artifactTools(artifactId: string, version: number): Promise<DeclaredTool[] | McpError> {
    const manifest = await this.#manifest(artifactId, version);
    if (!manifest) return { code: "not_in_manifest", message: "No such artifact version in this chat." };
    const tools: DeclaredTool[] = [];
    for (const entry of manifest.mcp?.servers ?? []) {
      for (const tool of await this.hub.tools(entry.server).catch(() => [])) {
        if (entry.tools.includes(tool.name)) tools.push({ ...tool, server: entry.server });
      }
    }
    return tools;
  }

  /** One MCP call from a published page. The Worker has already resolved the viewer. */
  async artifactCall({ artifactId, viewer, request }: ArtifactCall): Promise<ProxyResponse> {
    const fail = (error: McpError): ProxyResponse => ({ ok: false, error });
    const { server, tool, input, mode } = request;

    const manifest = await this.#manifest(artifactId, request.version);
    if (!manifest) return fail({ code: "not_in_manifest", server, message: "No such artifact version in this chat." });
    const declared = manifest.mcp?.servers.find((entry) => entry.server === server);
    if (!declared?.tools.includes(tool)) {
      return fail({ code: "not_in_manifest", server, message: `This page did not declare ${server}/${tool} when it was published.` });
    }

    // A page calls as its author. For a server that signs in each user, that would show the author's data to anyone with the link.
    if (this.hub.server(server)?.auth === "oauth" && viewer !== this.uid) {
      return fail({ code: "not_granted", server, message: `${server} signs in each user, and this page calls as its author, so only the author can load it.` });
    }

    try {
      const info = await this.hub.tool(server, tool);
      if (!info) return fail({ code: "not_in_manifest", server, message: `${server} no longer has a tool named ${tool}.` });
      const readOnly = info.annotations?.readOnlyHint === true;

      if (mode === "read") {
        if (!readOnly) return fail({ code: "bad_request", server, message: `${tool} is not read-only, so it cannot be watched or cached; use callTool.` });
        const staleMs = Math.min(Math.max(Number(request.staleMs) || 0, 0), MAX_STALE_MS);
        const read = await this.hub.read(server, tool, input, { staleMs, viewer });
        return { ok: true, result: read.result, storedAt: read.storedAt, nextRefreshAt: staleMs > 0 ? read.nextRefreshAt : undefined };
      }

      if (!readOnly && viewer !== this.uid) {
        return fail({ code: "not_granted", server, message: `${tool} can change data, so only the page's author can call it.` });
      }
      const result = await this.hub.call(server, tool, input);
      return { ok: true, result, storedAt: Date.now() };
    } catch (error) {
      if (error instanceof McpFailure) return fail(error.error);
      return fail({ code: "upstream_error", server, message: errorMessage(error) });
    }
  }

  /** Versions never change once published, so their manifests cache for the object's lifetime. */
  async #manifest(artifactId: string, version: number): Promise<ArtifactManifest | undefined> {
    const key = `${artifactId}:${version}`;
    let manifest = this.#manifests.get(key);
    if (!manifest) {
      const meta = await this.storage.artifacts.readMeta(artifactId);
      if (!meta || !isOwnedBy(meta, this.uid, this.chatId)) return undefined;
      manifest = manifestOf(meta, version);
      if (!manifest) return undefined;
      this.#manifests.set(key, manifest);
    }
    return manifest;
  }
}

/** What the chat's sockets need from the chat: its event stream, and a way to prompt and stop it. */
interface ChatSession {
  events(): Promise<AgentEventStream>;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
}

/**
 * The chat's browser connections. Each socket gets its own pi event stream:
 * a snapshot of the conversation first, then one batch per commit. Sockets
 * hibernate; after the object restarts, streams are reattached in onStart.
 */
class ChatSockets extends LifecycleCapability implements DurableObjectCapability {
  readonly #chat: ChatSession;
  readonly #streams = new Map<WebSocket, Promise<AgentEventStream>>();

  constructor(chat: ChatSession) {
    super("chat-sockets");
    this.#chat = chat;
  }

  onStart(): void {
    for (const ws of this.lifecycle.sockets.get(SOCKET_TAG)) {
      // A socket accepted before chat sockets carried an attachment has only the tag: claim it, or its messages go unhandled.
      if (!this.#owns(ws)) ws.serializeAttachment(OWNER);
      void this.#attach(ws);
    }
  }

  onWebSocketUpgrade({ request }: { request: Request }): Response | undefined {
    if (!new URL(request.url).pathname.endsWith("/ws")) return undefined;
    const pair = new WebSocketPair();
    this.lifecycle.sockets.accept(pair[1], [SOCKET_TAG]);
    pair[1].serializeAttachment(OWNER);
    void this.#attach(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Lifecycle leaves ownership to each capability: a chat socket carries this capability's attachment, which survives hibernation. */
  #owns(ws: WebSocket): boolean {
    return (ws.deserializeAttachment() as typeof OWNER | null)?.owner === OWNER.owner;
  }

  async onWebSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<boolean> {
    if (!this.#owns(ws)) return false;
    void this.#attach(ws);
    let message: ChatClientMessage;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return true;
    }
    try {
      if (message.type === "prompt" && message.text.trim()) await this.#chat.prompt(message.text.slice(0, 20_000));
      else if (message.type === "abort") await this.#chat.abort();
    } catch (error) {
      send(ws, { type: "error", message: errorMessage(error) });
    }
    return true;
  }

  async onWebSocketClose(ws: WebSocket): Promise<boolean> {
    if (!this.#owns(ws)) return false;
    await this.#detach(ws);
    return true;
  }

  async onWebSocketError(ws: WebSocket): Promise<boolean> {
    return this.onWebSocketClose(ws);
  }

  #attach(ws: WebSocket): Promise<AgentEventStream> {
    let stream = this.#streams.get(ws);
    if (stream) return stream;
    stream = (async () => {
      const events = await this.#chat.events();
      send(ws, { type: "events", events: [events.snapshot] });
      events.start(async (batch) => {
        if (!send(ws, { type: "events", events: [...batch] })) await this.#detach(ws);
      });
      return events;
    })();
    this.#streams.set(ws, stream);
    stream.catch((error) => {
      this.#streams.delete(ws);
      send(ws, { type: "error", message: `Could not open the conversation: ${errorMessage(error)}` });
    });
    return stream;
  }

  async #detach(ws: WebSocket): Promise<void> {
    const stream = this.#streams.get(ws);
    this.#streams.delete(ws);
    if (stream) await (await stream.catch(() => undefined))?.stop();
  }
}

function send(ws: WebSocket, message: ChatServerMessage): boolean {
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}
