import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, ROOT_CONVERSATION_ID, type AgentChange, type AgentEventStream } from "@earendil-works/pi-durable";
import { PiHarness, skills } from "agents/harness/pi";
import { Lifecycle, LifecycleCapability, type DurableObjectCapability } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { DurableObject, exports } from "cloudflare:workers";
import {
  CHAT_MESSAGE_KIND,
  isOwnedBy,
  isReadOnly,
  manifestOf,
  SOCKET_NOT_A_MEMBER,
  type ArtifactManifest,
  type ChatClientMessage,
  type ChatInvite,
  type ChatMessageData,
  type ChatPeople,
  type ChatPeopleView,
  type ChatServerMessage,
  type DeclaredTool,
  type McpError,
  type Person,
  type ProxyRequest,
  type ProxyResponse,
} from "../shared/protocol.ts";
import type { ModelChoice } from "../shared/models.ts";
import { errorMessage, memoAsync, singleFlight } from "../shared/util.ts";
import { filesIndex } from "./agent/file-refs.ts";
import { peopleExtension, promptExtension } from "./agent/prompt.ts";
import { skillSource } from "./agent/skills.ts";
import { mcpExtension, type ServerCatalog } from "./agent/mcp.ts";
import { artifactExtension, filesExtension, filesIndexExtension, publishArtifact, sandboxExtension, skillsExtension, type ChatScope, type PublishInput } from "./agent/tools.ts";
import { Storage } from "./storage/index.ts";
import { connectStreamableHttp, signInRequired } from "./mcp/connect.ts";
import { McpOAuthClient } from "./mcp/oauth.ts";
import { McpFailure, McpHub } from "./mcp/hub.ts";
import { mcpServers, type McpServerConfig } from "./mcp/servers.ts";
import { ChatMembers, formatInviteToken } from "./members.ts";
import { checkModelChoice, defaultModelChoice } from "./models.ts";
import { mcpAuthStore } from "./users.ts";

/** Why the chat refused a person's request, with the HTTP status the Worker answers it with. */
export interface ChatRefusal {
  error: string;
  status: 403 | 404 | 409;
}

function refuse(status: ChatRefusal["status"], error: string): ChatRefusal {
  return { error, status };
}

const SOCKET_TAG = "chat";
const OWNER = "chat-sockets";
/** Set by the Worker on a chat socket's upgrade request, from the verified identity; never taken from the browser. */
export const PERSON_HEADER = "x-pi-person";
const MAX_STALE_MS = 24 * 60 * 60_000;
const MEMBERS_TOUCH_MS = 60_000;

/** The name of a user's chat object. The uid must come from a verified identity: it is what keeps users apart. */
export function chatAgentName(uid: string, chatId: string): string {
  return `${uid}:${chatId}`;
}

/** The uid and chat id a chat object's name was built from (see chatAgentName). */
function parseChatAgentName(name: string): { uid: string; chatId: string } {
  const [uid, chatId] = name.split(":");
  return { uid, chatId };
}

interface ArtifactCall {
  artifactId: string;
  viewer: string;
  request: ProxyRequest;
}

/**
 * One chat: its Pi agent, its MCP connections, and the live calls of the
 * artifacts it published. Named `<uid>:<chatId>` after its owner.
 *
 * The owner can invite people into the chat (`members`). They share the one
 * conversation and the one agent, which acts as the owner: with the owner's
 * MCP connections, files, sandbox and skills, and publishing as the owner.
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
    harness: async ({ storage, context, onWake }) => {
      const models = createModels();
      models.setProvider(this.ai.provider);
      const pi = await Harness.open(storage, { models, registry: this.registry, onWake }, context);
      try {
        // A new chat starts on the model its user last picked; PiHarness then finds the root and leaves it as it is.
        if (!(await pi.conversation(ROOT_CONVERSATION_ID, context))) {
          const choice = await this.#savedModel();
          if (choice) await pi.root(context, { agent: this.#agentChange(choice) });
        }
      } catch (error) {
        await pi.close(context).catch(() => {});
        throw error;
      }
      return pi;
    },
    // What a new chat starts on before its user has picked a model.
    defaults: this.#defaults(defaultModelChoice(this.env.MODEL, this.env.THINKING_LEVEL)),
  });
  readonly members = new ChatMembers(this.ctx.storage.sql);
  readonly sockets = new ChatSockets({
    events: () => this.harness.session().events(),
    admit: (person) => this.admit(person),
    peopleFor: (uid) => this.peopleFor(uid),
    prompt: (text, author) => this.prompt(text, author),
    abort: (by) => this.abort(by),
    setModel: (input, by) => this.setModel(input, by),
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness).use(this.sockets);

  readonly scope: ChatScope;
  readonly #manifests = new Map<string, ArtifactManifest>();
  /**
   * The servers whose tools the agent has now (`key`), so a refresh reinstalls only on a change, what mcp_discover
   * says about them, and which listing they came from (`generation`): a listing started later has lists at least as new, so one that
   * finishes after it (a refresh racing a discovery, two discoveries) does not install over it.
   */
  #mcp = { key: "", listing: "", generation: 0 };
  #mcpListings = 0;
  /** The skills version the agent's skills come from, so a refresh fetches and reinstalls them only on a change. */
  #skillsInstalled: string | undefined;
  /** The agent's prompt's list of the user's files, so a refresh reinstalls it only on a change. */
  #filesInstalled: string | undefined;
  /** When members' sidebars were last bumped, and with which title. */
  #membersTouched = { title: "", at: 0 };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const scope: ChatScope = (this.scope = {
      uid: this.uid,
      chatId: this.chatId,
      hub: this.hub,
      artifacts: this.storage.artifacts,
      // Deriving the user's key is not free, so derive it once per object.
      files: memoAsync(() => this.storage.userFiles(this.uid)),
      onPublished: (artifact) => this.#directory.recordArtifact({ ...artifact, chatId: this.chatId }),
      proposeSkill: (skill) => this.#directory.saveSkill(skill, "agent", false),
    });
    this.registry.install(promptExtension);
    this.registry.install(peopleExtension(() => this.people()));
    this.registry.install(artifactExtension(scope));
    this.registry.install(filesExtension(scope));
    this.registry.install(skillsExtension(scope));
    if (env.SANDBOX_ENABLED === "true") this.registry.install(sandboxExtension(scope));
  }

  /** The uid is this object's name, which the Worker sets from a verified identity. */
  get uid(): string {
    return parseChatAgentName(this.ctx.id.name!).uid;
  }

  get chatId(): string {
    return parseChatAgentName(this.ctx.id.name!).chatId;
  }

  /** This chat's user's directory: their chats, artifacts, skills and MCP sign-ins. */
  get #directory() {
    return this.#index(this.uid);
  }

  /** Called by Lifecycle once capabilities have started, including after an eviction. */
  onStart(): void {
    void this.refreshMcpTools();
    void this.refreshSkills();
  }

  /** The user's last pick, checked again: the list of models can change between deploys. On a failure, the deployment's default. */
  async #savedModel(): Promise<ModelChoice | null> {
    try {
      const saved = await this.#directory.modelChoice();
      return saved && checkModelChoice(saved);
    } catch (error) {
      console.error("model:", errorMessage(error));
      return null;
    }
  }

  #defaults({ model, thinkingLevel }: ModelChoice) {
    return { model: this.ai(model), thinkingLevel };
  }

  #agentChange({ model, thinkingLevel }: ModelChoice): AgentChange {
    const routed = this.ai(model);
    return { model: { provider: routed.provider, modelId: routed.id }, thinkingLevel };
  }

  /**
   * Run this chat on another model or effort, from its next model request on, for everyone in it. It also becomes the
   * default for new chats of whoever picked it, owner or member.
   */
  async setModel(input: { model?: unknown; thinkingLevel?: unknown }, by: Person): Promise<void> {
    this.#requireInChat(by);
    const choice = checkModelChoice(input);
    if (!choice) throw new Error(`There is no model named ${String(input.model)} to pick.`);
    // PiHarness has made the root conversation by the time pi() resolves.
    const conversation = await (await this.harness.pi()).root(BACKGROUND_CONTEXT);
    await conversation.configure(this.#agentChange(choice), BACKGROUND_CONTEXT);
    // The chat has changed by now, so a failure to remember the pick for new chats is logged, not reported as a failed change.
    await this.#index(by.uid).setModelChoice(choice).catch((error: unknown) => console.error("model:", errorMessage(error)));
  }

  /**
   * Install the user's enabled skills, built-in and their own. Runs before every
   * prompt, so a skill added, changed or turned off in any chat applies from the
   * next message on. Never rejects: a failure is logged, and the agent keeps the skills it has.
   */
  readonly refreshSkills = singleFlight(async () => {
    try {
      const directory = this.#directory;
      const version = await directory.skillsVersion();
      if (version === this.#skillsInstalled) return;
      this.registry.install(await skills([skillSource(await directory.listSkills(), version)]));
      this.#skillsInstalled = version;
    } catch (error) {
      console.error("skills:", errorMessage(error));
    }
  });

  /**
   * Show the agent the user's files, newest first, so a file the user names in
   * a message maps to its path. Runs before every prompt, so files uploaded
   * since are in it. Never rejects: on a failure the agent keeps the list it has.
   */
  readonly refreshFiles = singleFlight(async () => {
    try {
      const index = filesIndex(await (await this.scope.files()).list());
      if (index === this.#filesInstalled) return;
      this.registry.install(filesIndexExtension(index));
      this.#filesInstalled = index;
    } catch (error) {
      console.error("files:", errorMessage(error));
    }
  });

  /**
   * List each MCP server's tools and install them as agent tools. Runs before
   * every prompt: tool lists are cached, and a server the user has signed in
   * to since (or whose sign-in expired) joins or leaves then. Returns the
   * servers' listing, as mcp_discover answers it.
   */
  readonly refreshMcpTools = singleFlight(() => this.#installMcpTools());

  /**
   * List every server afresh, not from cached tool lists, and install what it
   * finds: the agent's mcp_discover. The agent's next step already has the
   * new tools: pi fixes the offered tools per model request, not per turn.
   */
  discoverMcp(): Promise<string> {
    return this.#installMcpTools(0);
  }

  /** Install the servers' tools from lists younger than `maxAgeMs` (the hub's lifetime by default). */
  async #installMcpTools(maxAgeMs?: number): Promise<string> {
    const generation = ++this.#mcpListings;
    const catalog = new Map<string, ServerCatalog>();
    const unavailable = new Map<string, string>();
    // Servers are independent: list them all at once, so a slow one delays the prompt by its own time only.
    const servers = this.hub.servers();
    const listed = await Promise.all(
      servers.map(async (server): Promise<ServerCatalog | { reason: string }> => {
        try {
          const [tools, instructions] = await Promise.all([this.hub.tools(server.name, { maxAgeMs }), this.hub.instructions(server.name)]);
          return { tools, instructions };
        } catch (error) {
          return { reason: error instanceof McpFailure ? error.error.message : errorMessage(error) };
        }
      }),
    );
    // In the configured order, whichever server answered first, so the tools and the prompt stay the same between refreshes.
    servers.forEach((server, i) => {
      const entry = listed[i];
      if ("reason" in entry) unavailable.set(server.name, entry.reason);
      else catalog.set(server.name, entry);
    });
    if (generation < this.#mcp.generation) return this.#mcp.listing;
    // Everything the extension is built from: a server's new tool list, or a new reason it is unavailable, reinstalls it.
    const installed = JSON.stringify([[...catalog], [...unavailable]]);
    if (installed !== this.#mcp.key) {
      const { extension, listing } = mcpExtension(this.hub, catalog, unavailable, () => this.discoverMcp());
      this.registry.install(extension);
      this.#mcp = { key: installed, listing, generation };
    } else this.#mcp.generation = generation;
    return this.#mcp.listing;
  }

  /** Public servers connect as they are; a server with `auth: "oauth"` connects with this chat's user's own tokens. */
  async #connect(server: McpServerConfig) {
    if (server.auth !== "oauth") return connectStreamableHttp(server);
    const store = mcpAuthStore(this.uid, server.name);
    const { tokens, redirectUrl } = await store.get();
    if (!tokens || !redirectUrl) throw signInRequired(server.name);
    return connectStreamableHttp(server, new McpOAuthClient(store, server.name, { redirectUrl, interactive: false }));
  }

  /** The owner, or a member: who may open this chat, prompt it and load its pages' per-user data. */
  isInChat(uid: string): boolean {
    return uid === this.uid || this.members.has(uid);
  }

  /** For what a socket sends: its person may have been removed since it opened. */
  #requireInChat(person: Person): void {
    if (!this.isInChat(person.uid)) throw new Error("You are no longer in this chat.");
  }

  /**
   * Let a verified person's socket in, if they are in the chat, and keep the name they last
   * signed in with: the others see it, and the model reads it. A member's sidebar entry for a
   * chat they are no longer in goes when they next try to open it.
   */
  admit(person: Person): boolean {
    if (person.uid === this.uid) {
      this.members.setOwnerName(person);
      return true;
    }
    if (this.members.has(person.uid)) {
      this.members.rename(person);
      return true;
    }
    void this.#index(person.uid).removeSharedChat(this.chatId, this.uid);
    return false;
  }

  people(): ChatPeople {
    return { owner: { uid: this.uid, name: this.members.ownerName(this.uid) }, members: this.members.list() };
  }

  /** What one person's app shows: everyone in the chat, and for the owner the invites still open. */
  peopleFor(uid: string): ChatPeopleView {
    return { ...this.people(), ...(uid === this.uid && { invites: this.members.invites() }) };
  }

  /**
   * One person's message, placed as a `chat.message` entry naming its author.
   * Once the chat has members, the model reads it as "name: text"; until then
   * it gets the text alone, so no name reaches the model for a chat nobody shares.
   * While a run is going, it waits in pi's inbox and is answered next.
   */
  async prompt(text: string, author: Person): Promise<void> {
    this.#requireInChat(author);
    await Promise.all([this.refreshMcpTools().catch(() => {}), this.refreshSkills(), this.refreshFiles()]);
    // Again after the refreshes, which can take seconds: the author may have been removed meanwhile.
    this.#requireInChat(author);
    await this.harness.submit(this.members.hasAny() ? `${author.name}: ${text}` : text, {
      entry: { kind: CHAT_MESSAGE_KIND, data: { uid: author.uid, name: author.name, text } satisfies ChatMessageData },
    });
    // The sidebars are only a convenience: update them off the prompt's path, and let a failure be.
    void this.#touchIndexes(text, author.uid).catch((error) => console.error("chat index:", errorMessage(error)));
  }

  /**
   * Move the chat up in everyone's sidebar. touchChat only names a chat still called "New chat", so the first prompt names it.
   * Members' sidebars get a new title at once, but in a busy chat the others' are bumped at most once a minute: each is
   * another object. The author's own always is.
   */
  async #touchIndexes(text: string, authorUid: string): Promise<void> {
    const title = await this.#directory.touchChat(this.chatId, text);
    const now = Date.now();
    const all = title !== this.#membersTouched.title || now - this.#membersTouched.at >= MEMBERS_TOUCH_MS;
    if (all) this.#membersTouched = { title, at: now };
    const members = this.members.list().filter((member) => all || member.uid === authorUid);
    await Promise.allSettled(members.map((member) => this.#index(member.uid).touchSharedChat(this.chatId, this.uid, title)));
  }

  #index(uid: string) {
    return exports.UserDirectory.getByName(uid);
  }

  /** A single-use link's token, shown once to the owner. The chat itself decides who may: only its owner. */
  async createInvite(by: Person): Promise<(ChatInvite & { token: string }) | ChatRefusal> {
    if (by.uid !== this.uid) return refuse(403, "Only the chat's owner can invite people.");
    this.members.setOwnerName(by);
    const created = await this.members.createInvite();
    if ("error" in created) return refuse(409, created.error);
    this.sockets.broadcastPeople();
    return { ...created.invite, token: formatInviteToken({ ownerUid: this.uid, chatId: this.chatId, secret: created.secret }) };
  }

  revokeInvite(by: Person, id: string): ChatRefusal | null {
    if (by.uid !== this.uid) return refuse(403, "Only the chat's owner can revoke invites.");
    if (!this.members.revokeInvite(id)) return refuse(404, "No such invite.");
    this.sockets.broadcastPeople();
    return null;
  }

  /** Join by an invite's secret; the chat then shows in the new member's sidebar, under `title` from the owner's index. */
  async acceptInvite(secret: string, person: Person, title: string): Promise<ChatRefusal | null> {
    if (person.uid === this.uid) return refuse(403, "This is your own chat.");
    const refused = await this.members.check(secret, person);
    if (refused) return refuse(403, refused.error);
    // The sidebar entry before the invite is used up: a member without one could not reach the chat.
    const index = this.#index(person.uid);
    await index.addSharedChat({ id: this.chatId, ownerUid: this.uid, ownerName: this.members.ownerName(this.uid), title });
    const failed = await this.members.accept(secret, person);
    if (failed) {
      // Used by someone else meanwhile: the entry goes again. Should that fail too, admit removes it.
      await index.removeSharedChat(this.chatId, this.uid).catch(() => {});
      return refuse(403, failed.error);
    }
    this.sockets.broadcastPeople();
    return null;
  }

  /** The owner removes a member, or a member leaves. Their open sockets close at once, and the chat leaves their sidebar. */
  async removeMember(by: Person, uid: string): Promise<ChatRefusal | null> {
    if (by.uid !== this.uid && by.uid !== uid) return refuse(403, "Only the chat's owner can remove people.");
    if (!this.members.remove(uid)) return refuse(404, "No such member.");
    this.sockets.disconnect(uid);
    this.sockets.broadcastPeople();
    await this.#index(uid).removeSharedChat(this.chatId, this.uid);
    return null;
  }

  /** Publish without the model, through the same checks as the agent's tool. Only routed when DEV_TOOLS is on. */
  async devPublish(input: PublishInput) {
    const meta = await publishArtifact(this.scope, input);
    return { artifactId: meta.id, version: meta.latest };
  }

  async abort(by: Person): Promise<void> {
    this.#requireInChat(by);
    await this.harness.abort();
  }

  /** The tools an artifact version declared, with their schemas: what the page's describeTool reads. Null for a version this chat does not have. */
  async artifactTools(artifactId: string, version: number): Promise<DeclaredTool[] | null> {
    const manifest = await this.#manifest(artifactId, version);
    if (!manifest) return null;
    const perServer = await Promise.all(
      (manifest.mcp?.servers ?? []).map(async (entry) =>
        (await this.hub.tools(entry.server).catch(() => [])).filter((tool) => entry.tools.includes(tool.name)).map((tool) => ({ ...tool, server: entry.server })),
      ),
    );
    return perServer.flat();
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
    // People in the chat already see that data in the conversation, so they may load it too.
    if (this.hub.server(server)?.auth === "oauth" && !this.isInChat(viewer)) {
      return fail({ code: "not_granted", server, message: `${server} signs in each user, and this page calls as its author, so only people in its chat can load it.` });
    }

    try {
      const info = await this.hub.tool(server, tool);
      if (!info) return fail({ code: "not_in_manifest", server, message: `${server} no longer has a tool named ${tool}.` });
      const readOnly = isReadOnly(info);

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

/** What the chat's sockets need from the chat. */
interface ChatSession {
  events(): Promise<AgentEventStream>;
  admit(person: Person): boolean;
  peopleFor(uid: string): ChatPeopleView;
  prompt(text: string, author: Person): Promise<void>;
  abort(by: Person): Promise<void>;
  setModel(input: { model?: unknown; thinkingLevel?: unknown }, by: Person): Promise<void>;
}

/** A chat socket's hibernation attachment: whose socket it is. */
type SocketAttachment = { owner: typeof OWNER; person: Person };

/**
 * The chat's browser connections, one or more per person in the chat. Each
 * socket gets its own pi event stream: a snapshot of the conversation first,
 * then one batch per commit. Sockets hibernate; after the object restarts,
 * streams are reattached in onStart.
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
      // A socket from before sockets named their person cannot say whose it is: close it, and the app reconnects as someone.
      if (!this.#person(ws)) close(ws, 1012, "Reconnect");
      else void this.#attach(ws);
    }
  }

  /** The Worker has verified who is connecting and put them in PERSON_HEADER; the chat decides whether they are in it. */
  onWebSocketUpgrade({ request }: { request: Request }): Response | undefined {
    if (!new URL(request.url).pathname.endsWith("/ws")) return undefined;
    const person = JSON.parse(request.headers.get(PERSON_HEADER) ?? "null") as Person | null;
    if (!person || !this.#chat.admit(person)) return closedSocket(SOCKET_NOT_A_MEMBER, "Not in this chat");
    const pair = new WebSocketPair();
    this.lifecycle.sockets.accept(pair[1], [SOCKET_TAG]);
    pair[1].serializeAttachment({ owner: OWNER, person } satisfies SocketAttachment);
    void this.#attach(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * The person a chat socket belongs to; undefined for a socket that is not a chat socket, or is one from before
   * sockets named their person. Lifecycle leaves ownership to each capability: this attachment survives hibernation.
   */
  #person(ws: WebSocket): Person | undefined {
    const attachment = ws.deserializeAttachment() as Partial<SocketAttachment> | null;
    return attachment?.owner === OWNER ? attachment.person : undefined;
  }

  /** Tell every open socket who is in the chat; the owner's also get the open invites. */
  broadcastPeople(): void {
    // One view per person, however many sockets they have open.
    const views = new Map<string, ChatPeopleView>();
    for (const ws of this.lifecycle.sockets.get(SOCKET_TAG)) {
      const person = this.#person(ws);
      if (!person) continue;
      let people = views.get(person.uid);
      if (!people) views.set(person.uid, (people = this.#chat.peopleFor(person.uid)));
      send(ws, { type: "people", people });
    }
  }

  /** Close the sockets of someone no longer in the chat. The app sees the close code and stops reconnecting. */
  disconnect(uid: string): void {
    for (const ws of this.lifecycle.sockets.get(SOCKET_TAG)) {
      if (this.#person(ws)?.uid !== uid) continue;
      void this.#detach(ws);
      send(ws, { type: "removed" });
      close(ws, SOCKET_NOT_A_MEMBER, "Removed from the chat");
    }
  }

  async onWebSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<boolean> {
    const person = this.#person(ws);
    if (!person) return false;
    void this.#attach(ws);
    let message: ChatClientMessage;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return true;
    }
    try {
      if (message.type === "prompt" && message.text.trim()) await this.#chat.prompt(message.text.slice(0, 20_000), person);
      else if (message.type === "abort") await this.#chat.abort(person);
      else if (message.type === "model") await this.#chat.setModel(message, person);
    } catch (error) {
      send(ws, { type: "error", message: errorMessage(error) });
    }
    return true;
  }

  async onWebSocketClose(ws: WebSocket): Promise<boolean> {
    if (!this.#person(ws)) return false;
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
      send(ws, { type: "people", people: this.#chat.peopleFor(this.#person(ws)!.uid) });
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

/**
 * A WebSocket upgrade answered by a socket that closes at once with `code`. A refused upgrade (a plain 4xx) reaches
 * the browser only as an anonymous close; a close code tells the app to stop reconnecting.
 */
export function closedSocket(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].close(code, reason);
  return new Response(null, { status: 101, webSocket: pair[0] });
}

function close(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed.
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
