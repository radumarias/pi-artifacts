import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Models, Provider, UserMessage } from "@earendil-works/pi-ai";
import { createRegistry, Harness, ROOT_CONVERSATION_ID, type AgentChange, type Cursor, type EntryId, type EntryRecord, type JsonObject, type AgentEvent, type AgentEventStream, type ConversationView, type SnapshotEvent } from "@earendil-works/pi-durable";
import { PiHarness, skills } from "agents/harness/pi";
import { Lifecycle, LifecycleCapability, type DurableObjectCapability } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { DurableObject, exports } from "cloudflare:workers";
import {
  CHAT_ASIDE_KIND,
  CHAT_MESSAGE_KIND,
  CHAT_PEOPLE_KIND,
  isOwnedBy,
  isReadOnly,
  manifestOf,
  secondSeat,
  secondSeatUid,
  SOCKET_NOT_A_MEMBER,
  SOCKET_PING,
  STREAM_STEP_MS,
  type ArtifactManifest,
  type ChatClientMessage,
  type ChatContents,
  type ChatDeletion,
  type ChatInvite,
  type AutoPick,
  type ChatMessageData,
  type ChatPeople,
  type ChatPeopleData,
  type ChatPeopleView,
  type ChatServerMessage,
  type ChatStatus,
  type DeclaredTool,
  type McpError,
  type ToolInfo,
  type Person,
  type Presence,
  type ProxyRequest,
  type QueuedMessage,
  type ReplyQuote,
  clampStaleMs,
  everyone,
} from "../shared/protocol.ts";
import { baseName, type AttachmentInput } from "../shared/attachments.ts";
import { keptMentions, parseMentions, summonsAgent, taggedPeople, type MentionInput } from "../shared/mentions.ts";
import { freePath, MAX_LISTED, uploadTargets } from "../shared/uploads.ts";
import { AUTO_MODEL, COMPACTION, isAuto, modelKey, type AutoCandidate, type ModelChoice, type ModelSetting } from "../shared/models.ts";
import { deadline, errorMessage, memoAsync, sha256Hex, singleFlight } from "../shared/util.ts";
import type { ChatSystemPrompt } from "../shared/system-prompt.ts";
import { attachmentContent, parseAttachments, withoutImageData, type ToMarkdown } from "./agent/attachments.ts";
import { filesIndex } from "./agent/file-refs.ts";
import { resolveMentions } from "./agent/mentions.ts";
import { AGENT_REACTOR, isReactable, isReaction, type Reaction, type Reactions } from "../shared/reactions.ts";
import { excerpt, replyLine, replyQuote } from "../shared/replies.ts";
import { peopleExtension, promptExtension, systemPromptExtension, withoutSystemPrompt, type UserPrompts } from "./agent/prompt.ts";
import { skillSource } from "./agent/skills.ts";
import { titleFor } from "./agent/title.ts";
import { autoCandidates, contextTokens, recordRouterSpend, route, routeHistory, routersFrom } from "./agent/route.ts";
import { RunTracker } from "./chat-status.ts";
import { mcpExtension, type ServerCatalog } from "./agent/mcp.ts";
import { artifactExtension, filesExtension, filesIndexExtension, reactionsExtension, sandboxExtension, sandboxName, skillsExtension, type ChatScope } from "./agent/tools.ts";
import { ChatReactions } from "./reactions.ts";
import { checkDraft, FailedChecks, publishDraft, writeDraft, type PublishTarget, type WriteInput } from "./agent/publish.ts";
import { CheckBrowser } from "./artifacts/browser.ts";
import { CHECK_MS, checkPage, type Bridge } from "./artifacts/check.ts";
import { lookFrom } from "./artifacts/look.ts";
import type { ChatAnswer } from "./artifacts/page-calls.ts";
import { chatOutFolder, chatTraces, type ChatTraces } from "./chat-traces.ts";
import { Storage } from "./storage/index.ts";
import { literalPath } from "./storage/paths.ts";
import { newestFirst, type FileEntry } from "./storage/user-files.ts";
import { connectStreamableHttp, signInRequired } from "./mcp/connect.ts";
import { McpOAuthClient } from "./mcp/oauth.ts";
import { McpFailure, McpHub } from "./mcp/hub.ts";
import { mcpServers, sharesResults, type McpServerConfig } from "./mcp/servers.ts";
import { GeminiCompat } from "./gemini.ts";
import { ChatMembers, formatInviteToken } from "./members.ts";
import {
  catalogSource,
  checkSetting,
  currentCatalog,
  defaultModelChoice,
  listedProviders,
  loadCatalog,
  withCurrentPrices,
  withEffortRecorded,
  type Catalog,
} from "./models.ts";
import { inboxIds, queuedIdsOf, queuedMessages } from "./queue.ts";
import { mcpAuthStore, readSystemPrompt, saveSystemPrompt, type Tag } from "./users.ts";

/** Artifacts from the owner's other chats one chat remembers as named with "@" (see ChatAgent.#broughtIn). */
const MAX_BROUGHT_IN = 200;

/** Why the chat refused a person's request, with the HTTP status the Worker answers it with. */
export interface ChatRefusal {
  error: string;
  status: 400 | 403 | 404 | 409;
}

function refuse(status: ChatRefusal["status"], error: string): ChatRefusal {
  return { error, status };
}

const DELETED = "This chat was deleted.";
const DELETING = "This chat is being deleted.";
const GONE_KEY = "deleted";

const SOCKET_TAG = "chat";
const OWNER = "chat-sockets";
/** Set by the Worker on a chat socket's upgrade request, from the verified identity; never taken from the browser. */
export const PERSON_HEADER = "x-pi-person";
/** A page check reuses results this young, so checking a page again and again does not call the servers each time. */
const CHECK_STALE_MS = 2 * 60_000;
/** The live calls one page check may make. */
const MAX_CHECK_CALLS = 40;

/** What a page gets when its call threw: the server's own error, else upstream_error. */
function callFailure(error: unknown, server: string): McpError {
  return error instanceof McpFailure ? error.error : { code: "upstream_error", server, message: errorMessage(error) };
}
const MEMBERS_TOUCH_MS = 60_000;
/** Where the chat keeps, per person other than its owner, the paths they uploaded through it (see noteUploads). */
const UPLOADS_KEY = "uploads:";
/** A file someone the chat is shared with named from their own files. */
type OwnFile = Extract<MentionInput, { kind: "file" }>;

/**
 * How long a chat must stay idle before the sidebars hear its run ended: the next queued message starts its run right
 * after, and the spinner should not blink between them.
 */
const SETTLE_MS = 1_500;
/** How often pi commits a streaming answer and running tool output (see STREAM_STEP_MS). */
const PROGRESS = { partialIntervalMs: STREAM_STEP_MS, outputIntervalMs: STREAM_STEP_MS };
/** The chat's status as the sidebars last heard it, in this object's storage: after a restart, whether a run may be going. */
const STATUS_KEY = "status";
/** Set once the owner's sidebar heard whether this chat has members: chats shared before it kept that tell it once. */
const SHARED_TOLD_KEY = "sharedTold";
/** Set while the chat is on Auto: a router picks the model and effort for each message that starts a run. */
const AUTO_KEY = "auto";
/** How many of the newest transcript entries the router is shown (routeHistory keeps the people's and agent's words). */
const ROUTE_ENTRIES = 40;

/**
 * pi-ai's models, through the chat's AI Gateway, at the vendors' current prices, each reply marked with its effort and
 * Gemini's tool calls signed: AI Gateway's catalog and Workers AI's through `provider`, and the models the providers list
 * (as this isolate's catalog has them now) through one pi provider each.
 */
function piModels(provider: Provider, gemini: GeminiCompat) {
  const models = createModels();
  models.setProvider(withCurrentPrices(provider));
  for (const listed of listedProviders(provider, currentCatalog)) models.setProvider(listed);
  return gemini.models(withEffortRecorded(models));
}

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
  /** Gemini's thought signatures, read off its answers by the AI binding below and put back on its next requests. */
  readonly gemini = new GeminiCompat();
  readonly ai = createAI({ binding: this.gemini.binding(this.env.AI), gateway: this.env.AI_GATEWAY_ID, byokAlias: this.env.AI_BYOK_ALIAS || undefined });
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      // The chat's model may be one a provider listed: have the list before pi looks the model up.
      await this.#catalog();
      const models = piModels(this.ai.provider, this.gemini);
      // A failed run goes on to the messages queued behind it: in a shared chat they are other people's, and would
      // otherwise wait, shown as queued, until someone writes again. Compaction is set here, where the app reads it too.
      const settings = { afterFailedRun: "continue" as const, progress: PROGRESS, compaction: COMPACTION };
      const pi = await Harness.open(storage, { models, registry: this.registry, onWake, settings }, context);
      try {
        // A new chat starts on the model its user last picked, or on Auto (which starts from the deployment's default);
        // PiHarness then finds the root and leaves it as it is.
        if (!(await pi.conversation(ROOT_CONVERSATION_ID, context))) {
          const setting = await this.#savedModel();
          if (isAuto(setting)) this.ctx.storage.kv.put(AUTO_KEY, true);
          else if (setting) await pi.root(context, { agent: this.#agentChange(setting) });
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
  readonly reactions = new ChatReactions(this.ctx.storage.sql);
  readonly sockets = new ChatSockets({
    events: () => this.harness.session().events(),
    runStartedAt: (snapshot) => this.runStartedAt(snapshot),
    toolsStartedAt: (snapshot) => this.toolsStartedAt(snapshot),
    admit: (person) => this.admit(person),
    peopleFor: (uid) => this.peopleFor(uid),
    queued: (ids) => this.queued(ids),
    prompt: (text, author, attachments, mentions, replyTo) => this.prompt(text, author, attachments, mentions, replyTo),
    abort: (by) => this.abort(by),
    setModel: (input, by) => this.setModel(input, by),
    auto: () => this.#auto(),
    reactions: () => this.reactions.all(),
    react: (by, entry, emoji, on) => this.react(by, entry, emoji, on),
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness).use(this.sockets);

  readonly scope: ChatScope;
  readonly #manifests = new Map<string, ArtifactManifest>();
  /** The headless browser the agent checks its pages in. */
  readonly #checkBrowser = new CheckBrowser(this.env.BROWSER);
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
  /** The owner's own system prompt, as last read (see refreshUserPrompt). */
  #userPrompt: Promise<string> | undefined;
  /** When members' sidebars were last bumped, and with which title. */
  #membersTouched = { title: "", at: 0 };
  /** The pi event stream the chat's status comes from while it may change: from a prompt until its runs settle. */
  #runWatch: Promise<AgentEventStream> | undefined;
  /** Publishes an idle status once the chat has stayed idle for SETTLE_MS. */
  #settle: ReturnType<typeof setTimeout> | undefined;
  /** The status the run watch last saw: what a cancelled settle starts again from (#resumeSettle). */
  #watched: ChatStatus | null = null;
  /** Status writes to the sidebars, in order: a later status must not land before an earlier one. */
  #statusWrites: Promise<unknown> = Promise.resolve();
  /** The owner's sidebar hears whether the chat has members in order (#tellShared). */
  #sharedWrites: Promise<unknown> = Promise.resolve();
  /** The last read of the queue, by the inbox ids it was for: every socket asks after the same commit. */
  #queuedRead: { key: string; read: Promise<QueuedMessage[]> } | undefined;
  /** What the transcript names, as far as it was read (see #transcriptTraces). */
  #seen: { through: number; traces: ChatTraces } = { through: -1, traces: chatTraces([]) };
  /** See #oneShotModels. */
  #oneShot: Models | undefined;
  /** See #placeAuto. */
  #autoPlacing: Promise<void> = Promise.resolve();
  /** Set once the owner starts deleting the chat, and kept as its only record after: from then on nobody is in it. */
  #gone = this.#deleted();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // An open chat stays quiet for hours between questions, and proxies close a quiet socket. The app pings to keep it
    // open; answered here, a ping neither wakes the object nor makes the app reconnect (which would wake it and send
    // everyone's app the whole conversation again).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(SOCKET_PING.request, SOCKET_PING.response));
    const scope: ChatScope = (this.scope = {
      uid: this.uid,
      chatId: this.chatId,
      hub: this.hub,
      artifacts: this.storage.artifacts,
      // Deriving the user's key is not free, so derive it once per object.
      files: memoAsync(() => this.storage.userFiles(this.uid)),
      onPublished: (artifact) => this.#directory.recordArtifact({ ...artifact, chatId: this.chatId }),
      broughtIn: (id) => this.#broughtIn().includes(id),
      proposeSkill: (skill) => this.#directory.saveSkill(skill, "agent", false),
      checkPage: (input, signal) =>
        this.#checkBrowser.withPage((page) => checkPage(page, input, this.#checkBridge(input.manifest)), { timeoutMs: CHECK_MS, signal }),
      chatArtifacts: () => this.#directory.listChatArtifacts(this.chatId),
      drafts: memoAsync(() => this.storage.chatDrafts(this.uid, this.chatId)),
      look: lookFrom(env.CHECK_LOOK_MODEL, env.AI),
      publishUnchecked: env.AUTH_MODE === "demo",
      failedChecks: new FailedChecks(),
      react: (emoji) => this.#agentReact(emoji),
    });
    this.registry.install(promptExtension);
    this.registry.install(peopleExtension(() => this.people()));
    this.registry.install(artifactExtension(scope));
    this.registry.install(filesExtension(scope));
    this.registry.install(skillsExtension(scope));
    this.registry.install(reactionsExtension(scope));
    if (env.SANDBOX_ENABLED === "true") this.registry.install(sandboxExtension(scope));
    this.registry.install(systemPromptExtension(() => this.#systemPrompts()));
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

  /**
   * Called by Lifecycle once capabilities have started, including after an eviction, and on every wake from
   * hibernation (a socket opening, a page's call, an alarm). Only a run the object resumes needs the agent's tools
   * now; otherwise the next prompt refreshes them, and a wake stays short: no MCP connections, no listing of files.
   */
  onStart(): void {
    // The sidebars show the chat working: the object restarted mid-run. Follow the run it resumes, or tell them it is over.
    if (this.#gone || this.#status() !== "running") return;
    void this.refreshMcpTools();
    void this.refreshSkills();
    void this.refreshFiles();
    void this.#watchRuns().catch((error: unknown) => console.error("chat status:", errorMessage(error)));
  }

  /** The models a chat can pick, as AI Gateway's providers last listed them. */
  #catalog(): Promise<Catalog> {
    return loadCatalog(catalogSource(this.env, this.storage.models, (promise) => this.ctx.waitUntil(promise)));
  }

  /** The user's last pick, checked again: the list of models can change. On a failure, the deployment's default. */
  async #savedModel(): Promise<ModelSetting | null> {
    try {
      const saved = await this.#directory.modelChoice();
      return saved && checkSetting(await this.#catalog(), saved);
    } catch (error) {
      console.error("model:", errorMessage(error));
      return null;
    }
  }

  #defaults({ model, thinkingLevel }: ModelChoice) {
    return { model: this.ai(model), thinkingLevel };
  }

  /** A choice as pi takes it: the model's provider and id (a provider's own model is not in AI Gateway's catalog). */
  #agentChange({ model, thinkingLevel }: ModelChoice): AgentChange {
    const routed = currentCatalog().model(model) ?? this.ai(model);
    return { model: { provider: routed.provider, modelId: routed.id }, thinkingLevel };
  }

  /**
   * When the snapshot's run started: the time of the message its first input placed in the transcript. Undefined when
   * no run is going, or its start can't be found (the browser then counts from when it connected).
   */
  async runStartedAt(snapshot: SnapshotEvent): Promise<number | undefined> {
    const first = snapshot.run?.inputs[0];
    if (!first) return undefined;
    try {
      const submission = await (await this.harness.pi()).submission(first, BACKGROUND_CONTEXT);
      const placed = (await submission?.status(BACKGROUND_CONTEXT))?.entry;
      const message = snapshot.entries.find((entry) => entry.id === placed)?.model?.[0];
      return message?.role === "user" ? message.timestamp : undefined;
    } catch (error) {
      console.error("run start:", errorMessage(error));
      return undefined;
    }
  }

  /**
   * When each call of the snapshot's round that is running now started, by its call id: its tool task's first change to
   * running. A call whose task can't be read is left out (the browser then counts from when it connected).
   */
  async toolsStartedAt(snapshot: SnapshotEvent): Promise<Record<string, number>> {
    const running = snapshot.tools.filter((slot) => slot.status === "running" && slot.taskId);
    if (!running.length) return {};
    try {
      const pi = await this.harness.pi();
      // Each on its own: one task that can't be read leaves out only its call.
      const read = (slot: (typeof running)[number]) =>
        pi.getTask(slot.taskId!, BACKGROUND_CONTEXT).catch((error: unknown) => (console.error("tool start:", errorMessage(error)), undefined));
      const tasks = await Promise.all(running.map(read));
      return Object.fromEntries(running.flatMap((slot, i) => (tasks[i]?.startedAt === undefined ? [] : [[slot.callId, tasks[i].startedAt]])));
    } catch (error) {
      console.error("tool start:", errorMessage(error));
      return {};
    }
  }

  /**
   * Run this chat on another model or effort, from its next model request on, for everyone in it; or on Auto, which picks
   * them for each message that starts a run (#route), starting with the next. It also becomes the default for new chats
   * of whoever picked it, owner or member.
   */
  async setModel(input: { model?: unknown; thinkingLevel?: unknown }, by: Person): Promise<void> {
    this.#requireInChat(by);
    const setting = checkSetting(await this.#catalog(), input);
    if (!setting) throw new Error(`There is no model named ${String(input.model)} to pick.`);
    const auto = isAuto(setting);
    // On Auto the chat keeps the model it runs on until the next message picks one.
    if (!auto) await (await this.#root()).configure(this.#agentChange(setting), BACKGROUND_CONTEXT);
    if (auto !== this.#auto()) {
      this.ctx.storage.kv.put(AUTO_KEY, auto);
      this.sockets.broadcast({ type: "auto", on: auto });
    }
    // The chat has changed by now, so a failure to remember the pick for new chats is logged, not reported as a failed change.
    await this.#index(this.#account(by.uid))
      .setModelChoice(setting)
      .catch((error: unknown) => console.error("model:", errorMessage(error)));
  }

  /** Whether the chat is on Auto. */
  #auto(): boolean {
    return this.ctx.storage.kv.get<boolean>(AUTO_KEY) === true;
  }

  /**
   * Auto's pick for a message about to start a run: the deployment's router (ROUTER_MODEL, the first the picker lists
   * that answers) reads the end of the conversation and the message (and how many images and other files it attaches),
   * and picks one of AUTO_MODELS and an effort. The router call counts in pi's ledger like any model call. `choice`: the
   * model and effort to run on, when a router picked. Undefined while a run is going (as the sidebars last heard:
   * #applyPick checks again), which the message joins on the model it runs on, and when the conversation could not be
   * read. Never throws: when no router picks in time (ROUTE_MS), the pick is the model the chat runs on, with no router,
   * and the failure is logged.
   */
  async #route(message: string, images: number, files: number): Promise<Routing | undefined> {
    if (this.#status() === "running") return undefined;
    const started = Date.now();
    let read;
    try {
      const [root, catalog] = await Promise.all([this.#root(), this.#catalog()]);
      const [agent, page] = await Promise.all([root.agent(BACKGROUND_CONTEXT), root.entries({}, ROUTE_ENTRIES, undefined, BACKGROUND_CONTEXT)]);
      read = { root, catalog, agent, page };
    } catch (error) {
      console.error("auto:", errorMessage(error));
      return undefined;
    }
    const { root, catalog, agent, page } = read;
    const current = agent.model ? modelKey(agent.model.provider, agent.model.modelId) : this.env.MODEL;
    const kept = (failed: string) => ({ pick: { model: current, thinkingLevel: agent.thinkingLevel, failed, ms: Date.now() - started } });
    const tokens = contextTokens(page.items);
    try {
      const candidates = autoCandidates(catalog.models, this.env.AUTO_MODELS as AutoCandidate[], { images: images > 0, contextTokens: tokens });
      const request = { message, history: routeHistory(page.items), images, files, contextTokens: tokens, current, candidates };
      const gateway = catalogSource(this.env, this.storage.models);
      const routed = await route(routersFrom(this.env.ROUTER_MODEL, catalog, { models: this.#oneShotModels, gateway }), request);
      // Paid for whether or not the pick is used. Only a record: a failure is logged.
      await root
        .commit((tx) => recordRouterSpend(tx, root.id, routed.router.model, routed.usage), BACKGROUND_CONTEXT)
        .catch((error: unknown) => console.error("auto spend:", errorMessage(error)));
      // An effort the model does not take moves to the nearest it does; none named asks for its usual one.
      const choice = catalog.check({ model: routed.pick.model, thinkingLevel: routed.pick.thinkingLevel });
      if (!choice) return kept(`${routed.pick.model} is not in the picker`);
      const pick: AutoPick = { ...choice, ...(routed.pick.reason && { reason: routed.pick.reason }), router: routed.router, ms: Date.now() - started };
      return { pick, choice };
    } catch (error) {
      console.error("auto:", errorMessage(error));
      return kept(errorMessage(error));
    }
  }

  /**
   * Run the chat on Auto's pick, unless a run is going by now (someone else's message started one while the router
   * thought), which the message then joins on the model it runs on, with no pick. The pick, when it stands. Compared
   * with the model the chat runs on now, not when the router was asked: another message may have changed it since.
   * Called only inside #placeAuto, so no other Auto message changes the model between this and its message going in.
   */
  async #applyPick(routed: Routing | undefined): Promise<AutoPick | undefined> {
    if (!routed) return undefined;
    const pi = await this.harness.pi();
    if ((await pi.inspect(BACKGROUND_CONTEXT)).submissions.length) return undefined;
    if (!routed.choice) return routed.pick;
    const root = await this.#root();
    const agent = await root.agent(BACKGROUND_CONTEXT);
    const current = agent.model ? modelKey(agent.model.provider, agent.model.modelId) : this.env.MODEL;
    if (current !== routed.choice.model || agent.thinkingLevel !== routed.choice.thinkingLevel) {
      await root.configure(this.#agentChange(routed.choice), BACKGROUND_CONTEXT);
    }
    return routed.pick;
  }

  /**
   * Apply an Auto message's pick and put the message in, one message at a time: two picked at once would each change
   * the model before either went in, and the run would start on the last one's pick while the first one's says another.
   */
  #placeAuto(place: () => Promise<void>): Promise<void> {
    const placed = this.#autoPlacing.then(place);
    this.#autoPlacing = placed.catch(() => {});
    return placed;
  }

  /** pi-ai's models for the chat's calls outside its runs (Auto's router, the chat's title): made once. */
  get #oneShotModels(): Models {
    return (this.#oneShot ??= piModels(this.ai.provider, this.gemini));
  }

  /** The chat's one conversation. PiHarness has made it by the time pi() resolves. */
  async #root() {
    return (await this.harness.pi()).root(BACKGROUND_CONTEXT);
  }

  /**
   * The people's messages among `ids` (inbox items an event batch reports), in that order: what everyone sees queued.
   * Read from the inbox as it is now; the sockets' event streams keep the conversation's view loaded, so this is cheap.
   */
  async queued(ids: readonly number[]): Promise<QueuedMessage[]> {
    if (!ids.length) return [];
    // Inbox items never change while they wait, so the same ids have the same answer: the sockets share one read.
    const key = ids.join(",");
    if (this.#queuedRead?.key !== key) {
      const read = this.#readView((view) => queuedMessages(view, ids));
      this.#queuedRead = { key, read };
      read.catch(() => {
        if (this.#queuedRead?.read === read) this.#queuedRead = undefined;
      });
    }
    return this.#queuedRead.read;
  }

  /** `read` of the conversation's view as it is now. */
  async #readView<T>(read: (view: ConversationView) => T): Promise<T> {
    const view = await (await this.#root()).viewState(BACKGROUND_CONTEXT);
    try {
      return read(view.value);
    } finally {
      view.dispose();
    }
  }

  /** Withdraw the messages someone left waiting in pi's inbox: once they are out of the chat, none of theirs is answered. */
  async #withdrawQueued(uid: string): Promise<void> {
    const ids = await this.#readView((view) => queuedIdsOf(view, uid));
    if (!ids.length) return;
    const pi = await this.harness.pi();
    await Promise.all(ids.map(async (id) => (await pi.submission(id, BACKGROUND_CONTEXT))?.abort(BACKGROUND_CONTEXT)));
  }

  /**
   * A notice in the transcript that someone joined or left. A passive write: everyone sees it at once, even mid-run,
   * and the model does not read it. Only a notice: it does not hold up the change it reports, and a failure is logged.
   */
  #notePeople({ uid, name }: Person, event: ChatPeopleData["event"]): void {
    const entry = { kind: CHAT_PEOPLE_KIND, data: { uid, name, event } satisfies ChatPeopleData };
    void this.#root()
      .then((root) => root.submit({ type: "write", entry }, BACKGROUND_CONTEXT))
      .catch((error: unknown) => console.error("people notice:", errorMessage(error)));
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
   * Read the owner's own system prompt again: runs before every prompt, so a change made in any chat, or in the
   * account menu, applies from the next message on. Never rejects: on a failure the agent keeps the one it has.
   */
  refreshUserPrompt(): Promise<string> {
    const last = this.#userPrompt;
    return (this.#userPrompt = this.#directory.systemPrompt().then(({ text }) => text, async (error: unknown) => {
      console.error("system prompt:", errorMessage(error));
      return (await last) ?? "";
    }));
  }

  /** What the agent's prompt adds from the owner (see systemPromptExtension): read for every model request. */
  async #systemPrompts(): Promise<UserPrompts> {
    return { user: await (this.#userPrompt ?? this.refreshUserPrompt()), chat: readSystemPrompt(this.ctx.storage.kv) };
  }

  /** The chat's system prompt, for someone in it: everyone may read it, only the owner change it. */
  chatSystemPrompt(uid: string): ChatSystemPrompt | ChatRefusal {
    if (!this.isInChat(uid)) return refuse(403, "You are not in this chat.");
    return { text: readSystemPrompt(this.ctx.storage.kv), editable: uid === this.uid };
  }

  /**
   * The owner saves the chat's system prompt, which adds to their own: the agent follows it from its next model
   * request on, a run going included. Empty clears it.
   */
  setChatSystemPrompt(by: Person, value: unknown): ChatSystemPrompt | ChatRefusal {
    if (by.uid !== this.uid) return refuse(403, "Only the chat's owner can change its system prompt.");
    if (this.#gone) return refuse(404, DELETED);
    const saved = saveSystemPrompt(this.ctx.storage.kv, value);
    return "error" in saved ? refuse(400, saved.error) : { ...saved, editable: true };
  }

  /**
   * Show the agent the user's files, newest first, so a file the user names in
   * a message maps to its path. Runs before every prompt, so files uploaded
   * since are in it. Never rejects: on a failure the agent keeps the list it has.
   */
  readonly refreshFiles = singleFlight(async () => {
    try {
      const index = filesIndex(await (await this.scope.files()).list(), {
        sandbox: this.env.SANDBOX_ENABLED === "true",
        outFolder: chatOutFolder(this.chatId),
      });
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
    return !this.#gone && (uid === this.uid || this.members.has(uid));
  }

  /**
   * Artifacts from the owner's other chats that the owner named here with "@": the agent may read them in this chat
   * (ChatScope.broughtIn). Kept in the chat's storage, so they stay readable for later messages; newest last, at most
   * MAX_BROUGHT_IN.
   */
  #broughtIn(): string[] {
    return this.ctx.storage.kv.get<string[]>("broughtIn") ?? [];
  }

  #bringIn(ids: readonly string[]): void {
    if (!ids.length) return;
    const kept = [...this.#broughtIn().filter((id) => !ids.includes(id)), ...ids].slice(-MAX_BROUGHT_IN);
    this.ctx.storage.kv.put("broughtIn", kept);
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
    if (this.#gone) return false;
    if (person.uid === this.uid) {
      this.members.setOwnerName(person);
      this.#tellSharedOnce();
      return true;
    }
    if (this.members.has(person.uid)) {
      this.members.rename(person);
      this.#tellSharedOnce();
      return true;
    }
    if (this.#hasSidebar(person.uid)) void this.#index(person.uid).removeSharedChat(this.chatId, this.uid);
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
   * Attached files (already uploaded to the owner's files) come before the text,
   * as images, text or names (see attachmentContent). Files and artifacts picked
   * with "@" come after it, by exact path and id (see resolveMentions).
   * While a run is going, it waits in pi's inbox, where everyone sees it queued (see queued), and is answered next.
   *
   * In a shared chat only a message that calls the agent ("@pi") is a prompt; any other is people talking among
   * themselves (#aside), which the agent reads as context the next time it is called.
   */
  async prompt(
    text: string,
    author: Person,
    attachments: readonly AttachmentInput[] = [],
    mentionInputs: readonly MentionInput[] = [],
    replyTo?: number,
  ): Promise<void> {
    // When it came in: the refreshes and copies below can take seconds.
    const sentAt = Date.now();
    this.#requireInChat(author);
    const shared = this.members.hasAny();
    const quote = replyTo === undefined ? null : await this.#quote(replyTo);
    // A reply to the agent calls it too, as a follow-up to what it said. Told for sure once the mentions are known.
    const repliesToAgent = quote !== null && "agent" in quote;
    const calling = !shared || repliesToAgent || summonsAgent(text);
    const byOwner = author.uid === this.uid;
    // Someone else's own files they named come as attachments, copied to the owner's files, where the agent works. The
    // owner's second seat has none of its own.
    const own = this.#account(author.uid) === this.uid ? [] : mentionInputs.filter((input): input is OwnFile => input.kind === "file" && input.own === true);
    const attaching = Promise.all([
      // Someone else attaches only what they uploaded here, or a file the chat already holds: no other of the owner's.
      byOwner ? attachments : this.#attachable(author.uid, attachments),
      own.length ? this.#copyOwnFiles(author, own) : [],
    ]).then(([given, copied]) => [...given, ...copied]);
    // On Auto, the router picks the model while the rest gets ready. Its pick is used only if the message is a prompt.
    const images = attachments.filter((attachment) => attachment.image).length;
    const routing = calling && this.#auto() ? this.#route(text, images, attachments.length + own.length - images) : undefined;
    const [[attached, title], { mentions, note, broughtIn }] = await Promise.all([
      // Named after its text, or its files when it has none: for the sidebars.
      attaching.then(async (inputs) => [
        inputs.length ? await attachmentContent(inputs, await this.scope.files(), this.#toMarkdown) : undefined,
        text || inputs.map((a) => baseName(a.path)).join(", "),
      ] as const),
      resolveMentions(
        mentionInputs.filter((input) => !(own as readonly MentionInput[]).includes(input)),
        {
          ownerUid: this.uid,
          chatId: this.chatId,
          byOwner,
          readMeta: (id) => this.storage.artifacts.readMeta(id),
          mayName: (path) => this.#isChatFile(path),
          // Only someone in the chat can be tagged.
          person: (uid) => everyone(this.people()).find((person) => person.uid === uid) ?? null,
        },
      ),
      // A message to the people in the chat starts no run: the agent needs its tools only when it is called.
      calling && this.refreshMcpTools().catch(() => {}),
      calling && this.refreshSkills(),
      calling && this.refreshFiles(),
      calling && this.refreshUserPrompt(),
    ]);
    // The files they named of their own are named too: "@pi notes.md" is not a call.
    const summoned = !shared || repliesToAgent || summonsAgent(text, [...mentions, ...own]);
    // Again after the refreshes, which can take seconds: the author may have been removed meanwhile.
    this.#requireInChat(author);
    // Nothing left to say: every attachment was one they may not attach.
    if (!text && !attached) return;
    this.#bringIn(broughtIn);
    const written = [quote && replyLine(quote), text, note].filter(Boolean).join("\n\n");
    const said = shared ? `${author.name}: ${written}` : written;
    const content = attached ? [...attached.content, ...(written ? [{ type: "text" as const, text: said }] : [])] : said;
    const dataWith = (auto?: AutoPick) =>
      ({
        uid: author.uid,
        name: author.name,
        text,
        ...(attached && { attachments: attached.attachments }),
        ...(mentions.length && { mentions }),
        ...(quote && { replyTo: quote }),
        sentAt,
        ...(auto && { auto }),
      }) satisfies ChatMessageData;
    const summon = (data: ReturnType<typeof dataWith>) => this.#summon(content, shared ? ({ ...data, summoned: true } satisfies ChatMessageData) : data);
    // The model changes before the message goes in, so the run it starts is on the pick.
    if (summoned && routing) await this.#placeAuto(async () => summon(dataWith(await this.#applyPick(await routing))));
    else if (summoned) await summon(dataWith());
    else await this.#aside(content, dataWith());
    // The sidebars are only a convenience: update them off the prompt's path, and let a failure be.
    // Only a tag whose "@name" is in the text: one sent without it would notify someone of nothing they can see.
    const tags = taggedPeople(keptMentions(text, mentions));
    void this.#touchIndexes(title, author, tags, text).catch((error) => console.error("chat index:", errorMessage(error)));
  }

  /** What a reply quotes of the message at transcript entry `id`; null for one it cannot quote. */
  async #quote(id: number): Promise<ReplyQuote | null> {
    return replyQuote(await this.#entryAt(id));
  }

  /** The transcript entry `id`; undefined for none, or for an id that cannot be one. */
  async #entryAt(id: unknown): Promise<EntryRecord | undefined> {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) return undefined;
    const page = await (await this.#root()).entries({ minEntryId: id as EntryId, maxEntryId: id as EntryId }, 1, undefined, BACKGROUND_CONTEXT);
    return page.items[0];
  }

  /** A message for the agent: pi's input, which starts a run, or waits in the inbox for the one going. */
  async #summon(content: UserMessage["content"], data: JsonObject): Promise<void> {
    // Watching before the input goes in, so the sidebars hear the run start. Not alongside the refreshes: an idle watch
    // lets go after SETTLE_MS, which they can outlast. Only a view: the prompt goes on without it.
    await this.#watchRuns().catch((error: unknown) => console.error("chat status:", errorMessage(error)));
    this.scope.failedChecks.reset();
    try {
      await this.harness.submit(content, { entry: { kind: CHAT_MESSAGE_KIND, data } });
    } catch (error) {
      // No run follows: the watch settles as it would have, or the sidebars keep what they were last told.
      this.#resumeSettle();
      throw error;
    }
  }

  /**
   * A message to the people in a shared chat, which does not call the agent: two passive writes. The `chat.message`
   * entry everyone sees has no model message, so it lands at once, even mid-run; what the model reads of it is a
   * `chat.aside` entry, which pi places at once when the agent is idle, or between its steps while it works.
   */
  async #aside(content: UserMessage["content"], data: JsonObject): Promise<void> {
    const root = await this.#root();
    await root.submit({ type: "write", entry: { kind: CHAT_MESSAGE_KIND, data: { ...data, aside: true } } }, BACKGROUND_CONTEXT);
    const message: UserMessage = { role: "user", content, timestamp: Date.now() };
    await root.submit({ type: "write", entry: { kind: CHAT_ASIDE_KIND, model: [message] } }, BACKGROUND_CONTEXT);
  }

  /**
   * Copy files someone the chat is shared with named from their own files into the owner's uploads/, beside the
   * owner's files rather than over one, as attachments of their message. One that is gone is left out.
   */
  async #copyOwnFiles(author: Person, inputs: readonly OwnFile[]): Promise<AttachmentInput[]> {
    const [theirs, owners] = await Promise.all([this.storage.userFiles(author.uid), this.scope.files()]);
    const taken = await owners.uploadPaths();
    // Named first, so no two take one name; then copied at once.
    const copies = inputs.flatMap((input) => {
      const path = literalPath(input.path);
      if (!path) return [];
      const target = freePath(uploadTargets([baseName(path)])[0], taken);
      taken.add(target);
      return [{ path, target }];
    });
    const copied = await Promise.all(
      copies.map(async ({ path, target }) => {
        const object = await theirs.get(path);
        return object ? { path: await owners.put(target, object.body, object.httpMetadata?.contentType) } : null;
      }),
    );
    return copied.filter((input) => input !== null);
  }

  /** Whether `path` of the owner's files belongs to this chat: attached to its messages, saved by its agent, or in its out/ folder. */
  async #isChatFile(path: string): Promise<boolean> {
    return this.#inChat(path, await this.#transcriptTraces());
  }

  #inChat(path: string, traces: ChatTraces): boolean {
    return path.startsWith(chatOutFolder(this.chatId)) || traces.files.has(path);
  }

  /** The owner's files that belong to this chat (#isChatFile) and are still there, as the people it is shared with see them. */
  async chatFiles(): Promise<FileEntry[]> {
    const [traces, listed] = await Promise.all([this.#transcriptTraces(), this.scope.files().then((files) => files.list())]);
    return listed.filter((file) => this.#inChat(file.path, traces));
  }

  /**
   * What the chat holds of the owner's, for someone in it: its files (chatFiles) and the artifacts published from it.
   * Whether an artifact is unread is the owner's to know: someone else gets none of it.
   */
  async contents(uid: string): Promise<ChatContents | null> {
    if (!this.isInChat(uid)) return null;
    const [files, artifacts] = await Promise.all([this.chatFiles(), this.#directory.listChatArtifacts(this.chatId)]);
    return { files: newestFirst(files), artifacts: uid === this.uid ? artifacts : artifacts.map(({ unread: _, ...artifact }) => artifact) };
  }

  /** Paths someone other than the owner uploaded through this chat (noteUploads): the owner's files they may attach. */
  #uploads(uid: string): string[] {
    return this.ctx.storage.kv.get<string[]>(`${UPLOADS_KEY}${uid}`) ?? [];
  }

  /** Remember what someone other than the owner uploaded for their messages here (POST /api/chats/:id/attachments). */
  noteUploads(uid: string, paths: readonly string[]): void {
    if (uid === this.uid || !this.isInChat(uid)) return;
    const kept = [...new Set([...this.#uploads(uid), ...paths])].slice(-MAX_LISTED);
    this.ctx.storage.kv.put(`${UPLOADS_KEY}${uid}`, kept);
  }

  /** Of the attachments someone other than the owner sends, those they may attach: their uploads here, or the chat's files. */
  async #attachable(uid: string, attachments: readonly AttachmentInput[]): Promise<AttachmentInput[]> {
    if (attachments.length === 0) return [];
    const uploaded = new Set(this.#uploads(uid));
    const traces = await this.#transcriptTraces();
    return attachments.filter((attachment) => uploaded.has(attachment.path) || this.#inChat(attachment.path, traces));
  }

  /** Whether `uid` may open `path` of the owner's files through this chat: the owner any, someone else only a chat file. */
  async mayOpenFile(uid: string, path: string): Promise<boolean> {
    if (!this.isInChat(uid)) return false;
    return uid === this.uid || this.#isChatFile(path);
  }

  /** A PDF or office document as Markdown, by Workers AI (no model is involved for these formats). */
  readonly #toMarkdown: ToMarkdown = async (name, bytes) => {
    const result = await this.env.AI.toMarkdown({ name, blob: new Blob([bytes], { type: "application/octet-stream" }) });
    if (result.format === "error") throw new Error(result.error);
    return result.data;
  };

  /**
   * Move the chat up in everyone's sidebar, marked unread for all but the author. touchChat names a chat that has no
   * name yet after the prompt, so the first prompt names it, and a small model then gives it a better title.
   * Members' sidebars get a new title at once, but in a busy chat the others' are bumped at most once a minute: each is
   * another object. The author's own always is, and so is everyone the message tagged (`tags`), who hears of it at once
   * (a Tag). `titleFrom` names an unnamed chat: the message's text, or its files' names.
   */
  async #touchIndexes(titleFrom: string, author: Person, tags: readonly string[], text: string): Promise<void> {
    const now = Date.now();
    // Someone tagging themselves is told nothing; anyone else tagged is, owner or member.
    const tagged = new Set(tags.filter((uid) => uid !== author.uid));
    const tag: Tag = { from: author.name, text: excerpt(text), at: now };
    const tagOf = (uid: string) => (tagged.has(uid) ? tag : undefined);
    const { title, named } = await this.#directory.touchChat(this.chatId, titleFrom, author.uid !== this.uid, tagOf(this.uid));
    if (named && titleFrom) void this.#nameChat(titleFrom, title).catch((error: unknown) => console.error("chat title:", errorMessage(error)));
    const all = title !== this.#membersTouched.title || now - this.#membersTouched.at >= MEMBERS_TOUCH_MS;
    if (all) this.#membersTouched = { title, at: now };
    const members = this.#listingMembers().filter((member) => all || member.uid === author.uid || tagged.has(member.uid));
    await Promise.allSettled(
      members.map((member) => this.#index(member.uid).touchSharedChat(this.chatId, this.uid, title, member.uid !== author.uid, tagOf(member.uid), named)),
    );
  }

  /**
   * Give the chat a short title from its first message, by the deployment's TITLE_MODEL, in place of `placeholder` (the
   * message cut to fit), in everyone's sidebar. A chat renamed meanwhile keeps its name.
   */
  async #nameChat(message: string, placeholder: string): Promise<void> {
    const title = await titleFor(this.#oneShotModels, this.ai(this.env.TITLE_MODEL), message);
    if (!title || title === placeholder) return;
    const indexes = this.#everyonesIndexes();
    await Promise.allSettled(indexes.map((index) => index.nameChat(this.chatId, this.uid, title, placeholder)));
  }

  /** The status the sidebars last heard. */
  #status(): ChatStatus | null {
    return this.ctx.storage.kv.get<ChatStatus>(STATUS_KEY) ?? null;
  }

  #cancelSettle(): void {
    clearTimeout(this.#settle);
    this.#settle = undefined;
  }

  /**
   * Follow the chat's pi events while its status may change, so the sidebars show it working, waiting on someone, or
   * neither (RunTracker). Attached before every prompt, and after a restart while the chat was working; it lets go once
   * the chat has settled (SETTLE_MS), so an idle chat holds no stream.
   */
  #watchRuns(): Promise<AgentEventStream> {
    this.#cancelSettle();
    if (this.#runWatch) return this.#runWatch;
    const watch = (async () => {
      const events = await this.harness.session().events();
      const tracker = new RunTracker(events.snapshot);
      let shown = tracker.status;
      this.#onStatus(shown);
      events.start(async (batch) => {
        tracker.apply(batch);
        // Most batches are streamed tokens, which change nothing here.
        if (this.#runWatch !== watch || tracker.status === shown) return;
        shown = tracker.status;
        this.#onStatus(shown);
      });
      // A stream pi closed delivers nothing more: the next prompt attaches a new one. Closed mid-run (its session closed),
      // the run goes on: follow it on a new stream, or the sidebars would show it working until the next prompt.
      void events.closed
        .catch(() => {})
        .then(() => {
          if (this.#runWatch !== watch) return;
          this.#runWatch = undefined;
          if (shown === "running" && !this.#gone) void this.#watchRuns().catch((error: unknown) => console.error("chat status:", errorMessage(error)));
        });
      return events;
    })();
    this.#runWatch = watch;
    watch.catch(() => {
      if (this.#runWatch === watch) this.#runWatch = undefined;
    });
    return watch;
  }

  /** A working chat shows at once; an idle one once it has stayed idle for SETTLE_MS, and the watch then ends. */
  #onStatus(status: ChatStatus | null): void {
    this.#cancelSettle();
    this.#watched = status;
    if (status === "running") return this.#publishStatus(status);
    this.#settle = setTimeout(() => {
      this.#unwatchRuns();
      this.#publishStatus(status);
    }, SETTLE_MS);
  }

  /** A watch whose settle a prompt cancelled, for a run that did not come: settle it again. */
  #resumeSettle(): void {
    if (this.#runWatch && this.#settle === undefined && this.#watched !== "running") this.#onStatus(this.#watched);
  }

  /** Stop following the chat's events, and drop a pending settle. */
  #unwatchRuns(): void {
    this.#cancelSettle();
    const watch = this.#runWatch;
    this.#runWatch = undefined;
    void watch?.then((events) => events.stop()).catch(() => {});
  }

  /**
   * Tell the owner's and the members' sidebars the chat's new status. A run that ended leaves a reply, unread for
   * everyone until they look. Only a view: a failure is logged.
   */
  #publishStatus(status: ChatStatus | null): void {
    const previous = this.#status();
    if (status === previous) return;
    this.ctx.storage.kv.put(STATUS_KEY, status);
    const replied = previous === "running";
    const indexes = this.#everyonesIndexes();
    this.#statusWrites = this.#statusWrites.then(() =>
      Promise.allSettled(indexes.map((index) => index.setChatStatus(this.chatId, this.uid, status, replied))).then((results) => {
        for (const result of results) if (result.status === "rejected") console.error("chat status:", errorMessage(result.reason));
      }),
    );
  }

  #index(uid: string) {
    return exports.UserDirectory.getByName(uid);
  }

  /**
   * Whose account someone in the chat is: their own, or for the owner's second seat (secondSeat) the owner's. Only
   * someone with an account of their own has a sidebar (a directory) and files; the seat has neither.
   */
  #account(uid: string): string {
    return uid === secondSeatUid(this.uid) ? this.uid : uid;
  }

  /** Whether `uid`, someone other than the owner, has a sidebar of their own that lists this chat. */
  #hasSidebar(uid: string): boolean {
    return this.#account(uid) === uid;
  }

  /** The members whose sidebars list this chat: all but the owner's second seat. */
  #listingMembers(): Person[] {
    return this.members.list().filter((member) => this.#hasSidebar(member.uid));
  }

  /** The owner's directory and each member's: every sidebar that lists this chat. */
  #everyonesIndexes() {
    return [this.#directory, ...this.#listingMembers().map((member) => this.#index(member.uid))];
  }

  /** A single-use link's token, shown once to the owner. The chat itself decides who may: only its owner. */
  async createInvite(by: Person): Promise<(ChatInvite & { token: string }) | ChatRefusal> {
    if (by.uid !== this.uid) return refuse(403, "Only the chat's owner can invite people.");
    if (this.#gone) return refuse(404, DELETED);
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

  /**
   * Join by an invite's secret; the chat then shows in the new member's sidebar, under `title` from the owner's index.
   * Someone already in the chat (its owner trying their own link, or a member opening it again) just opens the chat,
   * and the link stays unused for whoever it was meant for. Opening a link is deliberate, unlike a reload, so everyone
   * sees that they joined again, from another window or device.
   */
  async acceptInvite(secret: string, person: Person, title: string): Promise<ChatRefusal | null> {
    if (this.#gone) return refuse(404, DELETED);
    if (this.isInChat(person.uid)) {
      // A member whose sidebar entry went missing gets it back, as joining by link always gave it.
      if (person.uid !== this.uid) {
        await this.#index(person.uid).addSharedChat({ id: this.chatId, ownerUid: this.uid, ownerName: this.members.ownerName(this.uid), title, status: this.#status() });
      }
      this.#notePeople(person, "rejoined");
      return null;
    }
    const refused = await this.members.check(secret, person);
    if (refused) return refuse(403, refused.error);
    // The sidebar entry before the invite is used up: a member without one could not reach the chat.
    const index = this.#index(person.uid);
    await index.addSharedChat({ id: this.chatId, ownerUid: this.uid, ownerName: this.members.ownerName(this.uid), title, status: this.#status() });
    const failed = await this.members.accept(secret, person);
    if (failed) {
      // Used by someone else meanwhile: the entry goes again. Should that fail too, admit removes it.
      await index.removeSharedChat(this.chatId, this.uid).catch(() => {});
      return refuse(403, failed.error);
    }
    this.#joined(person);
    return null;
  }

  /**
   * The owner sits in the chat a second time, as a member (secondSeat), to try it as the people they share it with see
   * it. Taken already, it is just opened again. Its windows join as the owner does, with no invite.
   */
  addSecondSeat(by: Person): ChatRefusal | null {
    if (by.uid !== this.uid) return refuse(403, "Only the chat's owner can join it a second time.");
    if (this.#gone) return refuse(404, DELETED);
    const seat = secondSeat(by);
    if (this.members.has(seat.uid)) return null;
    const full = this.members.add(seat);
    if (full) return refuse(409, full.error);
    this.#joined(seat);
    return null;
  }

  /** Someone new is in the chat: everyone's app and the transcript hear it, and the owner's sidebar that it is shared. */
  #joined(person: Person): void {
    this.sockets.broadcastPeople();
    this.#notePeople(person, "joined");
    this.#tellShared();
  }

  /**
   * Tell the owner's sidebar whether the chat has members: on joins and leaves, one after another, each reading the
   * members as it goes, so the last says how things stand. The directory writes only a change. Only a view.
   */
  #tellShared(): void {
    this.#sharedWrites = this.#sharedWrites
      .then(async () => {
        await this.#directory.setChatShared(this.chatId, this.members.hasAny());
        // Told only once it landed: a failed write is tried again on the next open.
        if (!this.#gone) this.ctx.storage.kv.put(SHARED_TOLD_KEY, true);
      })
      .catch((error: unknown) => console.error("chat shared:", errorMessage(error)));
  }

  /** For a chat shared before the owner's directory kept that: tell it once, whoever opens the chat first. */
  #tellSharedOnce(): void {
    if (!this.ctx.storage.kv.get(SHARED_TOLD_KEY)) this.#tellShared();
  }

  /** The owner removes a member, or a member leaves. Their open sockets close at once, and the chat leaves their sidebar. */
  async removeMember(by: Person, uid: string): Promise<ChatRefusal | null> {
    if (by.uid !== this.uid && by.uid !== uid) return refuse(403, "Only the chat's owner can remove people.");
    const member = this.members.remove(uid);
    if (!member) return refuse(404, "No such member.");
    this.sockets.disconnect(uid);
    this.sockets.broadcastPeople();
    this.#notePeople(member, by.uid === uid ? "left" : "removed");
    this.#tellShared();
    // The agent acts as the owner: a removed person's queued requests must not run after they are out.
    await this.#withdrawQueued(uid).catch((error: unknown) => console.error("withdraw queued:", errorMessage(error)));
    if (this.#hasSidebar(uid)) await this.#index(uid).removeSharedChat(this.chatId, this.uid);
    return null;
  }

  /** What deleting the chat would delete with it, for the owner to confirm. */
  async deletionPreview(by: Person): Promise<ChatDeletion | ChatRefusal> {
    if (by.uid !== this.uid) return refuse(403, "Only the chat's owner can delete it.");
    // Deleted already, with only the owner's list entry left: nothing else goes, and the conversation must not reopen.
    if (this.#deleted()) return { title: (await this.#directory.chatTitle(this.chatId)) ?? "", artifacts: [], files: [], members: 0 };
    if (this.#gone) return refuse(409, DELETING);
    const [traces, title, stored] = await Promise.all([
      this.#traces(),
      this.#directory.chatTitle(this.chatId),
      // Only the files still there. A listing stops at MAX_LISTED files; deleteChat does not rely on it.
      this.scope.files().then(async (files) => new Set((await files.list()).map((entry) => entry.path))),
    ]);
    const metas = await Promise.all(traces.artifacts.map((id) => this.storage.artifacts.readMeta(id)));
    return {
      title: title ?? "",
      artifacts: metas.flatMap((meta) => (meta && isOwnedBy(meta, this.uid, this.chatId) ? [{ id: meta.id, title: meta.title }] : [])),
      files: traces.files.filter((path) => stored.has(path)),
      // The people it is shared with: the owner's second seat is the owner.
      members: this.#listingMembers().length,
    };
  }

  /**
   * Delete the chat for good, for its owner: everyone's sockets close and it leaves the members' sidebars; its
   * artifacts, its drafts and its sandbox go, and of the files its messages attached or its agent saved, those the owner confirmed
   * (`files`, as deletionPreview listed them); then everything this object stores (the conversation, its cost, members
   * and invites), leaving only a mark that it was deleted. The Worker then takes it off the owner's list. Each step can
   * run again, so after a failure the owner deletes it again.
   */
  async deleteChat(by: Person, { files }: { files: readonly string[] }): Promise<ChatRefusal | null> {
    if (by.uid !== this.uid) return refuse(403, "Only the chat's owner can delete it.");
    // A try whose answer was lost deleted it already: the Worker only has the owner's list left to update.
    if (this.#deleted()) return null;
    // Another try is deleting it now: a second would race it, and on failing would reopen the chat it deleted.
    if (this.#gone) return refuse(409, DELETING);
    this.#gone = true;
    // The abort below ends the run: no status may be published while the chat is deleted.
    this.#unwatchRuns();
    let disposed = false;
    try {
      // Nothing may publish or save while its traces are read: abort resolves once the run's tools have stopped.
      await this.harness.abort().catch((error: unknown) => console.error("delete, abort:", errorMessage(error)));
      const traces = await this.#traces();
      // Only files the owner was shown, and only this chat's: never one the preview left out, nor any other path sent.
      const confirmed = new Set(files);
      const toDelete = traces.files.filter((path) => confirmed.has(path));
      const members = this.#listingMembers();
      this.sockets.disconnect();
      await Promise.all([
        ...members.map((member) => this.#index(member.uid).removeSharedChat(this.chatId, this.uid)),
        // The store checks each is this chat's: the transcript's ids come from tool results.
        ...traces.artifacts.map((id) => this.storage.artifacts.delete(id, this.uid, this.chatId)),
        toDelete.length && this.scope.files().then((store) => store.delete(toDelete)),
        this.scope.drafts().then((drafts) => drafts.deleteAll()),
        this.env.SANDBOX_ENABLED === "true" && exports.Sandbox.getByName(sandboxName(this.uid, this.chatId)).destroy(),
      ]);
      await this.lifecycle.disableAlarms();
      await this.lifecycle.dispose();
      disposed = true;
      await this.ctx.storage.deleteAll();
      this.ctx.storage.kv.put(GONE_KEY, true);
    } catch (error) {
      this.#gone = false;
      if (!disposed && this.#status() === "running") void this.#watchRuns().catch((e: unknown) => console.error("chat status:", errorMessage(e)));
      // A disposed lifecycle cannot serve the chat again: start afresh from what is still stored.
      if (disposed) setTimeout(() => this.ctx.abort(errorMessage(error)), 0);
      throw error;
    }
    // Not ctx.abort() here: this answer waits for the mark to be stored, and an abort meanwhile would fail it, leaving
    // the chat in the owner's list. The Worker calls resetDeleted once it has the answer.
    return null;
  }

  /**
   * Drop everything a deleted chat still holds in memory (its pages' manifests, MCP connections, the disposed agent) by
   * restarting the object, which the mark then keeps shut. The call itself fails, as every call does that a reset ends.
   */
  resetDeleted(): void {
    if (this.#deleted()) this.ctx.abort(DELETED);
  }

  /** Whether the chat was deleted: its storage holds only the mark deleteChat leaves. */
  #deleted(): boolean {
    return this.ctx.storage.kv.get(GONE_KEY) === true;
  }

  /**
   * What this chat left outside its object: the artifacts it published, by the owner's list and by its transcript (so
   * one the list missed goes too), and the files it attached or saved. Read a page of the history at a time.
   */
  async #traces(): Promise<{ artifacts: string[]; files: string[] }> {
    const [traces, ids] = await Promise.all([this.#transcriptTraces(), this.#directory.chatArtifactIds(this.chatId)]);
    return { artifacts: [...new Set([...traces.artifacts, ...ids])], files: [...traces.files] };
  }

  /**
   * What the transcript names (chatTraces), read on from where the last read stopped: entries never change once
   * written, so a chat's files are known without reading its whole history on every request.
   */
  readonly #transcriptTraces = singleFlight(async (): Promise<ChatTraces> => {
    const root = await this.#root();
    const seen = this.#seen;
    let cursor: Cursor | undefined;
    do {
      const page = await root.entries({ order: "ascending", minEntryId: (seen.through + 1) as EntryId }, 500, cursor, BACKGROUND_CONTEXT);
      chatTraces(page.items, seen.traces);
      const last = page.items.at(-1);
      if (last) seen.through = last.id as number;
      cursor = page.next;
    } while (cursor);
    return seen.traces;
  });

  /**
   * Publish without the model, the way the agent does (write, check, publish), the browser check included: a page with
   * errors throws the check's errors. Only routed when DEV_TOOLS is on.
   */
  async devPublish({ html, mcp, ...target }: PublishTarget & { html: string; mcp?: WriteInput["mcp"] }) {
    const { id } = await writeDraft(this.scope, { html, mcp });
    const { report, unchecked } = await checkDraft(this.scope, id, {});
    if (report?.errors.length) throw new Error(`The check found errors:\n${report.errors.join("\n")}`);
    if (!report && !this.scope.publishUnchecked) throw new Error(`Not checked, so not published: ${unchecked}`);
    const { meta } = await publishDraft(this.scope, { ...target, draftId: id });
    return { artifactId: meta.id, version: meta.latest, checked: report ? { errors: 0, warnings: report.warnings } : { unchecked } };
  }

  /**
   * Add (`on`) or take back `by`'s reaction to transcript entry `entry`: one of the set (shared/reactions.ts), on a
   * person's message or one of the agent's replies. Everyone's sockets hear of a change.
   */
  async react(by: Person, entry: unknown, emoji: unknown, on: boolean): Promise<void> {
    this.#requireInChat(by);
    if (!isReaction(emoji)) throw new Error("Not a reaction this chat takes.");
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) throw new Error("No such message.");
    // Taking one back needs no message: one that is not there changes nothing. An entry with reactions was checked.
    if (on && !this.reactions.has(entry) && !isReactable(await this.#entryAt(entry))) throw new Error("That message cannot be reacted to.");
    this.#setReaction(entry, emoji, by.uid, on);
  }

  /** The agent's reaction (the react tool): to the newest message a person sent, which is the one it is answering. */
  async #agentReact(emoji: Reaction): Promise<string | null> {
    const root = await this.#root();
    let cursor: Cursor | undefined;
    // Newest first, past the run's own tool calls and results; not an aside, which can be written while the agent works.
    for (let pages = 0; pages < 10; pages++) {
      const page = await root.entries({ order: "descending" }, 50, cursor, BACKGROUND_CONTEXT);
      const found = page.items.find((entry) => entry.kind === CHAT_MESSAGE_KIND && !(entry.data as Partial<ChatMessageData> | undefined)?.aside);
      if (found) {
        this.#setReaction(found.id as number, emoji, AGENT_REACTOR, true);
        return (found.data as Partial<ChatMessageData> | undefined)?.name ?? "someone";
      }
      if (!(cursor = page.next)) break;
    }
    return null;
  }

  /** Set a reaction, and tell every socket the entry's reactions when that changed them. */
  #setReaction(entry: number, emoji: Reaction, who: string, on: boolean): void {
    if (this.reactions.set(entry, emoji, who, on)) this.sockets.broadcast({ type: "reacted", entry, reactions: this.reactions.of(entry) });
  }

  /** Stop the agent's run, and the messages queued for it. In a shared chat the others see who stopped it. */
  async abort(by: Person): Promise<void> {
    this.#requireInChat(by);
    const running = this.#status() === "running";
    await this.harness.abort();
    if (running && this.members.hasAny()) this.#notePeople(by, "stopped");
  }

  /**
   * The tools an artifact version declared, with their schemas: what the page's describeTool reads. Null for a version
   * this chat does not have. A viewer who may not call a server (see #mayLoad) does not get its tools either.
   */
  async artifactTools(artifactId: string, version: number, viewer: string): Promise<DeclaredTool[] | null> {
    const manifest = await this.#manifest(artifactId, version);
    if (!manifest) return null;
    const perServer = await Promise.all(
      (manifest.mcp?.servers ?? []).filter((entry) => this.#mayLoad(entry.server, viewer)).map(async (entry) =>
        (await this.hub.tools(entry.server).catch(() => [])).filter((tool) => entry.tools.includes(tool.name)).map((tool) => ({ ...tool, server: entry.server })),
      ),
    );
    return perServer.flat();
  }

  /**
   * One MCP call from a published page. The Worker has already resolved the viewer, and serves this answer again to
   * other viewers when it is `shareable` (see PageCallCache).
   */
  async artifactCall({ artifactId, viewer, request }: ArtifactCall): Promise<ChatAnswer> {
    const fail = (error: McpError): ChatAnswer => ({ response: { ok: false, error } });
    const { server, tool, input, mode } = request;

    const manifest = await this.#manifest(artifactId, request.version);
    if (!manifest) return fail({ code: "not_in_manifest", server, message: "No such artifact version in this chat." });

    if (!this.#mayLoad(server, viewer)) {
      return fail({ code: "not_granted", server, message: `${server} signs in each user, and this page calls as its author, so only people in its chat can load it.` });
    }

    try {
      const info = await this.#declaredTool(manifest, server, tool, mode);
      if ("code" in info) return fail(info);

      if (mode === "read") {
        const staleMs = clampStaleMs(request.staleMs);
        const read = await this.hub.read(server, tool, input, { staleMs, viewer });
        const config = this.hub.server(server);
        return {
          response: { ok: true, result: read.result, storedAt: read.storedAt, nextRefreshAt: staleMs > 0 ? read.nextRefreshAt : undefined },
          // Who may load it did not depend on this viewer, and the result is not theirs alone.
          ...(config && !this.#membersOnly(server) && sharesResults(config) && { shareable: true }),
        };
      }

      if (!isReadOnly(info) && viewer !== this.uid) {
        return fail({ code: "not_granted", server, message: `${tool} can change data, so only the page's author can call it.` });
      }
      const result = await this.hub.call(server, tool, input);
      return { response: { ok: true, result, storedAt: Date.now() } };
    } catch (error) {
      return fail(callFailure(error, server));
    }
  }

  /**
   * The tool a page calls, if its manifest declares it and the server still has it, and if `mode` is "read" (a watch
   * or a cached read), only a read-only one. Else the error the page gets.
   */
  async #declaredTool(manifest: ArtifactManifest, server: string, tool: string, mode: "read" | "call"): Promise<ToolInfo | McpError> {
    if (!manifest.mcp?.servers.find((entry) => entry.server === server)?.tools.includes(tool)) {
      return { code: "not_in_manifest", server, message: `This page does not declare ${server}/${tool}.` };
    }
    const info = await this.hub.tool(server, tool);
    if (!info) return { code: "not_in_manifest", server, message: `${server} no longer has a tool named ${tool}.` };
    if (mode === "read" && !isReadOnly(info)) {
      return { code: "bad_request", server, message: `${tool} is not read-only, so it cannot be watched or cached; use callTool.` };
    }
    return info;
  }

  /**
   * Answers a page's calls while it is checked, before it is published: as its author would get them, from the
   * manifest it is checked with. Only read-only tools run, from results up to CHECK_STALE_MS old; the check never
   * changes anything.
   */
  #checkBridge(manifest: ArtifactManifest): Bridge {
    let calls = 0;
    return async (request) => {
      const { server, tool } = request;
      try {
        const info = await this.#declaredTool(manifest, server, tool, request.method === "call" ? request.mode : "call");
        if ("code" in info) return { ok: false, error: info };
        if (request.method === "describe") {
          return { ok: true, tool: { name: info.name, description: info.description, inputSchema: info.inputSchema, annotations: info.annotations } };
        }
        if (!isReadOnly(info)) {
          return { ok: false, error: { code: "not_granted", server, message: `${tool} can change data, so the check does not run it; the page gets this error instead.` } };
        }
        if (++calls > MAX_CHECK_CALLS) return { ok: false, error: { code: "rate_limited", server, message: `A check makes at most ${MAX_CHECK_CALLS} live calls.` } };
        const read = await this.hub.read(server, tool, request.input, { staleMs: CHECK_STALE_MS, viewer: this.uid });
        return { ok: true, result: read.result };
      } catch (error) {
        return { ok: false, error: callFailure(error, server) };
      }
    };
  }

  /**
   * Whether this viewer may load a page's data from this server. A page calls as its author, so for a server that signs in
   * each user that would show the author's data to anyone with the link; only people in the chat, who see that data in
   * the conversation anyway, may load it.
   */
  #mayLoad(server: string, viewer: string): boolean {
    return !this.#membersOnly(server) || this.isInChat(viewer);
  }

  /** Whether only people in the chat may load this server's data (see #mayLoad). */
  #membersOnly(server: string): boolean {
    return this.hub.server(server)?.auth === "oauth";
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

/** Auto's pick for a message, and the model and effort to run on when a router picked (see ChatAgent's #route). */
interface Routing {
  pick: AutoPick;
  choice?: ModelChoice;
}

/** What the chat's sockets need from the chat. */
interface ChatSession {
  events(): Promise<AgentEventStream>;
  runStartedAt(snapshot: SnapshotEvent): Promise<number | undefined>;
  toolsStartedAt(snapshot: SnapshotEvent): Promise<Record<string, number>>;
  admit(person: Person): boolean;
  peopleFor(uid: string): ChatPeopleView;
  queued(ids: readonly number[]): Promise<QueuedMessage[]>;
  prompt(text: string, author: Person, attachments: readonly AttachmentInput[], mentions: readonly MentionInput[], replyTo?: number): Promise<void>;
  abort(by: Person): Promise<void>;
  setModel(input: { model?: unknown; thinkingLevel?: unknown }, by: Person): Promise<void>;
  /** Whether the chat is on Auto. */
  auto(): boolean;
  reactions(): Reactions;
  react(by: Person, entry: unknown, emoji: unknown, on: boolean): Promise<void>;
}

/** How long a socket's attach may take to send its snapshot (see ChatSockets.#attach). */
const ATTACH_MS = 30_000;

/**
 * A socket attaches again at once when pi ends its stream, but at most once in this long: when pi ends it again sooner,
 * the socket waits for its next message (or the object's next start). Otherwise a pi that fails each time it opens
 * would be opened again and again, for every socket.
 */
const REATTACH_MS = 10_000;

/** An attach that did not send its snapshot in time. */
class AttachStalled extends Error {}

/**
 * A chat socket's hibernation attachment: whose socket it is, and a digest of the last snapshot it was sent (see
 * ChatSockets.#attach).
 */
type SocketAttachment = { owner: typeof OWNER; person: Person; sent?: string };

/**
 * The chat's browser connections, one or more per person in the chat. Each
 * socket gets its own pi event stream: a snapshot of the conversation first,
 * then one batch per commit. Sockets hibernate; after the object restarts,
 * streams are reattached in onStart, and a stream pi ends is replaced at once.
 */
class ChatSockets extends LifecycleCapability implements DurableObjectCapability {
  readonly #chat: ChatSession;
  readonly #streams = new Map<WebSocket, Promise<AgentEventStream>>();
  /** When each socket was last attached again because pi ended its stream (see REATTACH_MS). */
  readonly #reattached = new WeakMap<WebSocket, number>();

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
    this.#broadcastPresence();
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

  /** Tell every open socket the same thing: an entry's reactions changed, or someone turned Auto on or off. */
  broadcast(message: ChatServerMessage): void {
    for (const ws of this.lifecycle.sockets.get(SOCKET_TAG)) if (this.#person(ws)) send(ws, message);
  }

  /**
   * Tell every open socket who has the chat open, and in how many windows: each socket is one. `closing` are
   * sockets on their way out, which the list of sockets may still hold.
   */
  #broadcastPresence(closing: ReadonlySet<WebSocket> = new Set()): void {
    const sockets: WebSocket[] = [];
    const windows = new Map<string, number>();
    for (const ws of this.lifecycle.sockets.get(SOCKET_TAG)) {
      const uid = closing.has(ws) ? undefined : this.#person(ws)?.uid;
      if (!uid) continue;
      sockets.push(ws);
      windows.set(uid, (windows.get(uid) ?? 0) + 1);
    }
    const online: Presence[] = [...windows].map(([uid, count]) => ({ uid, windows: count }));
    for (const ws of sockets) send(ws, { type: "presence", online });
  }

  /**
   * Close the sockets of someone no longer in the chat, or with no `uid` everyone's, as the chat is deleted. The app
   * sees the close code and stops reconnecting.
   */
  disconnect(uid?: string): void {
    const deleted = uid === undefined;
    const closing = new Set<WebSocket>();
    for (const ws of this.lifecycle.sockets.get(SOCKET_TAG)) {
      if (!deleted && this.#person(ws)?.uid !== uid) continue;
      void this.#detach(ws);
      send(ws, { type: deleted ? "deleted" : "removed" });
      close(ws, SOCKET_NOT_A_MEMBER, deleted ? "Chat deleted" : "Removed from the chat");
      closing.add(ws);
    }
    // A close the chat makes itself may never come back as onWebSocketClose: the others hear of it now.
    if (closing.size) this.#broadcastPresence(closing);
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
      if (message.type === "prompt") {
        const attachments = parseAttachments(message.attachments);
        const mentions = parseMentions(message.mentions);
        const text = String(message.text ?? "").trim().slice(0, 20_000);
        const replyTo = typeof message.replyTo === "number" ? message.replyTo : undefined;
        if (text || attachments.length) await this.#chat.prompt(text, person, attachments, mentions, replyTo);
      }
      else if (message.type === "abort") await this.#chat.abort(person);
      else if (message.type === "model") await this.#chat.setModel(message, person);
      else if (message.type === "react") await this.#chat.react(person, message.entry, message.emoji, message.on === true);
    } catch (error) {
      send(ws, { type: "error", message: errorMessage(error) });
    }
    return true;
  }

  async onWebSocketClose(ws: WebSocket): Promise<boolean> {
    if (!this.#person(ws)) return false;
    this.#broadcastPresence(new Set([ws]));
    await this.#detach(ws);
    return true;
  }

  async onWebSocketError(ws: WebSocket): Promise<boolean> {
    return this.onWebSocketClose(ws);
  }

  /**
   * Follow the conversation for `ws`: a snapshot first, then each commit. Every wake (a page's call, an alarm) attaches
   * every open socket again, and each would get the whole conversation again; a socket already sent this same snapshot
   * has everything in it, as the commits since reached it while the object was awake, so it is sent only a changed one.
   *
   * An attach that has not sent its snapshot within ATTACH_MS is given up: the socket closes, and the app reconnects.
   * Work an attach waits on keeps the request that opened the socket going, and with it the object awake for as long as
   * the socket stays open (in production, hours, with nothing running). The log names the step it was stuck at.
   */
  #attach(ws: WebSocket): Promise<AgentEventStream> {
    const known = this.#streams.get(ws);
    if (known) return known;
    let step = "opening the conversation";
    const opening = (async () => {
      const events = await this.#chat.events();
      // A stream pi ended itself delivers nothing more: its session closed (a storage error fails it, and pi opens again
      // for the next prompt or wake). The socket stays open, and every later attach would find the dead stream, so the
      // page heard nothing until it was reloaded. Follow the conversation on a new stream: its snapshot brings what the
      // socket missed. A stream this class stopped has left #streams already. Followed from here, as the session can
      // close while the snapshot below is read, and a stream that has ended cannot be started.
      let ended = false;
      void events.closed.then((end) => {
        ended = true;
        if (end.reason === "stopped" || this.#streams.get(ws) !== attached) return;
        const cause = "error" in end ? `: ${errorMessage(end.error)}` : "";
        this.#streams.delete(ws);
        const now = Date.now();
        const again = ws.readyState === WebSocket.OPEN && now - (this.#reattached.get(ws) ?? -Infinity) >= REATTACH_MS;
        const next = again ? "attaching again" : "waiting for the socket's next message";
        console.error(`chat socket: events ended (${end.reason}${cause}), ${next}`);
        if (!again) return;
        this.#reattached.set(ws, now);
        void this.#attach(ws);
      });
      step = "reading its run, calls and queue";
      const attachment = ws.deserializeAttachment() as SocketAttachment;
      send(ws, { type: "people", people: this.#chat.peopleFor(attachment.person.uid) });
      send(ws, { type: "reactions", reactions: this.#chat.reactions() });
      // After events(): a new chat that starts on Auto is set so as pi opens it.
      send(ws, { type: "auto", on: this.#chat.auto() });
      // Timed only once it is to be sent: a wake attaches every socket again, and most find their snapshot already sent.
      const snapshot = await this.#events([events.snapshot], false);
      const sent = await sha256Hex(JSON.stringify([snapshot.events, snapshot.queued]));
      if (sent !== attachment.sent && send(ws, { ...snapshot, ...(await this.#timing(events.snapshot)) })) {
        ws.serializeAttachment({ ...attachment, sent } satisfies SocketAttachment);
      }
      // Ended meanwhile, it has been replaced above (or left for the socket's next message).
      if (!ended) {
        events.start(async (batch) => {
          if (!send(ws, await this.#events(batch))) await this.#detach(ws);
        });
      }
      return events;
    })();
    const attached = deadline(opening, ATTACH_MS, () => new AttachStalled(`no snapshot after ${ATTACH_MS / 1000} s, stuck ${step}`));
    this.#streams.set(ws, attached);
    attached.catch((error) => {
      // Should the stream come after all, it goes unused.
      if (error instanceof AttachStalled) void opening.then((events) => events.stop()).catch(() => {});
      // Detached, or replaced as pi ended the stream it was opening: the socket has nothing more to hear from this one.
      if (this.#streams.get(ws) !== attached) return;
      this.#streams.delete(ws);
      if (error instanceof AttachStalled) {
        console.error("chat socket:", error.message);
        close(ws, 1011, "Reconnect");
        // A close the chat makes itself may never come back as onWebSocketClose: the others hear of it now.
        this.#broadcastPresence(new Set([ws]));
      } else {
        send(ws, { type: "error", message: `Could not open the conversation: ${errorMessage(error)}` });
      }
    });
    return attached;
  }

  /**
   * A batch for the browser. A snapshot (on attach, or when the stream overflowed) comes with how long its run and its
   * running calls have gone, unless `timed` is false; a batch that changes pi's inbox, with the people's messages waiting in it.
   */
  async #events(batch: readonly AgentEvent[], timed = true): Promise<Extract<ChatServerMessage, { type: "events" }>> {
    const snapshot = batch.findLast((event) => event.type === "snapshot");
    const ids = inboxIds(batch);
    const [timing, queued] = await Promise.all([
      snapshot && timed ? this.#timing(snapshot) : undefined,
      // Only a view of what pi has queued: without it the chat still works.
      ids && this.#chat.queued(ids).catch((error: unknown) => (console.error("queue:", errorMessage(error)), [])),
    ]);
    return { type: "events", events: batch.map((event) => withoutImageData(withoutSystemPrompt(event))), ...timing, ...(queued && { queued }) };
  }

  /** How long the snapshot's run and its running calls have gone, by the server's clock. */
  async #timing(snapshot: SnapshotEvent): Promise<Pick<ChatServerMessage & { type: "events" }, "runElapsedMs" | "toolsElapsedMs">> {
    const [started, toolsStarted] = await Promise.all([this.#chat.runStartedAt(snapshot), this.#chat.toolsStartedAt(snapshot)]);
    const now = Date.now();
    const since = (at: number) => Math.max(0, now - at);
    return {
      runElapsedMs: started === undefined ? undefined : since(started),
      toolsElapsedMs: Object.fromEntries(Object.entries(toolsStarted).map(([id, at]) => [id, since(at)])),
    };
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
