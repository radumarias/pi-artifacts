import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, Model, Models, Usage, UserMessage } from "@earendil-works/pi-ai";
import { createRegistry, Harness, ROOT_CONVERSATION_ID, type Agent, type AgentChange, type AgentState, type Submission, type Conversation, type Cursor, type EntryId, type EntryRecord, type Extension, type JsonObject, type AgentEvent, type AgentEventStream, type ConversationView, type SnapshotEvent } from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { PiHarness, skills } from "agents/harness/pi";
import { Lifecycle, LifecycleCapability, type DurableObjectCapability } from "agents/lifecycle";
import { Scheduler } from "agents/schedules";
import { DurableObject, exports } from "cloudflare:workers";
import {
  CHAT_ASIDE_KIND,
  CHAT_MESSAGE_KIND,
  CHAT_PEOPLE_KIND,
  CHECK_TOOL,
  isOwnedBy,
  isReadOnly,
  WRITE_TOOL,
  isSecondSeatUid,
  type ArtifactSummary,
  manifestOf,
  writtenBy,
  secondSeat,
  secondSeatUid,
  SOCKET_NOT_A_MEMBER,
  SOCKET_PING,
  STREAM_STEP_MS,
  type ArtifactManifest,
  type ArtifactMeta,
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
  type IncomingMessage,
  type ToolPickNote,
  clampStaleMs,
  incomingKey,
  everyone,
} from "../shared/protocol.ts";
import { baseName, type AttachmentInput } from "../shared/attachments.ts";
import { keptMentions, parseMentions, summonsAgent, taggedPeople, type Mention, type MentionInput } from "../shared/mentions.ts";
import { freePath, MAX_LISTED, uploadTargets } from "../shared/uploads.ts";
import {
  AUTO_LEDGER_PREFIX,
  AUTO_MODEL,
  COMPACTION,
  compactionOverrides,
  HINT_LEDGER_PREFIX,
  isAuto,
  modelKey,
  REVIEW_LEDGER_PREFIX,
  SKILLS_LEDGER_PREFIX,
  TOOL_PICK_LEDGER_PREFIX,
  type AutoCandidate,
  type ModelChoice,
  type ModelSetting,
} from "../shared/models.ts";
import { deadline, errorMessage, formatBytes, memoAsync, serial, sha256Hex, singleFlight } from "../shared/util.ts";
import type { ChatSystemPrompt } from "../shared/system-prompt.ts";
import type { SkillFileInfo } from "../shared/skill-files.ts";
import { attachmentContent, parseAttachments, withoutImageData, type ToMarkdown } from "./agent/attachments.ts";
import { filesIndex } from "./agent/file-refs.ts";
import { resolveMentions } from "./agent/mentions.ts";
import { AGENT_REACTOR, isReactable, isReaction, type Reaction, type Reactions } from "../shared/reactions.ts";
import { excerpt, replyLine, replyQuote } from "../shared/replies.ts";
import { peopleExtension, promptExtension, systemPromptExtension, withoutSystemPrompt, type UserPrompts } from "./agent/prompt.ts";
import { skillClassifier, skillMessage, type SkillChoice, type SkillClassifier } from "./agent/skill-pick.ts";
import { isActive, type SkillInfo } from "../shared/skills.ts";
import { skillSource } from "./agent/skills.ts";
import { titleFor } from "./agent/title.ts";
import { autoCandidates, contextTokens, route, routeHistory, routersFrom, routerSpend } from "./agent/route.ts";
import { callHinter, HINT_MS, HINT_THRESHOLD, worthAsking, type CallHinter } from "./agent/call-hint.ts";
import { recordSpend } from "./agent/ledger.ts";
import type { ModelRunner } from "./agent/workers-ai.ts";
import { RunTracker } from "./chat-status.ts";
import { mcpExtension, type McpToolInfo, type ServerCatalog } from "./agent/mcp.ts";
import { deferredTools, MIN_TOOLS_TO_PICK, pickerId, pickFailure, pickTools, TOOL_PICK_MS, toolPicker, toolsToOffer, type PickableTool } from "./agent/tool-pick.ts";
import { artifactExtension, filesExtension, filesIndexExtension, reactionsExtension, sandboxExtension, sandboxName, skillsExtension, type ChatScope } from "./agent/tools.ts";
import type { SandboxFile } from "./sandbox.ts";
import { formatSkillFile } from "./skills/index.ts";
import { ChatReactions } from "./reactions.ts";
import { clearImported, DumpError, dumpChat, hasConversation, importedRoster, restorePart } from "./chat-dump.ts";
import { idRemapper, type ChatDumpCursor, type ChatDumpPage, type ChatDumpPart, type ChatImportStart } from "../shared/data-export.ts";
import { checkDraft, FailedChecks, publishDraft, writeDraft, type PublishScope, type PublishTarget, type WriteInput } from "./agent/publish.ts";
import { CheckBrowser } from "./artifacts/browser.ts";
import { CHECK_MS, checkPage, type Bridge } from "./artifacts/check.ts";
import { lookFrom } from "./artifacts/look.ts";
import { modelReviewer, ReviewStopped, type PageReviewer } from "./artifacts/review.ts";
import type { ChatAnswer } from "./artifacts/page-calls.ts";
import { chatOutFolder, chatTraces, type ChatTraces } from "./chat-traces.ts";
import { Storage } from "./storage/index.ts";
import { literalPath } from "./storage/paths.ts";
import { newestFirst, type FileEntry } from "./storage/user-files.ts";
import { connectStreamableHttp, signInRequired } from "./mcp/connect.ts";
import { McpOAuthClient } from "./mcp/oauth.ts";
import { McpFailure, McpHub } from "./mcp/hub.ts";
import { mcpServers, sharesResults, watchableForAll, type McpServerConfig } from "./mcp/servers.ts";
import { CacheWarmer } from "./cache-warmer.ts";
import { GeminiCompat } from "./gemini.ts";
import { ChatMembers, formatInviteToken } from "./members.ts";
import {
  catalogSource,
  checkSetting,
  currentCatalog,
  defaultModelChoice,
  gatewayAI,
  startingSetting,
  piModels,
  loadCatalog,
  markFailing,
  modelsNamed,
  type Catalog,
} from "./models.ts";
import { withFailuresReported } from "./model-health.ts";
import { chatAgentName, parseChatAgentName } from "./chat-name.ts";
import { inboxIds, queuedIdsOf, queuedMessages } from "./queue.ts";
import { mcpAuthStore, readSystemPrompt, saveSystemPrompt, SYSTEM_PROMPT_KEY, type Tag } from "./users.ts";
import {
  AGENT_ID_PATTERN,
  AUTONOMY_LABELS,
  CHAT_AGENT_KIND,
  CHAT_TURN_KIND,
  inputOf,
  copiedFields,
  serversNamed,
  type AgentDefinition,
  type AgentStep,
  type AgentTurnView,
  type ChatAgentReplyData,
  type ChatAgents,
  type ChatAgentView,
  type ChatTurnData,
  type SharedAgentView,
} from "../shared/agents.ts";
import { AgentTurns, sessionOf, type TurnHost } from "./agents/controller.ts";
import { isTurnEntry, TurnFilter } from "./agents/live.ts";
import { ChatRoster, type AgentTurn, type RosterEntry } from "./agents/roster.ts";
import { reportOf, SignInNeeded, whenOf, type DeliveryRequest } from "./agents/runs/executor.ts";
import { AgentRunner, type RunAlarm, type RunnerHost, type WatchAlarm } from "./agents/runs/runner.ts";
import { AgentRuns } from "./agents/runs/store.ts";
import { reportContext, runInstructions, RUN_STEP_KIND, workSpend, type RunStepData } from "./agents/runs/report.ts";
import { publishedAlready, publishFindings, publishRebuilt, readOnlyDeclaration, runMark } from "./agents/runs/page.ts";
import { compileWorkflow } from "./agents/runs/compile.ts";
import { sourceName } from "./agents/runs/source.ts";
import type { Value } from "../shared/conditions.ts";
import { runRef, type AgentRunDetail, type AgentRunList, type RunDelivery, type RunRef } from "../shared/runs.ts";
import { agentsExtension } from "./agents/tools.ts";
import { agentInstructions, allowedTools, askOf, assistantText, attachedNote, MAX_ASK_CHARS, messageAskKey, runTools, speakersFor } from "./agents/turns.ts";
import {
  answersEveryMessage,
  CHAT_CONTEXT_KIND,
  CHAT_EVENT_KIND,
  isChatKind,
  kindAfterJoin,
  legacyKind,
  losesAccess,
  type BranchedFrom,
  type ChatEventData,
  type ChatKind,
  type ChatMemberVia,
  type ChatPage,
} from "../shared/chat-kinds.ts";
import { branchKind, ChatKindState, KIND_KV, MAX_BRANCHES, planKindChange } from "./chat-kind.ts";
import { branchContext, branchCopies, summaryFor } from "./branch.ts";
import { newId } from "./storage/index.ts";

/** Artifacts from the owner's other chats one chat remembers as named with "@" (see ChatAgent.#broughtIn). */
const MAX_BROUGHT_IN = 200;
/** How many bytes of skill files a chat object keeps in memory: a design library or two. */
const SKILL_FILE_CACHE_BYTES = 4_000_000;

/** Why the chat refused a person's request, with the HTTP status the Worker answers it with. */
export interface ChatRefusal {
  error: string;
  status: 400 | 403 | 404 | 409;
}

/** A turn as the people in the chat see it: never the message that asked for it. */
const turnView = ({ root: _root, ask: _ask, submitted: _submitted, ...turn }: AgentTurn): AgentTurnView => turn;

function refuse(status: ChatRefusal["status"], error: string): ChatRefusal {
  return { error, status };
}

/** Wait for writes that are only a view (other people's sidebars), logging each one that failed under `label`. */
async function settleLogged(label: string, writes: readonly Promise<unknown>[]): Promise<void> {
  for (const result of await Promise.allSettled(writes)) if (result.status === "rejected") console.error(`${label}:`, errorMessage(result.reason));
}

/** Just who someone is, without how they joined. */
function personOf({ uid, name }: Person): { uid: string; name: string } {
  return { uid, name };
}

const DELETED = "This chat was deleted.";
const DELETING = "This chat is being deleted.";
const PAGE_CLOSED = "This chat is no longer open to everyone who can see the page.";
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
/** Why an Auto message kept the chat's model, when a reply was running as it came in, or started while the router thought. */
const RUNNING_WHEN_SENT = "a reply was still running when it was sent, so the router was not asked";
const RUNNING_WHEN_PICKED = "a reply started while the router picked, so the message went in on the model it runs on";
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
/** The names of the skills shown in this chat so far, once SKILLS_MODEL picks them (worker/agent/skill-pick.ts). */
const SHOWN_SKILLS_KEY = "skillsShown";
/** The artifacts of the owner's other chats this one brought in (see #broughtIn). */
const BROUGHT_IN_KEY = "broughtIn";
/** The settings of a chat its export carries, beside its tables (worker/chat-dump.ts), its own system prompt among them. */
const EXPORTED_KV = [AUTO_KEY, SHOWN_SKILLS_KEY, BROUGHT_IN_KEY, SYSTEM_PROMPT_KEY, ...KIND_KV];
/** Set once the sidebars of everyone in a chat shared before they remembered people have met (#meetOnce). */
const PEOPLE_TOLD_KEY = "peopleTold";
/** How much of a long chat a branch reads to copy, in pages of 200 entries, newest first. */
const MAX_BRANCH_PAGES = 25;
/** Entries copied into a branch per call to it. */
const BRANCH_COPY_BATCH = 200;
/** Set while an import fills the chat (ChatImportStart): what it puts in place of what. */
const IMPORTING_KEY = "importing";
/** Set once an import stored every part: until its owner's list has the chat, the same import may start it again. */
const IMPORTED_KEY = "imported";
/**
 * How far pi's log was read for the agents pi's answers name (#scanPi): the newest entry read, and the chain of
 * hand-offs pi's latest input is in when another agent handed it that turn, so the agents pi names in its answer stay
 * within the chain's cap. Set when the first agent joins, so pi's earlier answers start nothing.
 */
const PI_SCAN_KEY = "piScan";
type PiScan = { through: number; chain?: { hop: number; root: number } };
/**
 * Set on an agent's home conversation: the agent whose own chat this is (the owner's directory marks the chat with
 * it too). There the agent is on the roster and answers every message that calls nobody else; its runs run here.
 */
const HOME_AGENT_KEY = "homeAgent";
/** Set while the home agent is on with a trigger: only then can its alarms have gone missing (#reconcileHome). */
const HOME_RUNS_KEY = "homeRuns";
/** A run's reads reuse results this young: a run wants today's numbers, and its items often read the same. */
const RUN_STALE_MS = 60_000;
/** Who a run's tell step names for its owner's own conversation. */
const OWNER_TARGETS = new Set(["owner", "me", "you", "home", "chat"]);

/** The newest transcript entries, read at most once per message (see #recentEntries). */
type RecentEntries = () => Promise<readonly EntryRecord[] | undefined>;
/** A message about to start a run, as the skill classifier reads it, and the end of the conversation before it. */
interface SkillsFor {
  text: string;
  recent: RecentEntries;
}

/** Which entries of a conversation to read, as Conversation.entries takes it. */
type EntryQuery = Parameters<Conversation["entries"]>[0];

/** A conversation's entries `query` matches, a page of `size` at a time: at most `max` pages. */
async function* entryPages(
  conversation: Pick<Conversation, "entries">,
  query: EntryQuery,
  size: number,
  max = Infinity,
): AsyncGenerator<readonly EntryRecord[]> {
  let cursor: Cursor | undefined;
  for (let n = 0; n < max; n++) {
    const page = await conversation.entries(query, size, cursor, BACKGROUND_CONTEXT);
    yield page.items;
    if (!(cursor = page.next)) return;
  }
}

/** Whether `entry` is the input of the run step `operationId` (see RunStepData). */
function isRunStep(entry: EntryRecord, operationId: string): boolean {
  return entry.kind === RUN_STEP_KIND && (entry.data as RunStepData | undefined)?.op === operationId;
}

export { chatAgentName };

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
  /** Keeps the chat's Claude prompt cache from expiring between its calls (cache-warmer.ts). */
  readonly warmer = new CacheWarmer();
  readonly ai = gatewayAI(this.env, this.gemini, this.warmer);
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      // The chat's model may be one a provider listed: have the list before pi looks the model up.
      await this.#catalog();
      const models = this.#models();
      // A failed run goes on to the messages queued behind it: in a shared chat they are other people's, and would
      // otherwise wait, shown as queued, until someone writes again. Compaction is set here, where the app reads it too:
      // at most CONTEXT_BUDGET tokens, however large the model's window. pi reads the settings at each use, so a model a
      // provider lists later is held to the budget too.
      const settings = () => ({
        afterFailedRun: "continue" as const,
        progress: PROGRESS,
        compaction: { ...COMPACTION, modelOverrides: compactionOverrides(models.getModels()) },
      });
      const pi = await Harness.open(storage, { models, registry: this.registry, onWake, settings }, context);
      try {
        // A new chat starts on its user's last pick, else on Auto (startingSetting); PiHarness then finds the root and
        // leaves it as it is.
        if (!(await pi.conversation(ROOT_CONVERSATION_ID, context))) {
          const setting = startingSetting(await this.#savedModel(), this.env.ROUTER_MODEL);
          if (isAuto(setting)) this.ctx.storage.kv.put(AUTO_KEY, true);
          else if (setting) await pi.root(context, { agent: this.#agentChange(setting) });
        }
      } catch (error) {
        await pi.close(context).catch(() => {});
        throw error;
      }
      return pi;
    },
    // What a chat runs on until someone picks a model, or Auto picks one for it.
    defaults: this.#defaults(defaultModelChoice(this.env.MODEL, this.env.THINKING_LEVEL)),
  });
  readonly members = new ChatMembers(this.ctx.storage.sql);
  /** The chat's kind, the page it discusses and the chat it branched off from (worker/chat-kind.ts). */
  readonly kinds = new ChatKindState(this.ctx.storage.kv, () => this.members.hasAny());
  /** The chat's agents besides pi, each in a session of its own, and their turns (worker/agents/). */
  readonly roster = new ChatRoster(this.ctx.storage.sql);
  readonly turns = new AgentTurns(this.#turnHost());
  readonly reactions = new ChatReactions(this.ctx.storage.sql);
  readonly sockets = new ChatSockets({
    events: () => this.harness.session().events(),
    runStartedAt: (snapshot) => this.runStartedAt(snapshot),
    toolsStartedAt: (snapshot) => this.toolsStartedAt(snapshot),
    admit: (person) => this.admit(person),
    peopleFor: (uid) => this.peopleFor(uid),
    queued: (ids) => this.queued(ids),
    incoming: () => this.incoming(),
    prompt: (text, author, attachments, mentions, replyTo) => this.prompt(text, author, attachments, mentions, replyTo),
    abort: (by, agent) => this.abort(by, agent),
    agents: () => this.agentViews(),
    runningAgents: () => this.roster.runningSessions(),
    agentEvents: (session) => this.harness.session(session).events(),
    turnInputId: (session, turn) => this.#turnInputId(session, turn),
    setModel: (input, by) => this.setModel(input, by),
    auto: () => this.#auto(),
    reactions: () => this.reactions.all(),
    react: (by, entry, emoji, on) => this.react(by, entry, emoji, on),
  });
  /** The runs of the agent whose home this chat is, its schedules and watches (worker/agents/runs/). */
  readonly runs = new AgentRuns(this.ctx.storage.sql);
  readonly runner = new AgentRunner(this.#runnerHost(), this.ctx.storage.sql);
  /** Shares the object's alarm with pi: runs at local times, watches on intervals. */
  readonly scheduler = new Scheduler({
    callbacks: {
      run: (payload: RunAlarm) => this.#onAlarm(() => this.runner.fired(payload)),
      watch: (payload: WatchAlarm) => this.#onAlarm(() => this.runner.watchTick(payload)),
    },
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness).use(this.sockets).use(this.scheduler);

  readonly scope: ChatScope;
  readonly #manifests = new Map<string, ArtifactManifest>();
  /** The headless browser the agent checks its pages in. */
  readonly #checkBrowser = new CheckBrowser(this.env.BROWSER);
  /**
   * The servers whose tools the agent has now (`key`), so a refresh reinstalls only on a change, what mcp_discover
   * says about them, and which listing they came from (`generation`): a listing started later has lists at least as new, so one that
   * finishes after it (a refresh racing a discovery, two discoveries) does not install over it. `deferred`: whether the
   * tools are deferred, for the tool picker to pick from.
   */
  #mcp = { key: "", listing: "", generation: 0, deferred: false };
  /** Each MCP agent tool's server, and whether it only reads: what an agent's turn is limited by. */
  #mcpTools: ReadonlyMap<string, McpToolInfo> = new Map();
  #mcpListings = 0;
  /** The fingerprint of the skills the agent has now, so a refresh reinstalls them only on a change. */
  #skillsInstalled: string | undefined;
  /** The user's skills as last listed, and their version, so a refresh lists them again only on a change. */
  #skillsListed: { version: string; skills: SkillInfo[] } | undefined;
  /** The classifier that picks the skills shown (SKILLS_MODEL); null when it names none, so every skill is shown. */
  #skillClassifier: SkillClassifier | null | undefined;
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
  /** The sidebars hear the chat's kind in order (#tellKind): a later kind must not land before an earlier one. */
  #kindWrites: Promise<unknown> = Promise.resolve();
  /** The last read of the queue, by the inbox ids it was for: every socket asks after the same commit. */
  #queuedRead: { key: string; read: Promise<QueuedMessage[]> } | undefined;
  /** What the transcript names, and how far each of pi's sessions was read for it (see #transcriptTraces). */
  #seen: { through: Map<string, number>; traces: ChatTraces } = { through: new Map(), traces: chatTraces([]) };
  /** Set while a broadcast of the agents' view waits for the current task to end (#broadcastAgents). */
  #agentsChanged = false;
  /** The asking line the skill classifier last read for an agent's turn (#skillsForTurn). */
  #skillsAsked: string | undefined;
  /** See #oneShotModels. */
  #oneShot: Models | undefined;
  /** What tells whether an aside is meant for the agent (CALL_HINT_MODEL); undefined when hints are off. */
  readonly #hinter: CallHinter | undefined = callHinter(this.env.AI as unknown as ModelRunner, this.env.CALL_HINT_MODEL);
  /** See #place. */
  #placing: Promise<void> = Promise.resolve();
  /** The deployment's tool picker (TOOL_PICK_MODEL); undefined: every MCP tool is offered with every message. */
  readonly #toolPicker = toolPicker(this.env.TOOL_PICK_MODEL);
  /** tool_search, which loads a deferred MCP tool the picker left out: installed while the MCP tools are deferred. */
  readonly #toolSearch = createToolSearchExtension();
  /** See incoming. In memory: a restart ends the prompts getting them ready too. */
  readonly #incoming = new Map<string, IncomingMessage>();
  /** The last message's sentAt (see prompt). */
  #lastSentAt = 0;
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
      onPublished: async (artifact) => {
        await this.#directory.recordArtifact({ ...artifact, chatId: this.chatId });
        // Off the publish's path: the chat that discusses the page hears of its new version.
        void this.#tellPageChat(artifact).catch((error: unknown) => console.error("page chat:", errorMessage(error)));
      },
      broughtIn: (id) => this.#broughtIn().includes(id),
      proposeSkill: (skill) => this.#directory.saveSkill(skill, "agent", false),
      proposeAgent: (input) => this.#directory.saveAgent(input, "agent", false),
      checkPage: (input, signal) =>
        this.#checkBrowser.withPage((page) => checkPage(page, input, this.#checkBridge(input.manifest)), { timeoutMs: CHECK_MS, signal }),
      chatArtifacts: () => this.#directory.listChatArtifacts(this.chatId),
      drafts: memoAsync(() => this.storage.chatDrafts(this.uid, this.chatId)),
      skillSets: (names) => this.#skillSets(names),
      readSkillFile: (skill, set, path) => this.#readSkillSetFile(skill, set, path),
      skillFolders: (names, maxBytes) => this.#skillFolders(names, maxBytes),
      look: lookFrom(env.CHECK_LOOK_MODEL, env.AI),
      review: () => this.#pageReviewer(),
      publishUnchecked: env.AUTH_MODE === "demo",
      failedChecks: new FailedChecks(),
      react: (emoji) => this.#agentReact(emoji),
    });
    this.registry.install(promptExtension);
    this.registry.install(
      peopleExtension(
        () => this.people(),
        () => this.roster.list().filter((entry) => !entry.off),
      ),
    );
    this.registry.install(artifactExtension(scope));
    this.registry.install(filesExtension(scope));
    this.registry.install(skillsExtension(scope));
    this.registry.install(reactionsExtension(scope));
    this.registry.install(agentsExtension(scope));
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
    if (this.#gone) return;
    // The agents' turns that were running, or waiting, go on: cheap when there are none. So do runs cut off.
    this.turns.resume();
    this.runner.resume();
    this.#reconcileHome();
    // An answer pi gave before the restart may not have been read for the agents it names, even once its run ended.
    this.#scanPi();
    // The sidebars show the chat working: the object restarted mid-run. Follow the run it resumes, or tell them it is over.
    if (this.#status() !== "running") return;
    void this.refreshMcpTools();
    void this.refreshSkills();
    void this.refreshFiles();
    void this.#watchRuns().catch((error: unknown) => console.error("chat status:", errorMessage(error)));
  }

  /** The models a chat can pick, as AI Gateway's providers last listed them. */
  #catalog(): Promise<Catalog> {
    return loadCatalog(catalogSource(this.env, this.storage.models, (promise) => this.ctx.waitUntil(promise)));
  }

  /** The user's last pick, checked again: the list of models can change. Null when there is none, or on a failure. */
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
   * Auto's pick for a message about to start a run: the deployment's router (ROUTER_MODEL: of those the picker lists,
   * the first to pick) reads the end of the conversation and the message (and how many images and other files it attaches),
   * and picks one of AUTO_MODELS and an effort. The router call counts in pi's ledger like any model call. While a
   * reply is running (as pi's own queue says: the sidebars' status lags behind it) the router is not asked. Undefined
   * only when the conversation could not be read. Never throws: when no router picks in time (ROUTE_MS), or one picks a
   * model the picker does not list, the chat keeps its model, and the pick says why. `recent`: the newest entries
   * (#recentEntries, read once), which the skill classifier and the tool picker read too.
   */
  async #route(message: string, images: number, files: number, recent: RecentEntries): Promise<Routing | undefined> {
    const started = Date.now();
    const kept = (failed: string, more?: Pick<AutoPick, "running" | "missed">): Routing => ({ kept: { failed, ...more, ms: Date.now() - started } });
    let read;
    try {
      const [root, catalog, busy] = await Promise.all([this.#root(), this.#catalog(), this.#replying()]);
      if (busy) return kept(RUNNING_WHEN_SENT, { running: true });
      const [agent, items] = await Promise.all([root.agent(BACKGROUND_CONTEXT), recent()]);
      if (!items) return undefined;
      read = { root, catalog, agent, items };
    } catch (error) {
      console.error("auto:", errorMessage(error));
      return undefined;
    }
    const { root, catalog, agent, items } = read;
    const tokens = contextTokens(items);
    try {
      const candidates = autoCandidates(catalog.models, this.env.AUTO_MODELS as AutoCandidate[], { images: images > 0, contextTokens: tokens });
      const request = { message, history: routeHistory(items), images, files, contextTokens: tokens, current: this.#modelOf(agent), candidates };
      const gateway = catalogSource(this.env, this.storage.models);
      const routed = await route(routersFrom(this.env.ROUTER_MODEL, catalog, { models: this.#oneShotModels, gateway, ai: this.env.AI }), request);
      // Paid for whether or not the pick is used. Only a record: a failure is logged.
      await root
        .commit((tx) => recordSpend(tx, root.id, `${AUTO_LEDGER_PREFIX}${routed.router.model}`, routed.usage), BACKGROUND_CONTEXT)
        .catch((error: unknown) => console.error("auto spend:", errorMessage(error)));
      // An effort the model does not take moves to the nearest it does; none named asks for its usual one.
      const choice = catalog.check({ model: routed.pick.model, thinkingLevel: routed.pick.thinkingLevel });
      if (!choice) {
        return kept(`the router picked ${routed.pick.model}, which is not in the picker`, { ...(routed.missed && { missed: routed.missed }) });
      }
      const pick: AutoPick = {
        ...choice,
        ...(routed.pick.reason && { reason: routed.pick.reason }),
        router: routed.router,
        ...(routed.missed && { missed: routed.missed }),
        ms: Date.now() - started,
      };
      return { pick, choice };
    } catch (error) {
      console.error("auto:", errorMessage(error));
      return kept(`no router could pick: ${errorMessage(error)}`);
    }
  }

  /**
   * Run the chat on Auto's pick, unless a reply is running by now (someone else's message started one while the router
   * thought): the message then goes to it on the model it runs on, as does one the router did not pick for. The pick as
   * it stands, against the model the chat runs on now: another message may have changed it since the router was asked.
   * Called only inside #place, so no other message changes the model between this and its message going in.
   */
  async #applyPick(routed: Routing | undefined, now: () => Promise<ChatNow>): Promise<AutoPick | undefined> {
    if (!routed) return undefined;
    const { root, busy, agent } = await now();
    const current = this.#modelOf(agent);
    if ("kept" in routed || busy) {
      // A reply started meanwhile: the pick goes unused, but what failed on the way to it still shows.
      const kept =
        "kept" in routed
          ? routed.kept
          : { failed: RUNNING_WHEN_PICKED, running: true as const, ...(routed.pick.missed && { missed: routed.pick.missed }), ms: routed.pick.ms };
      return { model: current, thinkingLevel: agent.thinkingLevel, ...kept };
    }
    if (current !== routed.choice.model || agent.thinkingLevel !== routed.choice.thinkingLevel) {
      await root.configure(this.#agentChange(routed.choice), BACKGROUND_CONTEXT);
    }
    return routed.pick;
  }

  /** Whether a reply is running or a message waits for one, by pi's own queue. */
  async #replying(): Promise<boolean> {
    return (await (await this.harness.pi()).inspect(BACKGROUND_CONTEXT)).submissions.length > 0;
  }

  /** The picker's id of the model `agent` runs on. */
  #modelOf(agent: Pick<AgentState, "model">): string {
    return agent.model ? modelKey(agent.model.provider, agent.model.modelId) : this.env.MODEL;
  }

  /**
   * Apply a message's picks (Auto's model, the tool picker's tools) and put the message in, one message at a time: two
   * picked at once would each change the model or the tools before either went in, and the run would start on the last
   * one's picks while the first one's say others.
   */
  #place(place: () => Promise<void>): Promise<void> {
    const placed = this.#placing.then(place);
    this.#placing = placed.catch(() => {});
    return placed;
  }

  /** Whether a reply is running, and the agent as it stands: what #applyPick and #applyTools go by, read once. */
  async #now(): Promise<ChatNow> {
    const root = await this.#root();
    const [busy, agent] = await Promise.all([this.#replying(), root.agent(BACKGROUND_CONTEXT)]);
    return { root, busy, agent };
  }

  /**
   * The tool picker's pick for a message about to start a run: the few MCP tools it needs, out of the conversation's
   * deferred ones. The call counts in pi's ledger like any model call. Undefined when no tool is deferred (no picker, or
   * too few tools to pick). Never throws: when the picker fails or takes longer than TOOL_PICK_MS, the note says why,
   * and every tool is offered (#applyTools). `recent`: the newest entries (#recentEntries, read once).
   */
  async #pickTools(message: string, recent: RecentEntries): Promise<ToolPickNote | undefined> {
    const picker = this.#toolPicker;
    if (!picker) return undefined;
    const started = Date.now();
    let tools: PickableTool[] = [];
    try {
      const root = await this.#root();
      tools = deferredTools(await root.agent(BACKGROUND_CONTEXT));
      if (!tools.length) return undefined;
      const history = routeHistory((await recent()) ?? []);
      const asked = Date.now();
      const picked = await pickTools(this.env.AI, picker, { message, history, tools }, AbortSignal.timeout(TOOL_PICK_MS));
      const id = pickerId(picker);
      // Paid for whether or not the pick is used. Only a record, off the prompt's path: a failure is logged.
      void root
        .commit((tx) => recordSpend(tx, root.id, `${TOOL_PICK_LEDGER_PREFIX}${id}`, picked.usage), BACKGROUND_CONTEXT)
        .catch((error: unknown) => console.error("tool pick spend:", errorMessage(error)));
      return { tools: picked.tools, of: tools.length, picker: routerSpend(id, picked.usage, Date.now() - asked), ms: Date.now() - started };
    } catch (error) {
      console.error("tool pick:", errorMessage(error));
      return tools.length ? { tools: [], of: tools.length, failed: pickFailure(error), ms: Date.now() - started } : undefined;
    }
  }

  /**
   * Offer the model the tools `note` picked, from the message's run on, by the conversation's `modelTools` (which loads
   * deferred tools); every MCP tool when the pick failed. While a reply is running, the picks are added to the tools it
   * has, never taking one away from it. Called only inside #place. Never throws: on a failure the model keeps the tools
   * it has, and can load others with tool_search. Returns the note as it went: `added` when a reply was running.
   */
  async #applyTools(note: ToolPickNote | undefined, now: () => Promise<ChatNow>): Promise<ToolPickNote | undefined> {
    if (!note) return undefined;
    try {
      const { root, busy, agent } = await now();
      const deferred = deferredTools(agent);
      const wanted = note.failed ? deferred.map((tool) => tool.name) : note.tools;
      const offered = agent.tools.filter((tool) => tool.deferred).map((tool) => tool.name);
      const tools = toolsToOffer(deferred, wanted, offered, busy);
      if (tools) await root.configure({ modelTools: { add: tools } }, BACKGROUND_CONTEXT);
      return busy && note.tools.length ? { ...note, added: true } : note;
    } catch (error) {
      console.error("tool pick:", errorMessage(error));
      return { ...note, failed: pickFailure(error), unchanged: true };
    }
  }

  /** pi-ai's models for the chat's calls outside its runs (Auto's router, the chat's title): made once. */
  get #oneShotModels(): Models {
    return (this.#oneShot ??= this.#models());
  }

  /** pi-ai's models as the chat calls them: a model that cannot be called is marked for every chat (markFailing), so Auto leaves it out. */
  #models(): Models {
    const source = catalogSource(this.env, this.storage.models);
    return withFailuresReported(piModels(this.ai.provider, this.gemini), (id, error) => this.ctx.waitUntil(markFailing(source, id, error)));
  }

  /** The chat's one conversation. PiHarness has made it by the time pi() resolves. */
  async #root() {
    return (await this.harness.pi()).root(BACKGROUND_CONTEXT);
  }

  /** The chat's log (the root conversation) entries `query` matches, a page at a time. */
  async *#log(query: EntryQuery, size = 100, max?: number): AsyncGenerator<readonly EntryRecord[]> {
    yield* entryPages(await this.#root(), query, size, max);
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
  #notePeople({ uid, name }: Person, event: ChatPeopleData["event"], agent?: string, by?: string): void {
    this.#notice({ kind: CHAT_PEOPLE_KIND, data: { uid, name, event, ...(agent && { agent }), ...(by && { by }) } satisfies ChatPeopleData });
  }

  /** A display-only notice in the transcript (see #notePeople), which everyone sees at once. Only a notice: a failure is logged. */
  #notice(entry: { kind: string; data: JsonObject }): void {
    void this.#root()
      .then((root) => root.submit({ type: "write", entry }, BACKGROUND_CONTEXT))
      .catch((error: unknown) => console.error("chat notice:", errorMessage(error)));
  }

  /** What the agent reads that the app does not show (CHAT_CONTEXT_KIND): a passive write, placed at its next step. */
  async #contextWrite(about: "page" | "branch", text: string): Promise<void> {
    const message: UserMessage = { role: "user", content: text, timestamp: Date.now() };
    const root = await this.#root();
    await root.submit({ type: "write", entry: { kind: CHAT_CONTEXT_KIND, data: { about }, model: [message] } }, BACKGROUND_CONTEXT);
  }

  /**
   * Install the user's enabled skills, built-in and their own. Runs before every
   * prompt, so a skill added, changed or turned off in any chat applies from the
   * next message on. With SKILLS_MODEL set, the agent is shown only the skills
   * picked for this chat: given the `message` about to start a run, the
   * classifier is first asked which of the skills not shown yet it needs (see
   * worker/agent/skill-pick.ts). Never rejects: a failure is logged, and the agent
   * keeps the skills it has.
   */
  // One at a time, so an older refresh never installs over a newer one.
  readonly refreshSkills = serial((message?: SkillsFor) => this.#refreshSkills(message));

  async #refreshSkills(message: SkillsFor | undefined): Promise<void> {
    try {
      const directory = this.#directory;
      const version = await directory.skillsVersion();
      if (this.#skillsListed?.version !== version) this.#skillsListed = { version, skills: await directory.listSkills() };
      const listed = this.#skillsListed.skills;
      const classifier = this.#skillPicker();
      let shown: Set<string> | undefined;
      if (classifier) {
        const saved = this.ctx.storage.kv.get<string[]>(SHOWN_SKILLS_KEY);
        // A chat the agent answered before its skills were picked (or a run resumed with none saved) was shown every
        // enabled skill: it keeps them, so its list only grows. A chat the agent has not answered yet starts with none.
        const answered = saved === undefined && (!message || ((await message.recent())?.some(({ kind }) => kind === "pi.assistant") ?? true));
        shown = new Set(answered ? listed.filter(isActive).map(({ name }) => name) : (saved ?? []));
        const waiting = listed.filter((skill) => isActive(skill) && !shown!.has(skill.name));
        if (message && waiting.length) for (const name of await this.#pickSkills(classifier, message.text, message.recent, waiting)) shown.add(name);
        // Not into a chat deleted meanwhile.
        if ((saved === undefined || (message && waiting.length)) && !this.#gone) this.ctx.storage.kv.put(SHOWN_SKILLS_KEY, [...shown]);
      }
      const source = skillSource(listed, version, shown, {
        read: (skill, path) => this.#readSkillFile(skill, path),
        sandbox: this.env.SANDBOX_ENABLED === "true",
      });
      if (source.fingerprint === this.#skillsInstalled) return;
      this.registry.install(await skills([source]));
      this.#skillsInstalled = source.fingerprint;
    } catch (error) {
      console.error("skills:", errorMessage(error));
    }
  }

  /** The classifier SKILLS_MODEL names, made once; undefined when it names none (said once, when it names something else). */
  #skillPicker(): SkillClassifier | undefined {
    if (this.#skillClassifier === undefined) {
      this.#skillClassifier = skillClassifier(this.env.SKILLS_MODEL, this.env.AI) ?? null;
      if (!this.#skillClassifier && this.env.SKILLS_MODEL.trim()) console.error(`skills: SKILLS_MODEL names no System One model: ${this.env.SKILLS_MODEL}`);
    }
    return this.#skillClassifier ?? undefined;
  }

  /**
   * The code review of pages before they are published: by the first of REVIEW_MODEL's models this deployment can run
   * that answers, its calls counted in pi's ledger under REVIEW_LEDGER_PREFIX and that model's id. Undefined when it
   * names none: pages then go unreviewed. Never throws.
   */
  async #pageReviewer(): Promise<PageReviewer | undefined> {
    if (!this.env.REVIEW_MODEL.trim()) return undefined;
    let candidates: Model<Api>[];
    try {
      candidates = modelsNamed(this.env.REVIEW_MODEL, await this.#catalog());
    } catch (error) {
      console.error("page review:", errorMessage(error));
      return undefined;
    }
    if (!candidates.length) {
      console.error(`page review: REVIEW_MODEL names no model this deployment can run: ${this.env.REVIEW_MODEL}`);
      return undefined;
    }
    const review = modelReviewer(this.#oneShotModels, candidates);
    const spent = (usage: Usage, by: string | undefined) => {
      if (usage.totalTokens === 0 && usage.cost.total === 0) return;
      // A review that failed, or was stopped, after a billed attempt counts under the first model asked.
      const model = by ?? modelKey(candidates[0].provider, candidates[0].id);
      void this.#root()
        .then((root) => root.commit((tx) => recordSpend(tx, root.id, `${REVIEW_LEDGER_PREFIX}${model}`, usage), BACKGROUND_CONTEXT))
        .catch((error: unknown) => console.error("page review spend:", errorMessage(error)));
    };
    return async (html, signal) => {
      try {
        const reviewed = await review(html, signal);
        spent(reviewed.usage, reviewed.by);
        return reviewed;
      } catch (error) {
        if (error instanceof ReviewStopped) spent(error.usage, undefined);
        throw error;
      }
    };
  }

  /**
   * Which of `waiting` (skills not shown yet) `message` needs, as `classifier` says with the end of the conversation
   * (`recent`), and any it could not answer for. Its calls count in pi's ledger, off the prompt's path. Never throws.
   */
  async #pickSkills(classifier: SkillClassifier, message: string, recent: RecentEntries, waiting: readonly SkillChoice[]): Promise<string[]> {
    const history = routeHistory((await recent()) ?? []);
    const pick = await classifier.pick({ message, history, skills: waiting });
    if (pick.errors.length) console.error("skills pick:", pick.errors.join("; "));
    if (pick.usage.totalTokens > 0 || pick.usage.cost.total > 0) {
      void this.#root()
        .then((root) => root.commit((tx) => recordSpend(tx, root.id, `${SKILLS_LEDGER_PREFIX}${classifier.id}`, pick.usage), BACKGROUND_CONTEXT))
        .catch((error: unknown) => console.error("skills spend:", errorMessage(error)));
    }
    return pick.add;
  }

  /**
   * The newest ROUTE_ENTRIES transcript entries, newest first: what Auto's router and the skill classifier read of the
   * conversation before a message starts a run, read once for both, and only when one asks. Undefined when they could not
   * be read.
   */
  async #recentEntries(): Promise<readonly EntryRecord[] | undefined> {
    try {
      return (await (await this.#root()).entries({}, ROUTE_ENTRIES, undefined, BACKGROUND_CONTEXT)).items;
    } catch (error) {
      console.error("recent entries:", errorMessage(error));
      return undefined;
    }
  }

  /** The owner's skill files, encrypted with their key: deriving it is not free, so once per object. */
  readonly #skillFiles = memoAsync(() => this.storage.skillFiles(this.uid));
  /** Skill files read lately, by skill, set and path: a set never changes, so a write, its check and its publish read a file once. */
  readonly #skillFileCache = new Map<string, Uint8Array>();
  #skillFileCacheSize = 0;

  /** A file of one of the owner's skills, from the set its last import wrote; null when it has none by that path. */
  #readSkillFile(skill: SkillInfo, path: string): Promise<Uint8Array | null> {
    if (!skill.fileSet || !skill.files?.some((file) => file.path === path)) return Promise.resolve(null);
    return this.#readSkillSetFile(skill.name, skill.fileSet, path);
  }

  async #readSkillSetFile(skill: string, set: string, path: string): Promise<Uint8Array | null> {
    const key = `${skill}/${set}/${path}`;
    const cached = this.#skillFileCache.get(key);
    if (cached !== undefined) return cached;
    const bytes = await (await this.#skillFiles()).read(skill, set, path);
    if (bytes === null) return null;
    if (this.#skillFileCacheSize + bytes.byteLength > SKILL_FILE_CACHE_BYTES) {
      this.#skillFileCache.clear();
      this.#skillFileCacheSize = 0;
    }
    this.#skillFileCache.set(key, bytes);
    this.#skillFileCacheSize += bytes.byteLength;
    return bytes;
  }

  /**
   * The folders of the owner's skills named, for the sandbox (ChatScope.skillFolders): SKILL.md (as the skill is now)
   * and every file. Refused before anything is read when they hold more than `maxBytes`. Read past the cache: a whole
   * folder would push out the files pages use.
   */
  async #skillFolders(names: readonly string[], maxBytes: number): Promise<SandboxFile[]> {
    const unique = [...new Set(names)];
    const skills = await this.#skillsWithFiles(unique);
    const missing = unique.filter((name) => !skills.some((skill) => skill.name === name));
    if (missing.length) throw new Error(`No skill of the user's that is on and has files: ${missing.join(", ")}.`);
    // Each SKILL.md counts too: what the run's own files may take is what these leave.
    const markdowns = skills.map((skill) => new TextEncoder().encode(formatSkillFile(skill)));
    const bytes = skills.reduce((sum, { files }, i) => sum + markdowns[i].byteLength + files.reduce((total, file) => total + file.size, 0), 0);
    if (bytes > maxBytes) throw new Error(`Those skills hold ${formatBytes(bytes)}; one run takes at most ${formatBytes(maxBytes)} with its files.`);
    const store = await this.#skillFiles();
    const folders = await Promise.all(
      skills.map(async (skill, s) => {
        const read = await store.readAll(skill.name, skill.fileSet, skill.files.map((file) => file.path));
        const lost = skill.files.find((_, i) => !read[i]);
        if (lost) throw new Error(`The skill "${skill.name}" lost its file ${lost.path}: import it again.`);
        // SkillFiles.read gives each file a buffer of its own, so it goes as it is.
        const folder = skill.files.map((file, i) => ({ name: `${skill.name}/${file.path}`, bytes: read[i]!.buffer as ArrayBuffer }));
        return [{ name: `${skill.name}/SKILL.md`, bytes: markdowns[s].buffer as ArrayBuffer }, ...folder];
      }),
    );
    return folders.flat();
  }

  /** The file sets of the owner's own skills named that are on and have files (PublishScope.skillSets). */
  async #skillSets(names: readonly string[]): Promise<Map<string, { set: string; files: SkillFileInfo[] }>> {
    return new Map((await this.#skillsWithFiles(names)).map((skill) => [skill.name, { set: skill.fileSet, files: skill.files }]));
  }

  /** Those of the owner's own skills named that are on and have files. */
  async #skillsWithFiles(names: readonly string[]): Promise<(SkillInfo & { fileSet: string; files: SkillFileInfo[] })[]> {
    const skills = await Promise.all(names.map((name) => this.#directory.getSkill(name)));
    return skills.flatMap((skill) => (skill?.enabled && skill.fileSet && skill.files ? [{ ...skill, fileSet: skill.fileSet, files: skill.files }] : []));
  }

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
    // With a tool picker and enough tools, they are deferred: each message is offered the few the picker picks for it.
    const deferred = this.#toolPicker !== undefined && [...catalog.values()].reduce((n, { tools }) => n + tools.length, 0) > MIN_TOOLS_TO_PICK;
    // Everything the extension is built from: a server's new tool list, or a new reason it is unavailable, reinstalls it.
    const installed = JSON.stringify([deferred, [...catalog], [...unavailable]]);
    if (installed !== this.#mcp.key) {
      const { extension, listing, toolInfo } = mcpExtension(this.hub, catalog, unavailable, () => this.discoverMcp(), { deferred });
      this.registry.install(extension);
      this.#mcpTools = toolInfo;
      if (deferred) this.registry.install(this.#toolSearch);
      else this.registry.uninstall(this.#toolSearch);
      const deferring = deferred && !this.#mcp.deferred;
      this.#mcp = { key: installed, listing, generation, deferred };
      // Deferred from now on (enough tools came, or the object just started): every one is offered until a message's
      // pick narrows them, so a running reply (one that just called mcp_discover) keeps the tools it was using.
      if (deferring) await this.#offerAllTools(extension);
    } else this.#mcp.generation = generation;
    return this.#mcp.listing;
  }

  /** Offer the model every deferred tool of `extension`, as without the tool picker. A failure is logged. */
  async #offerAllTools(extension: Extension): Promise<void> {
    try {
      const tools = (extension.tools ?? []).filter((tool) => tool.deferred);
      await (await this.#root()).configure({ modelTools: { add: tools } }, BACKGROUND_CONTEXT);
    } catch (error) {
      console.error("tool pick:", errorMessage(error));
    }
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
    return this.ctx.storage.kv.get<string[]>(BROUGHT_IN_KEY) ?? [];
  }

  #bringIn(ids: readonly string[]): void {
    if (!ids.length) return;
    const kept = [...this.#broughtIn().filter((id) => !ids.includes(id)), ...ids].slice(-MAX_BROUGHT_IN);
    this.ctx.storage.kv.put(BROUGHT_IN_KEY, kept);
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
      this.#meetOnce();
      return true;
    }
    if (this.members.has(person.uid)) {
      this.members.rename(person);
      this.#tellSharedOnce();
      this.#meetOnce();
      this.#tellKind(person.uid);
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
    const page = this.kinds.page();
    return { ...this.people(), ...(uid === this.uid && { invites: this.members.invites() }), kind: this.kinds.kind(), ...(page && { page }) };
  }

  /** The chat's kind (shared/chat-kinds.ts): what other stores ask before taking anything out of it, with mayLeave. */
  chatKind(): ChatKind {
    return this.kinds.kind();
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
   *
   * Getting it ready (its files, the agent's tools, on Auto the model) can take seconds: everyone sees it as incoming
   * meanwhile (#announce), until it is in.
   */
  async prompt(
    text: string,
    author: Person,
    attachments: readonly AttachmentInput[] = [],
    mentionInputs: readonly MentionInput[] = [],
    replyTo?: number,
  ): Promise<void> {
    // When it came in: the refreshes and copies below can take seconds. Never the same as another's, which would make
    // two messages of one person, sent in the same millisecond, one incoming message (incomingKey).
    const sentAt = (this.#lastSentAt = Math.max(Date.now(), this.#lastSentAt + 1));
    let placed = false;
    try {
      placed = await this.#prompt(text, author, attachments, mentionInputs, replyTo, sentAt);
    } finally {
      const key = incomingKey({ uid: author.uid, sentAt });
      if (this.#incoming.delete(key)) this.sockets.broadcast({ type: "incoming", incoming: this.incoming(), ...(placed && { placed: key }) });
    }
  }

  /** The messages the chat is getting ready to put in, oldest first (see IncomingMessage). */
  incoming(): IncomingMessage[] {
    return [...this.#incoming.values()];
  }

  /** Show everyone `message` as incoming. */
  #announce(message: IncomingMessage): void {
    this.#incoming.set(incomingKey(message), message);
    this.sockets.broadcast({ type: "incoming", incoming: this.incoming() });
  }

  /** Show everyone the incoming message `key` no longer waits for Auto's router, while it is still incoming. */
  #picked(key: string): void {
    const message = this.#incoming.get(key);
    if (!message?.picking) return;
    const { picking: _, ...rest } = message;
    this.#announce(rest);
  }

  /** See prompt. Whether the message went in: not when nothing was left of it. */
  async #prompt(
    text: string,
    author: Person,
    attachments: readonly AttachmentInput[],
    mentionInputs: readonly MentionInput[],
    replyTo: number | undefined,
    sentAt: number,
  ): Promise<boolean> {
    this.#requireInChat(author);
    const shared = this.members.hasAny();
    // In a private chat its agent answers every message; in any other only those that call it (shared/chat-kinds.ts).
    const everyMessage = answersEveryMessage(this.kinds.kind());
    const replied = replyTo === undefined ? undefined : await this.#entryAt(replyTo);
    const quote = replyQuote(replied);
    // A reply to pi calls it too, as a follow-up to what it said; a reply to another agent calls that agent. Told for
    // sure once the mentions are known.
    const repliesToAgent = quote !== null && "agent" in quote && !quote.agentId;
    // The agents of the roster it calls ("@research"), who take turns of their own (worker/agents/). A message that
    // calls only them is not pi's to answer, even in a chat nobody shares. Told for sure once the mentions are known.
    const repliesTo = quote && "agent" in quote ? quote.agentId : undefined;
    // In an agent's home conversation, a message that calls nobody else is the agent's, not pi's: while the chat's kind
    // answers every message. With members in it, only a summons or a reply runs an agent, as in any other chat.
    const home = everyMessage ? this.#homeSpeaker() : undefined;
    const speakersOf = (named: readonly Mention[] = []) => {
      const called = speakersFor(text, this.roster.list(), repliesTo, named);
      if (!called.length && home !== undefined && !summonsAgent(text, named) && !repliesToAgent) called.push(home);
      return called;
    };
    // With files, artifacts or people named, their "@name"s may hide what looks like a call now: pi may be summoned after all.
    const callsAgents = mentionInputs.length === 0 && speakersOf().length > 0;
    const calling = (everyMessage && !callsAgents) || repliesToAgent || summonsAgent(text);
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
    // What the router, the skill classifier and the tool picker read of the conversation: read once for all, and only if one asks.
    const recent = calling ? memoAsync(() => this.#recentEntries()) : undefined;
    // A new chat is put on Auto as it opens (startingSetting), which its first message may come before: wait for that.
    const onAuto = recent && (this.#auto() || ((await this.harness.pi()) && this.#auto()));
    const routing = onAuto ? this.#route(text, images, attachments.length + own.length - images, recent) : undefined;
    this.#announce({
      uid: author.uid,
      name: author.name,
      text,
      sentAt,
      // What it attaches as far as it is known yet: names, and thumbnails of images.
      ...(attachments.length && { attachments: attachments.map(({ path, thumb }) => ({ path, ...(thumb && { thumb }) })) }),
      ...(quote && { replyTo: quote }),
      ...(routing && { picking: true }),
    });
    // What the skill classifier reads: the text, and the names of the files attached (a file alone can need a skill).
    const attachedPaths = [...attachments, ...own].map(({ path }) => path);
    const skillText = skillMessage(text, attachedPaths);
    // Picked (or not): the rest may still take a while, and should not say the router is still at it.
    void routing?.then(() => this.#picked(incomingKey({ uid: author.uid, sentAt })));
    // The tool picker reads the tools the refresh installs, while the rest gets ready. Used only if the message is a prompt.
    const tooling = recent
      ? this.refreshMcpTools()
          .catch(() => {})
          .then(() => this.#pickTools(text, recent))
      : undefined;
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
      tooling,
      recent && this.refreshSkills({ text: skillText, recent }),
      calling && this.refreshFiles(),
      calling && this.refreshUserPrompt(),
    ]);
    // The files they named of their own are named too: "@pi notes.md" is not a call.
    const named = [...mentions, ...own];
    const speakers = speakersOf(named);
    const summoned = (everyMessage && !speakers.length) || repliesToAgent || summonsAgent(text, named);
    // Again after the refreshes, which can take seconds: the author may have been removed meanwhile.
    this.#requireInChat(author);
    // Nothing left to say: every attachment was one they may not attach.
    if (!text && !attached) return false;
    this.#bringIn(broughtIn);
    const written = [quote && replyLine(quote), text, note].filter(Boolean).join("\n\n");
    const said = shared ? `${author.name}: ${written}` : written;
    const content = attached ? [...attached.content, ...(written ? [{ type: "text" as const, text: said }] : [])] : said;
    const dataWith = (auto?: AutoPick, tools?: ToolPickNote) =>
      ({
        uid: author.uid,
        name: author.name,
        text,
        ...(attached && { attachments: attached.attachments }),
        ...(mentions.length && { mentions }),
        ...(quote && { replyTo: quote }),
        sentAt,
        ...(auto && { auto }),
        ...(tools && { tools }),
      }) satisfies ChatMessageData;
    const summon = (data: ReturnType<typeof dataWith>) =>
      this.#summon(content, !everyMessage || speakers.length ? ({ ...data, summoned: true } satisfies ChatMessageData) : data);
    // The model and the tools change before the message goes in, so the run it starts is on the picks.
    if (summoned) {
      await this.#place(async () => {
        const now = memoAsync(() => this.#now());
        const auto = routing && (await this.#applyPick(await routing, now));
        await summon(dataWith(auto, await this.#applyTools(await tooling, now)));
      });
    } else {
      const aside = await this.#aside(content, dataWith());
      // Meant for the agent, though it did not call it? Its author may be offered to (#hintCall). Off the prompt's path.
      // Not while the agent works: it reads the message at its next step. The classifier reads whom it replies to too.
      const hinter = this.#hinter;
      if (hinter && !speakers.length && this.#status() !== "running" && worthAsking(text)) {
        const asked = [quote && replyLine(quote), text].filter(Boolean).join("\n\n");
        void this.#hintCall(hinter, aside, author, asked).catch((error) => console.error("call hint:", errorMessage(error)));
      }
    }
    // The agents it calls take their turns, each in its own session; the turn's input carries the message. The owner's
    // reply to a run's report continues that run, in a fork of its session, for the agent that posted it.
    if (speakers.length) {
      const files = attachedNote(attached?.attachments.map((attachment) => attachment.path) ?? []);
      // Only the owner's: the run's session holds what it read with the owner's sign-ins. Anyone else's reply goes to
      // the agent's session here, which has the report only.
      const continued =
        byOwner && repliesTo && speakers.includes(repliesTo) ? await this.#continuedRun(replied).catch(() => undefined) : undefined;
      const caller = {
        calledBy: { name: author.name, uid: author.uid },
        // The catch-up leaves the message out (askKey), so the input carries all of it a hand-off would.
        ask: `${askOf({ name: author.name, kind: "person", owner: byOwner }, written, MAX_ASK_CHARS)}${files}`,
        askKey: messageAskKey({ uid: author.uid, sentAt }),
        byOwner,
      };
      const others = continued ? speakers.filter((id) => id !== continued.agentId) : speakers;
      // One message, one chain: the other agents' turns share the continued one's, so MAX_HOPS holds for all of them.
      const [first] = continued ? this.turns.call([continued.agentId], { ...caller, session: continued.session, run: continued.run }) : [];
      if (others.length) this.turns.call(others, { ...caller, ...(first && { root: first.root }) });
    }
    // The sidebars are only a convenience: update them off the prompt's path, and let a failure be.
    // Only a tag whose "@name" is in the text: one sent without it would notify someone of nothing they can see.
    const tags = taggedPeople(keptMentions(text, mentions));
    void this.#touchIndexes(title, author, tags, text).catch((error) => console.error("chat index:", errorMessage(error)));
    return true;
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
  async #aside(content: UserMessage["content"], data: JsonObject): Promise<Submission> {
    const root = await this.#root();
    const written = await root.submit({ type: "write", entry: { kind: CHAT_MESSAGE_KIND, data: { ...data, aside: true } } }, BACKGROUND_CONTEXT);
    const message: UserMessage = { role: "user", content, timestamp: Date.now() };
    await root.submit({ type: "write", entry: { kind: CHAT_ASIDE_KIND, model: [message] } }, BACKGROUND_CONTEXT);
    return written;
  }

  /**
   * An aside someone wrote (`written`, its `chat.message`) that may still be meant for the agent ("pi, can you…"): the
   * deployment's CALL_HINT_MODEL reads it with the end of the conversation, and when it is likely enough
   * (HINT_THRESHOLD) for the agent, its author's windows are told, and show them Ask pi under it. The call counts in
   * pi's ledger like the router's. Nothing on a failure or past HINT_MS.
   */
  async #hintCall(hinter: CallHinter, written: Submission, author: Person, text: string): Promise<void> {
    const root = await this.#root();
    const placed = await written.wait(BACKGROUND_CONTEXT);
    if (placed.status !== "done") return;
    const entry = placed.entry;
    // What came before it, newest first: not what followed it meanwhile.
    const page = await root.entries({ maxEntryId: (entry - 1) as EntryId }, ROUTE_ENTRIES, undefined, BACKGROUND_CONTEXT);
    const request = {
      author: author.name,
      message: text,
      people: everyone(this.people()).map((person) => person.name),
      history: routeHistory(page.items),
    };
    const { probability, usage } = await hinter.ask(request, AbortSignal.timeout(HINT_MS));
    // Paid for whatever it said. Only a record: a failure is logged.
    if (usage) {
      await root
        .commit((tx) => recordSpend(tx, root.id, `${HINT_LEDGER_PREFIX}${hinter.id}`, usage), BACKGROUND_CONTEXT)
        .catch((error: unknown) => console.error("call hint spend:", errorMessage(error)));
    }
    if (probability >= HINT_THRESHOLD) this.sockets.sendTo(author.uid, { type: "callHint", entry });
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
        // pi answered: the agents its answer names get turns.
        if (this.#runWatch === watch && batch.some((event) => event.type === "run_end")) this.#scanPi();
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
      settleLogged("chat status", indexes.map((index) => index.setChatStatus(this.chatId, this.uid, status, replied))),
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
      if (person.uid !== this.uid) await this.#index(person.uid).addSharedChat(this.#sharedRow(title));
      this.#notePeople(person, "rejoined");
      return null;
    }
    const refused = await this.members.check(secret, person);
    if (refused) return refuse(403, refused.error);
    // Used by someone else meanwhile, the entry goes again. Should that fail too, admit removes it.
    const failed = await this.#seat(person.uid, title, async () => {
      const used = await this.members.accept(secret, person);
      return used && refuse(403, used.error);
    });
    if (failed) return failed;
    // An invite is how someone who left, or was removed, comes back.
    this.kinds.letBackIn(person.uid);
    this.#joined(person);
    return null;
  }

  /**
   * Give someone joining the chat its sidebar row first (a member without one could not reach the chat), then their
   * seat with `take`, which checks again what may have changed during the await; the row goes again if it refuses.
   */
  async #seat(uid: string, title: string, take: () => ChatRefusal | null | Promise<ChatRefusal | null>): Promise<ChatRefusal | null> {
    const index = this.#index(uid);
    await index.addSharedChat(this.#sharedRow(title, kindAfterJoin(this.kinds.kind())));
    const refused = await take();
    if (refused) await index.removeSharedChat(this.chatId, this.uid).catch(() => {});
    return refused;
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
    const full = this.members.add(seat, "seat");
    if (full) return refuse(409, full.error);
    this.#joined(seat);
    return null;
  }

  /** A sidebar row for this chat in a member's directory, under `title`, of `kind` (the chat's own by default). */
  #sharedRow(title: string, kind = this.kinds.kind()) {
    return { id: this.chatId, ownerUid: this.uid, ownerName: this.members.ownerName(this.uid), title, status: this.#status(), kind };
  }

  /**
   * Someone new is in the chat: everyone's app and the transcript hear it, and the owner's sidebar that it is shared.
   * A private chat with someone in it is a group from now on: its agents answer only when called. `by`: the owner added
   * them directly (addMember).
   */
  #joined(person: Person, by?: Person): void {
    // A chat that never stored its kind was a group before only if someone else was in it already. The owner's second
    // seat is the owner: it changes nothing.
    const stored = this.kinds.stored();
    const before = stored ?? legacyKind(this.members.list().some((member) => member.uid !== person.uid && !isSecondSeatUid(member.uid)));
    const after = isSecondSeatUid(person.uid) ? before : kindAfterJoin(before);
    if (after !== stored) this.kinds.setKind(after);
    this.sockets.broadcastPeople();
    if (by) this.#notePeople(person, "added", undefined, by.name);
    else this.#notePeople(person, "joined");
    if (after !== before) this.#notice({ kind: CHAT_EVENT_KIND, data: { event: "kind", kind: after, from: before, auto: true } satisfies ChatEventData });
    // The newcomer's row was written before the kind could have changed: they hear it as it is now, whatever happened.
    if (after !== stored) this.#tellKind();
    else this.#tellKind(person.uid);
    this.#tellShared();
    this.#meet([person]);
  }

  /**
   * Tell every sidebar that lists the chat (or only `uid`'s) its kind, as the chat has it when the write goes: one
   * after another, so the last says how things stand. Only a view: a failure is logged, and a member's sidebar hears it
   * again when they next open the chat (admit).
   */
  #tellKind(uid?: string): void {
    this.#kindWrites = this.#kindWrites.then(() => {
      const kind = this.kinds.kind();
      const indexes = uid === undefined ? this.#everyonesIndexes() : this.#hasSidebar(uid) ? [this.#index(uid)] : [];
      return settleLogged("chat kind", indexes.map((index) => index.setChatKind(this.chatId, this.uid, kind)));
    });
  }

  /**
   * The people in the chat now share it with `newcomers` (all of them: everyone): each one's sidebar remembers the
   * others, whom "@" then offers to add to their other chats (ChatRows.knowPeople). Second seats are the owner. Only a view.
   */
  #meet(newcomers: readonly Person[]): void {
    // Someone in only because they opened the page met nobody: they could otherwise add its people to their own chats.
    const fromPage = new Set(this.members.listVia().filter((member) => member.via === "page").map((member) => member.uid));
    const everybody = everyone(this.people()).filter((person) => this.#hasSidebar(person.uid) && !fromPage.has(person.uid));
    const fresh = new Set(newcomers.map((person) => person.uid));
    const writes = everybody.map((person) =>
      this.#index(person.uid).knowPeople(this.chatId, fresh.has(person.uid) ? everybody : everybody.filter((other) => fresh.has(other.uid))),
    );
    void settleLogged("chat people", writes);
  }

  /** For a chat shared before sidebars remembered people: everyone meets everyone, once. */
  #meetOnce(): void {
    if (this.ctx.storage.kv.get(PEOPLE_TOLD_KEY) || !this.members.hasAny()) return;
    this.ctx.storage.kv.put(PEOPLE_TOLD_KEY, true);
    this.#meet(everyone(this.people()));
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
    if (!this.members.has(uid)) return refuse(404, "No such member.");
    const left = by.uid === uid;
    // Only the owner's removal keeps them out: someone who left, or lost access by a change of kind, may come back.
    if (!left) this.kinds.shutOut(uid);
    await this.#drop([uid], left ? "left" : "removed");
    return null;
  }

  /**
   * Take members out of the chat: their open sockets close at once, their waiting requests are withdrawn, and the chat
   * leaves their sidebars. Nobody knows anybody through it any more (ChatRows.knowPeople). Those the owner removed come
   * back only by an invite (removeMember, ChatKinds.shutOut).
   */
  async #drop(uids: readonly string[], event: "left" | "removed", notice = true): Promise<void> {
    const gone = uids.map((uid) => this.members.remove(uid)).filter((member) => member !== undefined);
    if (!gone.length) return;
    for (const member of gone) {
      this.sockets.disconnect(member.uid);
      if (notice) this.#notePeople(member, event);
    }
    const staying = everyone(this.people()).filter((person) => this.#hasSidebar(person.uid));
    void settleLogged(
      "chat people",
      staying.flatMap((person) => gone.map((member) => this.#index(person.uid).forgetPerson(this.chatId, member.uid))),
    );
    this.sockets.broadcastPeople();
    this.#tellShared();
    // The agent acts as the owner: a removed person's queued requests must not run after they are out.
    await Promise.all(
      gone.map(async (member) => {
        await this.#withdrawQueued(member.uid).catch((error: unknown) => console.error("withdraw queued:", errorMessage(error)));
        await this.turns.leave(member.uid);
      }),
    );
    await Promise.all(gone.filter((member) => this.#hasSidebar(member.uid)).map((member) => this.#index(member.uid).removeSharedChat(this.chatId, this.uid)));
  }

  /**
   * The owner adds someone they share another chat with (their directory knows them: ChatRows.knowPeople) directly,
   * with no invite: they see the whole conversation, and hear of it in their sidebar as a tag. Adding someone to a
   * private chat makes it a group.
   */
  async addMember(by: Person, uid: unknown): Promise<ChatPeopleView | ChatRefusal> {
    if (by.uid !== this.uid) return refuse(403, "Only the chat's owner can add people.");
    if (this.#gone) return refuse(404, DELETED);
    if (typeof uid !== "string" || uid === this.uid || isSecondSeatUid(uid)) return refuse(400, "Pick someone to add.");
    if (this.members.has(uid)) return this.peopleFor(by.uid);
    if (this.kinds.isShutOut(uid)) return refuse(403, "You removed them from this chat: only an invite link brings them back.");
    const person = await this.#directory.knownPerson(uid);
    if (!person) return refuse(404, "You can add only people you share another chat with. Send anyone else an invite link.");
    const title = (await this.#directory.chatTitle(this.chatId)) ?? "";
    // They may have come in by a link meanwhile: then nobody adds them, and nobody hears it twice.
    let added = false;
    const failed = await this.#seat(uid, title, () => {
      if (this.members.has(uid)) return null;
      const full = this.members.add(person, "added");
      added = !full;
      return full && refuse(409, full.error);
    });
    if (failed) return failed;
    if (!added) return this.peopleFor(by.uid);
    this.members.setOwnerName(by);
    this.#joined(person, by);
    const tag: Tag = { from: by.name, text: "added you to this chat", at: Date.now(), added: true };
    void this.#index(uid).touchSharedChat(this.chatId, this.uid, title, true, tag).catch((error: unknown) => console.error("chat added:", errorMessage(error)));
    return this.peopleFor(by.uid);
  }

  /** Who would lose access if the chat became `kind`, for the owner to confirm (changeKind). */
  kindPreview(by: Person, kind: unknown): { loses: Person[] } | ChatRefusal {
    if (by.uid !== this.uid) return refuse(403, "Only the chat's owner can change what kind of chat it is.");
    if (!isChatKind(kind)) return refuse(400, "Not a kind of chat.");
    return { loses: losesAccess(kind, this.members.listVia()).map(personOf) };
  }

  /**
   * The owner makes the chat `kind`. Narrowing removes those it shuts out, in the same request, but only if they are
   * exactly the ones the owner was shown (`confirmed`, uids from kindPreview); otherwise nothing changes, and the
   * refusal carries the new list. The chat's own kind changes first: it is what the stores check with every write, so a
   * chat made off the record lets nothing out from then on, even while the sidebars hear of it.
   */
  async changeKind(by: Person, kind: unknown, confirmed: unknown): Promise<ChatPeopleView | (ChatRefusal & { loses?: Person[] })> {
    if (by.uid !== this.uid) return refuse(403, "Only the chat's owner can change what kind of chat it is.");
    if (this.#gone) return refuse(404, DELETED);
    const asked = Array.isArray(confirmed) ? confirmed.filter((uid): uid is string => typeof uid === "string") : [];
    const from = this.kinds.kind();
    const plan = planKindChange(from, kind, this.members.listVia(), asked, this.kinds.page() !== undefined);
    if ("error" in plan) return { ...refuse(plan.status, plan.error), ...(plan.loses && { loses: plan.loses.map(personOf) }) };
    const to = kind as ChatKind;
    if (to === from) return this.peopleFor(by.uid);
    this.kinds.setKind(to);
    // "Only you": a link sent before must not let anyone in, which would make it a group again (#joined).
    if (to === "private") this.members.revokeInvites();
    const removed = plan.removed.map(personOf);
    // Told with the change itself, before any await: changes made one after another are told in their order.
    this.#notice({ kind: CHAT_EVENT_KIND, data: { event: "kind", kind: to, from, by: personOf(by), ...(removed.length && { removed }) } satisfies ChatEventData });
    this.#tellKind();
    try {
      await this.#drop(
        removed.map((member) => member.uid),
        "removed",
        false,
      );
    } finally {
      this.sockets.broadcastPeople();
    }
    return this.peopleFor(by.uid);
  }

  /**
   * Make this new chat the one that discusses the owner's artifact `page` (Discuss on its page): anyone who can open
   * the page may join it. The agent may read the page (as if named with "@"), and is told which page it is.
   */
  async startPage(by: Person, page: ChatPage): Promise<ChatRefusal | null> {
    if (by.uid !== this.uid) return refuse(403, "Only the page's author can start its chat.");
    if (this.#gone) return refuse(404, DELETED);
    this.members.setOwnerName(by);
    this.kinds.setKind("page");
    this.kinds.setPage(page);
    this.#bringIn([page.id]);
    await this.#contextWrite("page", pageNote(page, "discusses"));
    return null;
  }

  /**
   * Someone who opened the page this chat discusses joins it (Discuss). Opening the page is all it takes, so the Worker
   * checked only that they may open it; the chat checks it is still on that page.
   */
  async joinPage(person: Person, artifactId: string, title: string): Promise<ChatRefusal | null> {
    if (this.#gone) return refuse(404, DELETED);
    const page = this.kinds.page();
    if (this.kinds.kind() !== "page" || page?.id !== artifactId) return refuse(403, PAGE_CLOSED);
    if (this.isInChat(person.uid)) {
      if (person.uid !== this.uid) await this.#index(person.uid).addSharedChat(this.#sharedRow(title));
      return null;
    }
    if (this.kinds.isShutOut(person.uid)) return refuse(403, "The chat's owner removed you from it.");
    let added = false;
    const failed = await this.#seat(person.uid, title, () => {
      // The owner may have changed the kind meanwhile, or another window of theirs joined first.
      if (this.kinds.kind() !== "page") return refuse(403, PAGE_CLOSED);
      if (this.members.has(person.uid)) return null;
      const full = this.members.add(person, "page");
      added = !full;
      return full && refuse(409, full.error);
    });
    if (failed) return failed;
    if (added) this.#joined(person);
    return null;
  }

  /** The page this chat discusses has a new version: everyone sees a line, and the agent is told, as a passive write. */
  async pageVersion(page: ChatPage): Promise<void> {
    if (this.#gone || this.kinds.page()?.id !== page.id) return;
    this.kinds.setPage(page);
    this.#notice({ kind: CHAT_EVENT_KIND, data: { event: "page", page } satisfies ChatEventData });
    await this.#contextWrite("page", pageNote(page, "has a new version"));
    this.sockets.broadcastPeople();
  }

  /** Tell the chat that discusses a page this chat just published a version of, if there is one. Only a notice. */
  async #tellPageChat(artifact: Omit<ArtifactSummary, "chatId">): Promise<void> {
    const chatId = await this.#directory.pageChat(artifact.id);
    if (!chatId || chatId === this.chatId) return;
    await exports.ChatAgent.getByName(chatAgentName(this.uid, chatId)).pageVersion({ id: artifact.id, title: artifact.title, version: artifact.latest });
  }

  /**
   * Branch off a new chat from transcript entry `entry`, for the owner or someone they let in (not by the page): it
   * carries the conversation up to there (copied into its log, and read by its agents from one passive write), keeps
   * this chat off the record if it is, and links back here; this chat shows a line that the branch exists. The branch
   * is the owner's, as this one is, with the one who branched it off in it, and nobody else. A conversation has at most
   * MAX_BRANCHES, counted against its first chat in the owner's directory.
   */
  async branchOff(by: Person, entry: unknown): Promise<{ chatId: string } | ChatRefusal> {
    const refused = this.#mayBranch(by);
    if (refused) return refused;
    const at = await this.#entryAt(entry);
    if (!at) return refuse(404, "No such message in this chat.");
    const root = this.kinds.branchedFrom()?.root ?? this.chatId;
    // Counted before the awaits below, so branches started at once cannot pass the limit together.
    if (!(await this.#directory.takeBranch(root, MAX_BRANCHES))) return refuse(409, `This conversation has ${MAX_BRANCHES} branches, the most there can be.`);
    const chatId = newId();
    const branch = exports.ChatAgent.getByName(chatAgentName(this.uid, chatId));
    const owner = { uid: this.uid, name: this.members.ownerName(this.uid) };
    let started = false;
    try {
      const pages: EntryRecord[][] = [];
      for await (const page of this.#log({ maxEntryId: at.id }, 200, MAX_BRANCH_PAGES)) pages.push([...page]);
      const entries = pages.flat().reverse();
      const title = (await this.#directory.chatTitle(this.chatId)) ?? "";
      const summarize = (older: string) => summaryFor(this.#oneShotModels, this.ai(this.env.TITLE_MODEL), older);
      const context = await branchContext(entries, this.uid, title, summarize);
      // After the awaits: the chat may be gone, the one branching out of it, or its kind changed. What the branch is
      // made of is read here, in one step.
      const now = this.#mayBranch(by);
      if (now) {
        await this.#directory.returnBranch(root);
        return now;
      }
      // The owner's second seat is the owner: their branch is theirs alone.
      const asOwner = by.uid === this.uid || isSecondSeatUid(by.uid);
      const member = asOwner ? undefined : this.members.listVia().find((other) => other.uid === by.uid);
      const kind = branchKind(this.kinds.kind(), member !== undefined);
      const page = this.kinds.knownPage();
      const from: BranchedFrom = { chatId: this.chatId, title, entry: at.id as number, root };
      const branchTitle = branchTitleOf(title);
      // What the branch is goes in first: listed and filled, it is already of its kind.
      started = true;
      await branch.startBranch({ owner, from, kind, ...(page && { page }) });
      await this.#directory.createChat(chatId, { title: branchTitle, kind });
      const copies = branchCopies(entries, owner);
      for (let i = 0; i < copies.length; i += BRANCH_COPY_BATCH) await branch.copyIntoBranch(copies.slice(i, i + BRANCH_COPY_BATCH));
      await branch.finishBranch({ by, title: branchTitle, context, ...(member && { member }) });
      this.#notice({ kind: CHAT_EVENT_KIND, data: { event: "branch", chatId, title: branchTitle, entry: from.entry, by: personOf(by) } satisfies ChatEventData });
      return { chatId };
    } catch (error) {
      // A half-made branch goes, and its place with it (deleting a branch frees its place).
      if (!started) await this.#directory.returnBranch(root).catch(() => {});
      else {
        await branch
          .deleteChat(owner, { files: [] })
          .then(() => this.#directory.forgetChat(chatId))
          // A reset ends the call that asked for it: it always fails (chat-routes.ts does the same).
          .then(() => branch.resetDeleted().catch(() => {}))
          .catch((cleanup: unknown) => console.error("branch cleanup:", errorMessage(cleanup)));
      }
      throw error;
    }
  }

  /** Why `by` may not branch the chat off now, if they may not: only its owner and those they let in (not by the page). */
  #mayBranch(by: Person): ChatRefusal | null {
    if (this.#gone) return refuse(404, DELETED);
    if (!this.isInChat(by.uid)) return refuse(403, "You are not in this chat.");
    const via = this.members.listVia().find((member) => member.uid === by.uid)?.via;
    if (via === "page") return refuse(403, "Only the chat's owner and the people they invited can branch it off.");
    return null;
  }

  /** In a new branch (branchOff), before anything else: what it is, where it came from, and the page it knows of. */
  startBranch(made: { owner: Person; from: BranchedFrom; kind: ChatKind; page?: ChatPage }): void {
    this.members.setOwnerName(made.owner);
    this.kinds.setKind(made.kind);
    this.kinds.setBranchedFrom(made.from, true);
    if (made.page) {
      // Not on the page: the page's chat is the one its author started. Its agents know of it, and may read it.
      this.kinds.setContextPage(made.page);
      this.#bringIn([made.page.id]);
    }
  }

  /** In a new branch (branchOff): put entries copied from the chat it branched off from into its log, as they were. */
  async copyIntoBranch(copies: readonly { kind: string; data: JsonObject }[]): Promise<void> {
    const root = await this.#root();
    for (const copy of copies) await root.submit({ type: "write", entry: copy }, BACKGROUND_CONTEXT);
  }

  /**
   * End a new branch: the one who branched it off in it (`member`, unless the owner did), with it in their sidebar,
   * the line that links back, and what its agents read of the conversation it carries (and of the page it knows of).
   */
  async finishBranch(made: { by: Person; title: string; member?: ChatMemberVia; context: string }): Promise<void> {
    if (made.member) {
      const { via, ...person } = made.member;
      this.members.add(person, via === "invite" ? "added" : via);
      if (this.#hasSidebar(person.uid)) await this.#index(person.uid).addSharedChat(this.#sharedRow(made.title));
      this.#tellShared();
      this.#meet([person]);
    }
    const from = this.kinds.branchedFrom()!;
    this.#notice({ kind: CHAT_EVENT_KIND, data: { event: "branched", from, by: personOf(made.by) } satisfies ChatEventData });
    await this.#contextWrite("branch", made.context);
    const page = this.kinds.knownPage();
    if (page) await this.#contextWrite("page", pageNote(page, "came from"));
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
      await Promise.all([this.harness.abort(), this.turns.stop()]).catch((error: unknown) => console.error("delete, abort:", errorMessage(error)));
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
      await this.runner.clearAll();
      // A branch's place among its conversation's MAX_BRANCHES is free again (an imported one took none).
      const root = this.kinds.countedRoot();
      await this.lifecycle.disableAlarms();
      await this.lifecycle.dispose();
      disposed = true;
      await this.ctx.storage.deleteAll();
      this.ctx.storage.kv.put(GONE_KEY, true);
      if (root) await this.#directory.returnBranch(root).catch((error: unknown) => console.error("branch count:", errorMessage(error)));
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
   * One part of the chat's own storage, for its owner's export (worker/chat-dump.ts): its conversation, reactions and
   * settings, from `cursor` on. Read in one go, so a part is as the chat stood at that moment.
   */
  exportPart(cursor?: ChatDumpCursor): ChatDumpPage | ChatRefusal {
    if (this.#gone) return refuse(404, DELETED);
    if (this.ctx.storage.kv.get(IMPORTING_KEY) !== undefined) return refuse(409, "This chat is still being imported.");
    return dumpChat(this.ctx.storage.sql, this.ctx.storage.kv, EXPORTED_KV, cursor);
  }

  /**
   * Start filling this chat from an export: only one that has no conversation here (a chat deleted here may be imported
   * again). Its owner's list does not show it until importFinish, so nobody can open it meanwhile, and nothing runs in it.
   * An import that stopped part way starts again from nothing.
   */
  importBegin(start: ChatImportStart): ChatRefusal | null {
    const { sql, kv } = this.ctx.storage;
    // An imported chat whose listing failed after importFinish (the Worker refuses one its owner's list has) starts again too.
    const resuming = kv.get(IMPORTING_KEY) !== undefined || kv.get(IMPORTED_KEY) === true;
    if (!resuming && !this.#deleted() && hasConversation(sql)) return refuse(409, "This chat already has a conversation here.");
    this.ctx.storage.transactionSync(() => {
      clearImported(sql, kv, EXPORTED_KV);
      kv.delete(GONE_KEY);
      kv.put(IMPORTING_KEY, start);
    });
    this.#gone = false;
    return null;
  }

  /** Store one part of the chat's export, its ids changed as importBegin was told, all of it or none. */
  importPart(part: ChatDumpPart): ChatRefusal | null {
    const start = this.ctx.storage.kv.get<ChatImportStart>(IMPORTING_KEY);
    if (!start) return refuse(409, "This chat's import has not begun.");
    const remap = idRemapper([
      [start.from, this.uid],
      [secondSeatUid(start.from), secondSeatUid(this.uid)],
      ...Object.entries(start.artifacts),
      ...Object.entries(start.agents ?? {}),
    ]);
    try {
      this.ctx.storage.transactionSync(() => restorePart(this.ctx.storage.sql, this.ctx.storage.kv, EXPORTED_KV, part, remap));
    } catch (error) {
      if (error instanceof DumpError) return refuse(400, error.message);
      throw error;
    }
    return null;
  }

  /** The import has stored every part: the chat opens as it was, with nobody in it but its owner. */
  async importFinish(): Promise<ChatRefusal | { kind: ChatKind }> {
    const kv = this.ctx.storage.kv;
    if (kv.get(IMPORTING_KEY) === undefined) return refuse(409, "This chat's import has not begun.");
    const kind = this.kinds.imported();
    // The chat's system prompt came as the zip had it: keep it only within what a saved one may be.
    const prompt = readSystemPrompt(kv);
    if (prompt && "error" in saveSystemPrompt(kv, prompt)) kv.delete(SYSTEM_PROMPT_KEY);
    const start = kv.get<ChatImportStart>(IMPORTING_KEY)!;
    const { agents, through } = this.ctx.storage.transactionSync(() => importedRoster(this.ctx.storage.sql, this.uid, Object.values(start.agents ?? {})));
    // pi's answers from before the import start no hand-offs (see #piScan).
    if (agents.length) kv.put(PI_SCAN_KEY, { through } satisfies PiScan);
    kv.delete(IMPORTING_KEY);
    kv.put(IMPORTED_KEY, true);
    await Promise.all(agents.map((agentId) => this.#noteAgentChat(agentId, true)));
    return { kind };
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
   * What the transcript names (chatTraces), in every one of pi's sessions (the chat's, and each agent's, whose tool
   * calls publish and save for the chat as pi's do), read on from where the last read stopped: entries never change once
   * written, so a chat's files are known without reading its whole history on every request.
   */
  readonly #transcriptTraces = singleFlight(async (): Promise<ChatTraces> => {
    const seen = this.#seen;
    for (const { id } of await this.harness.sessions.list()) {
      const query = { order: "ascending", minEntryId: ((seen.through.get(id) ?? -1) + 1) as EntryId } as const;
      for await (const page of entryPages(await this.harness.conversation(id), query, 500)) {
        chatTraces(page, seen.traces);
        const last = page.at(-1);
        if (last) seen.through.set(id, last.id as number);
      }
    }
    return seen.traces;
  });

  /**
   * Publish without the model, the way the agent does (write, check, publish), the browser check included: a page with
   * errors throws the check's errors. Only routed when DEV_TOOLS is on.
   */
  async devPublish({ html, mcp, ...target }: PublishTarget & { html: string; mcp?: WriteInput["mcp"] }) {
    const { id } = await writeDraft(this.scope, { html, mcp });
    // Without the code review: a model's findings would make this publish fail at random.
    const { report, unchecked } = await checkDraft(this.scope, id, { review: false });
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
    // Newest first, past the run's own tool calls and results; not an aside, which can be written while the agent works.
    for await (const page of this.#log({ order: "descending" }, 50, 10)) {
      const found = page.find((entry) => entry.kind === CHAT_MESSAGE_KIND && !(entry.data as Partial<ChatMessageData> | undefined)?.aside);
      if (found) {
        this.#setReaction(found.id as number, emoji, AGENT_REACTOR, true);
        return (found.data as Partial<ChatMessageData> | undefined)?.name ?? "someone";
      }
    }
    return null;
  }

  /** Set a reaction, and tell every socket the entry's reactions when that changed them. */
  #setReaction(entry: number, emoji: Reaction, who: string, on: boolean): void {
    if (this.reactions.set(entry, emoji, who, on)) this.sockets.broadcast({ type: "reacted", entry, reactions: this.reactions.of(entry) });
  }

  /** What everyone's app shows of the chat's agents besides pi. */
  agentViews(): ChatAgentView[] {
    return this.roster.views((uid) => this.#nameOf(uid));
  }

  /** The name to show for someone in the chat, owner or member; their uid when they are neither. */
  #nameOf(uid: string): string {
    return everyone(this.people()).find((person) => person.uid === uid)?.name ?? uid;
  }

  /** Tell everyone's app the agents' view, once for the changes one task makes. */
  #broadcastAgents(): void {
    if (this.#agentsChanged) return;
    this.#agentsChanged = true;
    queueMicrotask(() => {
      this.#agentsChanged = false;
      this.sockets.broadcast({ type: "agents", agents: this.agentViews() });
      // A turn started or ended: every socket follows the agents working now, and lets go of the others.
      this.sockets.followAgents();
    });
  }

  /**
   * The owner brings one of their agents into the chat: it gets a pi session of its own, configured at its first turn.
   * Only an agent that is on. Adding one already here changes nothing.
   */
  async addAgent(by: Person, agentId: unknown): Promise<ChatAgentView[] | ChatRefusal> {
    if (by.uid !== this.uid) return refuse(403, "Only the chat's owner can add agents to it.");
    if (this.#gone) return refuse(404, DELETED);
    if (typeof agentId !== "string" || !AGENT_ID_PATTERN.test(agentId)) return refuse(400, "Expected {agentId}.");
    if (this.roster.get(agentId)) return this.agentViews();
    const agent = await this.#directory.getAgent(agentId);
    if (!agent) return refuse(404, "No such agent.");
    if (!agent.enabled) return refuse(409, `@${agent.name} is off: turn it on first.`);
    const refused = await this.#addToRoster(agent);
    if (refused) return refuse(409, refused.error);
    this.#notePeople(by, "agent-added", agent.name);
    await this.#noteAgentChat(agentId, true);
    return this.agentViews();
  }

  /** Tell the owner's directory which chats an agent is in ("used in M chats"). Only an index: a failure is logged. */
  async #noteAgentChat(agentId: string, inChat: boolean, shared = false): Promise<void> {
    await this.#directory.noteAgentChat(agentId, this.chatId, inChat, shared).catch((error: unknown) => console.error("agent index:", errorMessage(error)));
  }

  /** The owner takes an agent out of the chat: its turns stop, and its past replies stay in the log. */
  async removeAgent(by: Person, agentId: string): Promise<ChatAgentView[] | ChatRefusal> {
    if (by.uid !== this.uid) return refuse(403, "Only the chat's owner can remove agents from it.");
    const entry = this.roster.get(agentId);
    if (!entry) return refuse(404, "No such agent in this chat.");
    await this.turns.stop(agentId);
    this.roster.remove(agentId);
    this.#broadcastAgents();
    this.#notePeople(by, "agent-removed", entry.name);
    await this.#noteAgentChat(agentId, false);
    return this.agentViews();
  }

  /**
   * The owner deleted one of their agents (the Worker calls this for each chat its index lists): it leaves the roster
   * now, rather than at its next turn, and every open app hears it. Its past replies stay.
   */
  async agentDeleted(agentId: string): Promise<void> {
    if (!this.roster.get(agentId)) return;
    await this.turns.stop(agentId);
    this.roster.remove(agentId);
    this.#broadcastAgents();
  }

  /**
   * (owner) Share an agent of the roster with the people of the chat, or stop: they can then open it read-only and
   * copy it, and it keeps running as its owner.
   */
  async setAgentShared(by: Person, agentId: string, shared: unknown): Promise<ChatAgentView[] | ChatRefusal> {
    if (by.uid !== this.uid) return refuse(403, "Only the chat's owner can share its agents.");
    if (typeof shared !== "boolean") return refuse(400, "Expected {shared: true | false}.");
    if (!this.roster.setShared(agentId, shared)) return refuse(404, "No such agent in this chat.");
    this.#broadcastAgents();
    await this.#noteAgentChat(agentId, true, shared);
    return this.agentViews();
  }

  /**
   * An agent of the roster as someone in the chat may open it: its owner always; anyone else only while the owner
   * shares it. Read from the owner's directory, so it is the definition its next turn runs.
   */
  async sharedAgent(uid: string, agentId: string): Promise<SharedAgentView | ChatRefusal> {
    if (!this.isInChat(uid)) return refuse(403, "You are not in this chat.");
    const entry = this.roster.get(agentId);
    if (!entry) return refuse(404, "No such agent in this chat.");
    if (uid !== entry.ownerUid && !entry.shared) return refuse(403, `@${entry.name}'s owner does not share it in this chat.`);
    const agent = await this.#index(entry.ownerUid).getAgent(agentId);
    if (!agent) return refuse(404, "This agent was deleted.");
    return {
      ...copiedFields(agent),
      id: agent.id,
      avatar: agent.avatar,
      color: agent.color,
      version: agent.version,
      ownerUid: entry.ownerUid,
      ownerName: this.#nameOf(entry.ownerUid),
      turns: this.roster.recentTurns(agentId).map(turnView),
    };
  }

  /** The chat's agents and their latest turns, for someone in it (a runs list). */
  agentsFor(uid: string): ChatAgents | ChatRefusal {
    if (!this.isInChat(uid)) return refuse(403, "You are not in this chat.");
    const agents = this.agentViews();
    return { agents, turns: Object.fromEntries(agents.map((agent) => [agent.id, this.roster.recentTurns(agent.id).map(turnView)])) };
  }

  /** Read pi's new answers for the agents they name (#piScan), off the caller's path. Nothing while the chat has no agents. */
  #scanPi(): void {
    if (this.#gone || !this.roster.hasAny()) return;
    this.ctx.waitUntil(this.#piScan().catch((error: unknown) => console.error("agent hand-offs:", errorMessage(error))));
  }

  /**
   * pi's log, read on from where the last read stopped (PI_SCAN_KEY): the agents of the roster pi's final answers name
   * get turns, within the chain pi's input was in. Its inputs are placed in its log in order, so the latest one read
   * says whose turn its next answer is: a turn another agent handed it (chat.turn, with its chain) or a person's
   * message (a chain of its own). One read at a time; each page's turns and how far it read are written together, so
   * a restart gives none twice.
   */
  readonly #piScan = serial(async (): Promise<void> => {
    const scan = this.ctx.storage.kv.get<PiScan>(PI_SCAN_KEY);
    if (!scan) return;
    let { through, chain } = scan;
    for await (const page of this.#log({ order: "ascending", minEntryId: (through + 1) as EntryId })) {
      for (const entry of page) {
        through = entry.id as number;
        if (entry.kind === CHAT_TURN_KIND) {
          const data = entry.data as Partial<ChatTurnData> | undefined;
          chain = typeof data?.hop === "number" && typeof data.root === "number" ? { hop: data.hop, root: data.root } : undefined;
        } else if (entry.kind === "pi.user" || (entry.kind === CHAT_MESSAGE_KIND && !(entry.data as Partial<ChatMessageData> | undefined)?.aside)) {
          chain = undefined;
        } else if (entry.kind === "pi.assistant") {
          const message = entry.model?.[0];
          if (message?.role === "assistant" && message.stopReason === "stop") this.turns.fromPi(assistantText(message), through, chain);
        }
      }
      if (this.#gone) return;
      this.ctx.storage.kv.put(PI_SCAN_KEY, { through, ...(chain && { chain }) } satisfies PiScan);
    }
  });

  /**
   * What the skill classifier reads for an agent's turn, or one handed to pi: the asking line, with the chat's newest
   * entries. Its pick adds to the chat's list as a person's message does, so the list only grows. Undefined for the
   * same line as the last one (one message calling several agents), which it picked for already.
   */
  #skillsForTurn(ask: string): SkillsFor | undefined {
    if (ask === this.#skillsAsked) return undefined;
    this.#skillsAsked = ask;
    return { text: ask, recent: memoAsync(() => this.#recentEntries()) };
  }

  /** The owner's tools, skills, files and prompt as they are now, before an agent's turn or one handed to pi (`ask`). */
  async #refreshForTurn(ask: string): Promise<void> {
    await Promise.all([this.refreshMcpTools(), this.refreshSkills(this.#skillsForTurn(ask)), this.refreshFiles(), this.refreshUserPrompt()]);
  }

  /** The entry id of turn `turn`'s input in agent session `session`, from the newest entries back; none while it is not placed. */
  async #turnInputId(session: string, turn: number): Promise<number | undefined> {
    const conversation = await this.harness.conversation(session);
    if (!conversation) return undefined;
    for await (const page of entryPages(conversation, { order: "descending" }, 100, 10)) {
      const input = page.find((entry) => isTurnEntry(entry, turn));
      if (input) return input.id as number;
    }
    return undefined;
  }

  /** What the turn controller needs of this chat (worker/agents/controller.ts). */
  #turnHost(): TurnHost {
    // The entries after the turn's input: the input itself is the first of #entriesFrom's.
    const turnEntries = async (session: string, turn: number) => (await this.#entriesFrom(await this.#conversation(session), (entry) => isTurnEntry(entry, turn))).slice(1);
    return {
      roster: this.roster,
      definition: (entry) => this.#index(entry.ownerUid).getAgent(entry.agentId),
      configure: (entry, agent, turn) => this.#configureAgent(entry, agent, turn),
      logSince: (after) => this.#log({ order: "descending", minEntryId: (after + 1) as EntryId }),
      write: async (session, text, requestId) => this.#writeAside(await this.#conversation(session), text, requestId),
      submit: async (session, input, operationId, data) => {
        await this.harness.submit(input, { session, operationId, whenBusy: "followUp", entry: { kind: CHAT_TURN_KIND, data } });
      },
      wait: (session, operationId) => this.harness.wait(operationId, { session }),
      abort: async (session) => {
        await this.harness.abort({ session });
      },
      turnEntries,
      // Request ids, so a reply posted again after a restart is placed once.
      post: (reply) => this.#postAgentReply(reply, `agent-reply:${reply.agentId}:${reply.turn}`),
      tellPi: async (reply) => {
        if (!reply.text) return;
        await this.#writeAside(await this.#root(), askOf({ name: reply.name, kind: "agent" }, reply.text), `agent-aside:${reply.agentId}:${reply.turn}`);
      },
      handToPi: async (input, data) => {
        await this.#watchRuns().catch((error: unknown) => console.error("chat status:", errorMessage(error)));
        await this.#refreshForTurn(input);
        // The handing turn names the input: handed again after a restart, it is placed once. Its entry says which chain
        // pi's answer is in (#piScan).
        try {
          await this.harness.submit(input, { operationId: `pi-turn:${data.turn}`, whenBusy: "followUp", entry: { kind: CHAT_TURN_KIND, data } });
        } catch (error) {
          this.#resumeSettle();
          throw error;
        }
      },
      changed: () => this.#broadcastAgents(),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    };
  }

  /** A session of this chat's pi; throws when it is gone. */
  async #conversation(session: string): Promise<Conversation> {
    const found = await this.harness.conversation(session);
    if (!found) throw new Error(`The session ${session} is gone.`);
    return found;
  }

  /** A passive write into a session: context its next turn reads, with no model call. Placed once per `requestId`. */
  async #writeAside(conversation: Conversation, text: string, requestId: string): Promise<void> {
    const message: UserMessage = { role: "user", content: text, timestamp: Date.now() };
    await conversation.submit({ type: "write", requestId, entry: { kind: CHAT_ASIDE_KIND, model: [message] } }, BACKGROUND_CONTEXT);
  }

  /**
   * An agent's post in this chat's log, placed once per `requestId`, and unread in everyone's sidebar as a person's
   * message is (`tags`: the uids it notifies). The sidebars are only a view: a failure there is logged.
   */
  async #postAgentReply(reply: ChatAgentReplyData, requestId: string, tags: readonly string[] = []): Promise<void> {
    await (await this.#root()).submit({ type: "write", requestId, entry: { kind: CHAT_AGENT_KIND, data: reply } }, BACKGROUND_CONTEXT);
    const author = { uid: `agent:${reply.agentId}`, name: reply.name };
    void this.#touchIndexes(reply.text || reply.name, author, tags, reply.text).catch((error) => console.error("chat index:", errorMessage(error)));
  }

  /** A session's entries from the newest one `first` matches on, oldest first; none when no entry matches. */
  async #entriesFrom(conversation: Conversation, first: (entry: EntryRecord) => boolean): Promise<EntryRecord[]> {
    const found: EntryRecord[] = [];
    for await (const page of entryPages(conversation, { order: "descending" }, 100, 10)) {
      for (const entry of page) {
        found.push(entry);
        if (first(entry)) return found.reverse();
      }
    }
    return [];
  }

  /**
   * Set an agent's session up for a turn: the owner's tools and skills as they are now, its model and effort (the
   * chat's model when it names none), its own instructions, and only the tools this turn may use (allowedTools): the
   * harness offers and runs no other.
   */
  async #configureAgent(entry: RosterEntry, agent: AgentDefinition, turn: AgentTurn): Promise<void> {
    await this.#refreshForTurn(turn.ask);
    const allowed = (installed: readonly string[]) =>
      allowedTools(installed, this.#mcpTools, agent, turn.byOwner, (server) => this.hub.server(server)?.auth === "oauth");
    await this.#configureSession(sessionOf(entry, turn), this.#agentChoice(agent), agentInstructions(agent, this.#nameOf(entry.ownerUid)), allowed);
  }

  /**
   * Set a session up with a model, its instructions and exactly the installed tools `allowed` keeps of them: a tool
   * installed later stays off for it, and the harness offers and runs no other. An agent's turns and runs are few and
   * its own: they get every MCP tool they may use, without the tool picker.
   */
  async #configureSession(
    session: string,
    choosing: Promise<ModelChoice>,
    instructions: string,
    allowed: (installed: readonly string[]) => readonly string[],
  ): Promise<void> {
    const [found, choice] = await Promise.all([this.#conversation(session), choosing]);
    const installed = this.registry
      .snapshot()
      .tools()
      .map(({ tool }) => tool);
    const keep = new Set(allowed(installed.map((tool) => tool.name)));
    const enabled = installed.filter((tool) => keep.has(tool.name));
    const deferred = enabled.filter((tool) => tool.deferred);
    // The page the chat is on (or a branch came from), as it is now: told every turn, as an agent's catch-up may have
    // left out the note about it.
    const page = this.kinds.knownPage();
    const onPage = page ? `\n\n${pageNote(page, this.kinds.page() ? "discusses" : "came from")}` : "";
    await found.configure(
      { ...this.#agentChange(choice), instructions: instructions + onPage, tools: enabled, modelTools: deferred.length ? { add: deferred } : null },
      BACKGROUND_CONTEXT,
    );
  }

  /** The model and effort an agent runs on: its own (or `model`, a work step's), else the chat's, with its effort. */
  async #agentChoice(agent: Pick<AgentDefinition, "model" | "effort">, model = agent.model): Promise<ModelChoice> {
    const [catalog, rootAgent] = await Promise.all([this.#catalog(), this.#root().then((root) => root.agent(BACKGROUND_CONTEXT))]);
    const named = model && checkSetting(catalog, { model, thinkingLevel: agent.effort });
    if (named && !isAuto(named)) return named;
    return (
      catalog.check({ model: this.#modelOf(rootAgent), thinkingLevel: agent.effort ?? rootAgent.thinkingLevel }) ?? {
        model: this.#modelOf(rootAgent),
        thinkingLevel: rootAgent.thinkingLevel,
      }
    );
  }

  // ---- Agents that run on their own (worker/agents/runs/) ----

  /** The agent whose home this chat is, when it is on the roster and on: who answers a message that calls nobody. */
  #homeSpeaker(): string | undefined {
    const id = this.ctx.storage.kv.get<string>(HOME_AGENT_KEY);
    const entry = id === undefined ? null : this.roster.get(id);
    return entry && !entry.off ? entry.agentId : undefined;
  }

  /** Whether this instance checked its home agent's alarms (once per start: an alarm job may have gone with no next). */
  #reconciled = false;

  #reconcileHome(): void {
    const id = this.ctx.storage.kv.get<string>(HOME_AGENT_KEY);
    // Unset in a home made before the key was: checked too, once per start, as reconcile is cheap with a row set.
    if (this.#reconciled || id === undefined || this.ctx.storage.kv.get<boolean>(HOME_RUNS_KEY) === false) return;
    this.#reconciled = true;
    this.ctx.waitUntil(this.runner.reconcile(id).catch((error: unknown) => console.error("agent alarm:", errorMessage(error))));
  }

  /**
   * A scheduler callback: its work goes on detached, so the job queue (pi's own wake jobs, a retry's backoff) is not held
   * while a run takes minutes; runner.resume picks up a run cut off by a restart. A failed run is the run's to record,
   * never a retry of the alarm.
   */
  #onAlarm(work: () => Promise<unknown>): void {
    if (this.#gone) return;
    const detached = work().catch((error: unknown) => console.error("agent run:", errorMessage(error)));
    if (!this.lifecycle.trackAlarmWork(detached)) this.ctx.waitUntil(detached);
  }

  /**
   * The owner's directory tells this chat, the agent's home conversation (where it is on the roster and its runs run),
   * that the agent was saved, turned on or off, or deleted (`agent` null). Its alarms follow the definition; a
   * definition with a trigger and no workflow is compiled to one.
   */
  async agentChanged(agentId: string, agent: AgentDefinition | null): Promise<void> {
    if (this.#gone) return;
    if (agent) {
      this.ctx.storage.kv.put(HOME_AGENT_KEY, agentId);
      this.ctx.storage.kv.put(HOME_RUNS_KEY, Boolean(agent.enabled && agent.trigger));
      if (this.roster.get(agentId)) {
        // Turned on or off, renamed: the roster follows now, so a message that calls nobody goes to it (or to pi) at once.
        const view = { name: agent.name, avatar: agent.avatar, color: agent.color, job: agent.job, off: !agent.enabled };
        if (this.roster.refresh(agentId, view)?.changed) this.#broadcastAgents();
      } else if (agent.enabled) {
        const refused = await this.#addToRoster(agent);
        if (refused) console.error("agent home:", refused.error);
      }
    }
    if (!agent && this.ctx.storage.kv.get(HOME_AGENT_KEY) === agentId) {
      this.ctx.storage.kv.delete(HOME_AGENT_KEY);
      this.ctx.storage.kv.delete(HOME_RUNS_KEY);
      await this.turns.stop(agentId);
      this.roster.remove(agentId);
      this.runs.forget(agentId);
      this.#broadcastAgents();
    }
    await this.runner.apply(agentId, agent);
    // The sign-ins its runs read with are kept alive daily and warned about before they end (worker/mcp/sign-ins.ts).
    const runs = agent?.enabled && agent.trigger ? serversNamed(agent, { reads: true }) : [];
    await this.#directory.setRunServers(this.chatId, runs).catch((error: unknown) => console.error("agent sign-ins:", errorMessage(error)));
    if (agent?.enabled && agent.trigger && !agent.workflow?.length) this.ctx.waitUntil(this.#compile(agent).catch(() => {}));
  }

  /** Bring one of the owner's agents onto the roster, in a pi session made for it. */
  async #addToRoster(agent: AgentDefinition): Promise<{ error: string } | null> {
    // Before its session is made: a session made for an agent the roster refuses would stay, read by every traces read.
    const early = this.roster.refusal(agent.name);
    if (early) return early;
    const [session, newest] = await Promise.all([
      this.harness.sessions.create(),
      this.roster.hasAny() ? undefined : this.#root().then((root) => root.entries({ order: "descending" }, 1, undefined, BACKGROUND_CONTEXT)),
    ]);
    const first = !this.roster.hasAny();
    const refused = this.roster.add({
      agentId: agent.id,
      ownerUid: this.uid,
      name: agent.name,
      session: session.id,
      avatar: agent.avatar,
      color: agent.color,
      job: agent.job,
    });
    if (refused) return refused;
    // The first agent: pi's answers from now on are read for the agents they name, none before.
    if (first) this.ctx.storage.kv.put(PI_SCAN_KEY, { through: (newest?.items[0]?.id as number | undefined) ?? -1 } satisfies PiScan);
    this.#broadcastAgents();
    return null;
  }

  /** The owner's agents whose runs this chat keeps: its home agent's. Refused for anyone else. */
  #ownRuns(uid: string, agentId: string): ChatRefusal | null {
    if (uid !== this.uid) return refuse(403, "Only the agent's owner sees its runs.");
    if (this.#gone) return refuse(404, DELETED);
    if (!AGENT_ID_PATTERN.test(agentId)) return refuse(400, "No such agent.");
    return null;
  }

  /** An agent's runs, newest first, and when it runs next. */
  runsFor(uid: string, agentId: string): AgentRunList | ChatRefusal {
    const refused = this.#ownRuns(uid, agentId);
    if (refused) return refused;
    return { runs: this.runs.list(agentId), nextRunAt: this.runner.nextRun(agentId), homeChatId: this.chatId };
  }

  /** One run in full: its items, what it sent, what it used. */
  runDetail(uid: string, agentId: string, dueAt: number): AgentRunDetail | ChatRefusal {
    const refused = this.#ownRuns(uid, agentId);
    if (refused) return refused;
    const run = this.runs.get(agentId, dueAt);
    if (!run) return refuse(404, "No such run.");
    return {
      ...this.runs.view(run),
      when: run.detail.when ?? "",
      itemsList: this.runs.items(agentId, dueAt),
      deliveries: run.detail.deliveries,
      used: run.detail.used ?? { skills: [], servers: [], models: [] },
    };
  }

  /** The entries of one item's session in a run, oldest first: the trace the run detail draws with the chat's step rows. */
  async runTrace(uid: string, agentId: string, dueAt: number, item: string): Promise<{ entries: object[] } | ChatRefusal> {
    const refused = this.#ownRuns(uid, agentId);
    if (refused) return refused;
    const found = this.runs.item(agentId, dueAt, item);
    if (!found?.session) return refuse(404, "No such run item.");
    const conversation = await this.harness.conversation(found.session);
    const entries: EntryRecord[] = [];
    if (conversation) for await (const page of entryPages(conversation, { order: "ascending" }, 200, 10)) entries.push(...page);
    // Plain objects: an EntryRecord's type is too deep for the RPC stub's.
    return { entries: entries.map(withoutImageData) as object[] };
  }

  /** Run an agent now: Test it (`test`, nothing sent or changed), or a run its owner asked for. */
  async startRun(uid: string, agentId: string, test: boolean): Promise<{ dueAt: number } | ChatRefusal> {
    const refused = this.#ownRuns(uid, agentId);
    if (refused) return refused;
    const started = await this.runner.now(agentId, test);
    return "error" in started ? refuse(404, started.error) : started;
  }

  /** Compile an agent's instructions to a workflow now (its owner asked), and save it: the definition as saved. */
  async compileAgent(uid: string, agentId: string): Promise<AgentDefinition | ChatRefusal> {
    const refused = this.#ownRuns(uid, agentId);
    if (refused) return refused;
    const agent = await this.#directory.getAgent(agentId);
    if (!agent) return refuse(404, "No such agent.");
    try {
      return await this.#compile(agent, true);
    } catch (error) {
      return refuse(409, `The instructions did not compile to steps: ${errorMessage(error)}`);
    }
  }

  readonly #compiling = new Map<string, Promise<AgentDefinition>>();
  /** The last refresh for a run (#runRefresh): which agent at which version, when, and its promise. */
  #runRefreshed?: { key: string; at: number; done: Promise<void> };

  /**
   * One model call turns an agent's instructions into its workflow, saved with the definition (as the version it was
   * made from: a definition changed meanwhile keeps its change). `replace`: also over a workflow it has.
   */
  #compile(agent: AgentDefinition, replace = false): Promise<AgentDefinition> {
    const going = this.#compiling.get(agent.id);
    if (going) return going;
    const compiling = (async () => {
      if (agent.workflow?.length && !replace) return agent;
      const choice = await this.#agentChoice(agent);
      const model = currentCatalog().model(choice.model) ?? this.ai(choice.model);
      const servers = (agent.servers ?? this.hub.servers().map((server) => server.name)).filter((name) => this.hub.server(name));
      const listed = await Promise.all(
        servers.map(async (server) => ({ server, tools: await this.hub.tools(server).catch(() => []) })),
      );
      const { workflow } = await compileWorkflow(this.#oneShotModels, model, agent, listed);
      const saved = await this.#directory.saveAgent({ ...inputOf(agent), workflow }, agent.origin, undefined, { id: agent.id, version: agent.version });
      if ("error" in saved) throw new Error(saved.error);
      return saved;
    })().finally(() => this.#compiling.delete(agent.id));
    compiling.catch((error: unknown) => console.error("agent compile:", errorMessage(error)));
    this.#compiling.set(agent.id, compiling);
    return compiling;
  }

  /** The owner signed in to `server`: the runs that waited for it go again. */
  signedIn(server: string): Promise<number> {
    if (this.#gone) return Promise.resolve(0);
    return this.runner.signedIn(server);
  }

  /**
   * A Source this chat's agent watches through says its value moved. The run it may start goes on here, off the
   * Source's poll: the Source does not wait for its subscribers' runs.
   */
  sourceMoved(agentId: string, value: Value, source: string): void {
    if (this.#gone) return;
    this.ctx.waitUntil(this.runner.sourceMoved(agentId, value, source).catch((error: unknown) => console.error("agent watch:", errorMessage(error))));
  }

  /**
   * Post a run's report into this chat, from the agent's home conversation (a chat object of the same owner): only for
   * an agent of this chat's owner that is on its roster. Its session here reads the report as context, so a reply
   * here can be about it. Placed once per `requestId`.
   */
  async postRun(reply: ChatAgentReplyData, context: string, requestId: string): Promise<ChatRefusal | null> {
    if (this.#gone) return refuse(404, DELETED);
    const entry = this.roster.get(reply.agentId);
    if (reply.ownerUid !== this.uid || !entry) return refuse(403, `@${reply.name} is not in this chat.`);
    await this.#placeRun(reply, context, requestId, entry);
    return null;
  }

  /** A run's report in this chat's log, and as context in the agent's session here when it has one. */
  async #placeRun(reply: ChatAgentReplyData, context: string, requestId: string, entry: RosterEntry | null, tags: readonly string[] = []): Promise<void> {
    await this.#postAgentReply(reply, requestId, tags);
    const session = entry && (await this.harness.conversation(entry.session));
    if (session) await this.#writeAside(session, context, `${requestId}:context`);
  }

  /**
   * The run a reply continues: when `entry` is a run's report posted here (its run is this chat's), the session of the
   * run the reply goes to, a fork of the run's, made at the first reply and kept for the next ones.
   */
  async #continuedRun(entry: EntryRecord | undefined): Promise<{ agentId: string; session: string; run: RunRef } | undefined> {
    if (entry?.kind !== CHAT_AGENT_KIND) return undefined;
    const data = entry.data as unknown as ChatAgentReplyData;
    if (!data.run) return undefined;
    const record = this.runs.get(data.agentId, data.run.dueAt);
    if (!record) return undefined;
    const ref = runRef(record);
    if (record.replySession) return { agentId: data.agentId, session: record.replySession, run: ref };
    const items = this.runs.items(data.agentId, record.dueAt);
    const from = items.find((item) => item.status === "acted" && item.session) ?? items.find((item) => item.session);
    if (!from?.session) return undefined;
    const fork = await this.harness.sessions.fork(from.session);
    // A run of several items: the fork has one item's reads; the whole report says what the others came to.
    if (items.length > 1) await this.#writeAside(await this.#conversation(fork.id), reportContext(record.detail.when ?? "", reportOf(items)), `run-reply:${record.dueAt}`);
    this.runs.setReplySession(data.agentId, record.dueAt, fork.id);
    return { agentId: data.agentId, session: this.runs.get(data.agentId, record.dueAt)!.replySession ?? fork.id, run: ref };
  }

  /** What the run executor needs of this chat (worker/agents/runs/). */
  #runnerHost(): RunnerHost {
    const signInOr = (error: unknown) => (error instanceof McpFailure && error.error.code === "auth_required" ? new SignInNeeded(error.error.server ?? "") : error);
    return {
      runs: this.runs,
      read: async (server, tool, input) => {
        const info = await this.hub.tool(server, tool).catch((error: unknown) => {
          throw signInOr(error);
        });
        if (!info) throw new Error(`${server} has no tool "${tool}".`);
        if (!isReadOnly(info)) throw new Error(`${server}.${tool} changes data: a look step only reads.`);
        try {
          const { result } = await this.hub.read(server, tool, input, { staleMs: RUN_STALE_MS, viewer: this.uid });
          return (result.payload ?? null) as Value;
        } catch (error) {
          throw signInOr(error);
        }
      },
      // Each sign-in refreshed now, as nobody is there to sign in (worker/mcp/sign-ins.ts).
      needsSignIn: async (servers) => {
        const checked = await this.#directory.checkSignIns(servers);
        return servers.filter((server) => checked[server] === "needs_sign_in");
      },
      signInNeeded: (agent, servers) => {
        const directory = this.#directory;
        const asking = servers.map((server) => directory.notifySignInNeeded(server, { chatId: this.chatId, what: `@${agent.name}` }));
        this.ctx.waitUntil(Promise.allSettled(asking));
      },
      newSession: async () => (await this.harness.sessions.create()).id,
      configure: (session, agent, model) => this.#configureRun(session, agent, model),
      write: async (session, text, requestId) => this.#writeAside(await this.#conversation(session), text, requestId),
      work: async (session, prompt, operationId) => {
        const { result, entries } = await this.#runStep(session, prompt, operationId);
        return { status: result.status, ...(result.text !== undefined && { text: result.text }), ...(result.reason && { reason: result.reason }), ...workSpend(entries) };
      },
      deliver: (request) => this.#deliverRun(request),
      // Over the owner's sidebar socket: the Runs tab is a page of its own, with no chat socket open.
      changed: (agentId) => this.ctx.waitUntil(this.#directory.runsChanged(agentId)),
      alarmAt: async (at, payload) => (await this.scheduler.set(new Date(at), "run", payload)).id,
      alarmEvery: async (seconds, payload) => (await this.scheduler.every(seconds, "watch", payload)).id,
      cancelAlarm: async (id) => {
        await this.scheduler.cancel(id);
      },
      definition: (agentId) => this.#directory.getAgent(agentId),
      sharedWatch: (step) => {
        const server = this.hub.server(step.server);
        return !!server && watchableForAll(server);
      },
      subscribe: async (agentId, step, everyMinutes) => {
        await exports.Source.getByName(await sourceName(step)).subscribe(step, { uid: this.uid, chatId: this.chatId, agentId }, everyMinutes);
      },
      unsubscribe: async (agentId, source) => {
        await exports.Source.getByName(source).unsubscribe({ uid: this.uid, agentId });
      },
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    };
  }

  /** A run step's prompt into its session (placed once per `operationId`), waited for: its end and its entries. */
  async #runStep(session: string, prompt: string, operationId: string) {
    const data: RunStepData = { op: operationId };
    await this.harness.submit(prompt, { session, operationId, whenBusy: "followUp", entry: { kind: RUN_STEP_KIND, data } });
    const result = await this.harness.wait(operationId, { session });
    const entries = await this.#entriesFrom(await this.#conversation(session), (entry) => isRunStep(entry, operationId));
    return { result, entries };
  }

  /**
   * Set a run's session up for its work steps: the owner's tools and skills as they are now, the agent's model (or the
   * step's), its run instructions, and only reading tools: the read-only MCP tools of its servers and the app's read
   * tools (runTools). `pageTools`: a page rebuild's, which has the report as its data and gets these artifact tools in
   * place of the servers' (so nothing a server returns can steer what it writes).
   */
  async #configureRun(session: string, agent: AgentDefinition, model: string | undefined, pageTools?: readonly string[]): Promise<void> {
    await this.#runRefresh(agent);
    const allowed = (installed: readonly string[]) =>
      pageTools ? [...runTools(installed, new Map(), agent), ...pageTools] : runTools(installed, this.#mcpTools, agent);
    await this.#configureSession(session, this.#agentChoice(agent, model), runInstructions(agent, this.#nameOf(this.uid)), allowed);
  }

  /**
   * The owner's tools and skills brought up to date for an agent's run: once for all the items and steps of a run that
   * start within RUN_STALE_MS, not once each (a refresh lists files and tools, and may ask a model which skills fit).
   */
  #runRefresh(agent: AgentDefinition): Promise<void> {
    const key = `${agent.id}:${agent.version}`;
    const now = Date.now();
    const kept = this.#runRefreshed;
    if (kept?.key === key && now - kept.at < RUN_STALE_MS) return kept.done;
    const done = this.#refreshForTurn(agent.instructions.slice(0, 2_000));
    this.#runRefreshed = { key, at: now, done };
    done.catch(() => {
      if (this.#runRefreshed?.done === done) this.#runRefreshed = undefined;
    });
    return done;
  }

  /** A run's report as a post of its agent's, carrying the run. */
  #runReply(request: DeliveryRequest): ChatAgentReplyData {
    const { agent, run } = request;
    const now = Date.now();
    return {
      agentId: agent.id,
      name: agent.name,
      avatar: agent.avatar,
      color: agent.color,
      ownerUid: this.uid,
      text: request.text,
      calledBy: { name: agent.name, agentId: agent.id, schedule: true },
      turn: 0,
      hop: 0,
      startedAt: this.runs.get(agent.id, run.dueAt)?.startedAt ?? now,
      endedAt: now,
      run: runRef(run),
    };
  }

  /**
   * Send a run's report where its step says, as its owner. At Inform (level 1, and until approvals come for the
   * others): posts to its home chat and to the owner's chats it is in, notifications to its owner, page versions and
   * hand-overs to the owner's other agents; outside tools and other people are refused.
   */
  async #deliverRun(request: DeliveryRequest): Promise<RunDelivery> {
    const { step, agent } = request;
    if (step.kind === "page") return this.#pageStep(request, step);
    if (step.kind === "handOver") return this.#handOver(request, step.agent);
    if (typeof step.via === "object") {
      return {
        kind: "tool",
        to: `${step.via.server}.${step.via.tool}`,
        status: "refused",
        detail: `at ${AUTONOMY_LABELS[agent.autonomy]}, outside tools wait for approvals, which come later`,
      };
    }
    const context = reportContext(whenOf(agent), request.text);
    // "owner", "me", "you", the agent itself or this chat: the owner, in the agent's home conversation.
    const isOwner = (to: string) => OWNER_TARGETS.has(to.toLowerCase()) || to.replace(/^@/, "") === agent.name || to === this.chatId;
    if (step.via === "notify") {
      const others = step.to.filter((to) => !isOwner(to.trim()));
      if (others.length === step.to.length)
        return { kind: "notify", to: step.to.join(", "), status: "refused", detail: "at Inform, an agent notifies only its owner" };
      // Posted here, tagging the owner: their sidebar's notice, and a browser notification when they allow one.
      await this.#placeRun(this.#runReply(request), context, `run-post:${agent.id}:${request.run.dueAt}:${request.key}`, this.roster.get(agent.id), [this.uid]);
      return {
        kind: "notify",
        to: "you",
        text: request.text,
        status: "sent",
        ...(others.length && { detail: `not ${others.join(", ")}: at Inform, an agent notifies only its owner` }),
      };
    }
    // To chats: its home (this one), and the owner's chats it is in, by id or title. The list only when one is named.
    // The owner's names ("owner", "me", "@agent") are one place: the report goes there once.
    const targets = [...new Set(step.to.map((to) => to.trim()).map((to) => (isOwner(to) ? "owner" : to)))];
    const chats = targets.every(isOwner) ? [] : (await this.#directory.listChats()).filter((chat) => !chat.sharedBy);
    const outcomes = await Promise.all(
      targets.map(async (target): Promise<{ sent: string } | { refused: string }> => {
        const requestId = `run-post:${agent.id}:${request.run.dueAt}:${request.key}:${target}`;
        if (isOwner(target)) {
          await this.#placeRun(this.#runReply(request), context, requestId, this.roster.get(agent.id));
          return { sent: "its chat" };
        }
        const chat = chats.find((one) => one.id === target) ?? chats.find((one) => one.title.toLowerCase() === target.toLowerCase());
        if (!chat) return { refused: `${target} (no such chat of yours)` };
        const answer = await exports.ChatAgent.getByName(chatAgentName(this.uid, chat.id)).postRun(this.#runReply(request), context, requestId);
        return answer ? { refused: `${chat.title} (${answer.error})` } : { sent: chat.title };
      }),
    );
    const sent = outcomes.flatMap((outcome) => ("sent" in outcome ? [outcome.sent] : []));
    const refused = outcomes.flatMap((outcome) => ("refused" in outcome ? [outcome.refused] : []));
    return {
      kind: "chat",
      to: [...sent, ...refused].join(", ") || step.to.join(", "),
      text: request.text,
      status: sent.length ? "sent" : "refused",
      ...(refused.length && { detail: `not posted to ${refused.join(", ")}` }),
    };
  }

  /** Hand a run's report to another agent of the owner's, as a turn in this chat (on the roster, brought in when not). */
  async #handOver(request: DeliveryRequest, name: string): Promise<RunDelivery> {
    const to = `@${name.replace(/^@/, "")}`;
    let entry = this.roster.byName(name.replace(/^@/, ""));
    if (!entry) {
      const agent = (await this.#directory.listAgents()).find((one) => one.name === name.replace(/^@/, "").toLowerCase());
      if (!agent?.enabled) return { kind: "handOver", to, status: "refused", detail: agent ? `${to} is off` : `you have no agent ${to}` };
      const refused = await this.#addToRoster(agent);
      if (refused) return { kind: "handOver", to, status: "failed", detail: refused.error };
      entry = this.roster.get(agent.id)!;
    }
    const { agent } = request;
    this.turns.call([entry.agentId], {
      // For the agent whose run handed it over: "for @signups".
      calledBy: { name: agent.name, agentId: agent.id },
      ask: askOf({ name: agent.name, kind: "agent" }, request.text, MAX_ASK_CHARS),
      // A run's hand-over can only read, as any turn its owner did not give, and its chain never hands pi a turn.
      byOwner: false,
      unattended: true,
      hop: 1,
    });
    return { kind: "handOver", to, text: request.text, status: "sent" };
  }

  /**
   * A page step: the report in the page's findings block (an edit), or the page rebuilt as a snapshot of today's data
   * (the model writes it), then the usual check and publish, in code and in the chat the page belongs to, as its
   * versions always are. A page that fails its check is not published: the run records "page not updated" and still
   * sends its other deliveries.
   */
  async #pageStep(request: DeliveryRequest, step: Extract<AgentStep, { kind: "page" }>): Promise<RunDelivery> {
    const meta = await this.storage.artifacts.readMeta(step.artifactId);
    const to = meta?.title ?? `page ${step.artifactId}`;
    if (!meta || meta.ownerUid !== this.uid) return { kind: "page", to, status: "refused", detail: "page not updated: it is not one of your pages" };
    const scope: PublishScope = {
      ...this.scope,
      chatId: meta.chatId,
      onPublished: async (artifact) => {
        await this.#directory.recordArtifact({ ...artifact, chatId: meta.chatId });
        // As any version: the chat that discusses the page hears of it (its notice, and its agents read the new one).
        void this.#tellPageChat(artifact).catch((error: unknown) => console.error("page chat:", errorMessage(error)));
      },
    };
    const mark = runMark(request.agent.id, request.run.dueAt, request.key);
    // A run that goes on after a restart publishes once: a version with its mark is the one it sent.
    const already = publishedAlready(meta, mark);
    if (already) return already;
    if (step.edit === "rebuild") return this.#rebuildPage(request, meta, scope, mark);
    return publishFindings(scope, meta, request.text, `Findings, ${whenOf(request.agent)}`, mark);
  }

  /**
   * A page rebuilt as today's snapshot: one model turn, in the delivery's session, that may only read the page and
   * write and check drafts of it (no servers' tools: nothing a server returns steers what it writes, and it publishes
   * nothing). Its page is a draft made here from the latest version; the newest draft of it that passed its check is
   * published in code (publishRebuilt).
   */
  async #rebuildPage(request: DeliveryRequest, meta: ArtifactMeta, scope: PublishScope, mark: string): Promise<RunDelivery> {
    const { agent, run } = request;
    // artifact_read takes this chat's pages and the ones brought in.
    this.#bringIn([meta.id]);
    // The page as it is, declaring only its read-only tools: a snapshot never writes as the owner (publishRebuilt).
    const mcp = await readOnlyDeclaration(manifestOf(meta, meta.latest), async (server, name) => {
      const tool = await this.hub.tool(server, name).catch(() => undefined);
      return !!tool && isReadOnly(tool);
    });
    const seed = await writeDraft(scope, { artifact: meta, edits: [], mcp });
    const session = request.session ?? (await this.harness.sessions.create()).id;
    await this.#configureRun(session, agent, undefined, ["artifact_read", WRITE_TOOL, CHECK_TOOL]);
    const operationId = `run:${agent.id}:${run.dueAt}:page:${request.key}`;
    const prompt = [
      `Rebuild the page "${meta.title}" (artifact ${meta.id}) as a snapshot of this run: today's data written into the page, so it makes no live calls.`,
      `The run's report:\n\n${request.text}`,
      `The page as it is now is the draft "${seed.id}" (read it with artifact_read, artifact_id "${meta.id}"). Change it with ${WRITE_TOOL}, ` +
        `draft_id "${seed.id}" and edits (a new page written whole is not this page's and is not published), check the new draft with ` +
        `${CHECK_TOOL} and fix what it finds. The newest draft that passes is published for you. Answer with one line on what changed.`,
    ].join("\n\n");
    const { result, entries } = await this.#runStep(session, prompt, operationId);
    const written = entries.flatMap((entry) => writtenBy(entry) ?? []);
    const delivery = await publishRebuilt(scope, meta, seed, written, `Snapshot, ${whenOf(agent)}`, mark);
    // The seed is only the page as it was: left behind, each run's would push the owner's own drafts out of the chat's.
    await (await scope.drafts()).remove(seed.id).catch((error: unknown) => console.error("draft:", errorMessage(error)));
    return delivery.status === "failed" && result.reason ? { ...delivery, detail: `${delivery.detail} (${result.reason})` } : delivery;
  }

  /**
   * Stop pi's run and the messages queued for it, and every agent's turns; or with `agent`, only that agent's. In a shared
   * chat the others see who stopped it.
   */
  async abort(by: Person, agent?: string): Promise<void> {
    this.#requireInChat(by);
    if (agent !== undefined) {
      const entry = this.roster.get(agent);
      if (entry && (await this.turns.stop(agent)) && this.members.hasAny()) this.#notePeople(by, "stopped", entry.name);
      return;
    }
    // Only for the notice: a failure to read pi's queue must not keep the run from stopping.
    const running = await this.#replying().catch(() => false);
    const [, agents] = await Promise.all([this.harness.abort(), this.turns.stop()]);
    if ((running || agents) && this.members.hasAny()) this.#notePeople(by, "stopped");
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

  /**
   * Whether `viewer` may read what the author's views of a page saved (the defaults pi.use("storage") serves). A page
   * may save what it loaded, so its saved values follow the rule for its data: an artifact with a version that calls a
   * server only the chat's people may load (#mayLoad) shares its author's values only with them.
   */
  async mayReadPageDefaults(artifactId: string, viewer: string): Promise<boolean> {
    if (this.isInChat(viewer)) return true;
    const meta = await this.storage.artifacts.readMeta(artifactId);
    if (!meta || !isOwnedBy(meta, this.uid, this.chatId)) return false;
    return meta.versions.every((version) => (version.manifest.mcp?.servers ?? []).every((entry) => this.#mayLoad(entry.server, viewer)));
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

/** Whether a reply is running, and the agent as it stands (see ChatAgent's #now). */
interface ChatNow {
  root: Conversation;
  busy: boolean;
  agent: Agent;
}

/** What #route found: a router's pick and the model choice it names, or why the chat keeps its model, and how long that took. */
type Routing = { pick: AutoPick; choice: ModelChoice } | { kept: Pick<AutoPick, "running" | "missed" | "ms"> & { failed: string } };

/** What the chat's sockets need from the chat. */
interface ChatSession {
  events(): Promise<AgentEventStream>;
  runStartedAt(snapshot: SnapshotEvent): Promise<number | undefined>;
  toolsStartedAt(snapshot: SnapshotEvent): Promise<Record<string, number>>;
  admit(person: Person): boolean;
  peopleFor(uid: string): ChatPeopleView;
  queued(ids: readonly number[]): Promise<QueuedMessage[]>;
  incoming(): IncomingMessage[];
  prompt(text: string, author: Person, attachments: readonly AttachmentInput[], mentions: readonly MentionInput[], replyTo?: number): Promise<void>;
  abort(by: Person, agent?: string): Promise<void>;
  /** The chat's agents besides pi, as everyone sees them. */
  agents(): ChatAgentView[];
  /** The agents' turns running now, each with its session: what the sockets follow live. */
  runningAgents(): { agentId: string; session: string; turn: number }[];
  /** An agent's session's events: a snapshot, then one batch per commit. */
  agentEvents(session: string): Promise<AgentEventStream>;
  /** The entry id of turn `turn`'s input in an agent's session, once it is placed (a compaction may have cut it from the snapshot). */
  turnInputId(session: string, turn: number): Promise<number | undefined>;
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

/** One agent's turn a socket follows live: which turn, and the stream of its session. */
type AgentFollow = { turn: number; stream: Promise<AgentEventStream> };

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
  /** Per socket, the agents' turns it follows live (see #followAgents), by agent id. */
  readonly #agentStreams = new Map<WebSocket, Map<string, AgentFollow>>();

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

  /** Tell one person's open sockets something only they see. */
  sendTo(uid: string, message: ChatServerMessage): void {
    for (const ws of this.lifecycle.sockets.get(SOCKET_TAG)) if (this.#person(ws)?.uid === uid) send(ws, message);
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
      } else if (message.type === "abort") await this.#chat.abort(person, typeof message.agent === "string" ? message.agent : undefined);
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
        // Followed again as it attaches again, or with the socket's next message.
        void this.#unfollowAgents(ws);
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
      send(ws, { type: "incoming", incoming: this.#chat.incoming() });
      send(ws, { type: "agents", agents: this.#chat.agents() });
      this.#followAgents(ws);
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
      void this.#unfollowAgents(ws);
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
    await Promise.all([this.#unfollowAgents(ws), (await stream?.catch(() => undefined))?.stop()]);
  }

  /** Let go of the agents' turns `ws` follows: its pi stream is gone (detached, ended, or never sent its snapshot). */
  async #unfollowAgents(ws: WebSocket): Promise<void> {
    // Cleared too: a stream still opening checks it before it sends anything.
    const following = this.#agentStreams.get(ws);
    const agents = [...(following?.values() ?? [])];
    following?.clear();
    this.#agentStreams.delete(ws);
    await Promise.all(agents.map(async (follow) => (await follow.stream.catch(() => undefined))?.stop()));
  }

  /** Every open socket follows the agents' turns running now, and lets go of those that ended (see #followAgents). */
  followAgents(): void {
    const sockets = this.lifecycle.sockets.get(SOCKET_TAG).filter((ws) => this.#person(ws) && this.#streams.has(ws));
    if (!sockets.length) return;
    const running = this.#chat.runningAgents();
    for (const ws of sockets) this.#followAgents(ws, running);
  }

  /**
   * Follow, for `ws`, each agent's session while it has a turn: only that turn's events reach the socket (TurnFilter), so
   * one that attaches mid-turn gets the turn's entries, not the agent's whole history. A stream whose turn ended, or
   * whose agent left, stops; one that ends by itself is let go, and the next change of the roster follows it again.
   */
  #followAgents(ws: WebSocket, runs = this.#chat.runningAgents()): void {
    // A socket detached while its attach was opening (it closed, or was removed) follows nothing: #detach has already
    // let go of its streams, and none started now would ever be stopped.
    if (!this.#streams.has(ws)) return;
    const following = this.#agentStreams.get(ws) ?? new Map<string, AgentFollow>();
    this.#agentStreams.set(ws, following);
    const running = new Map(runs.map((run) => [run.agentId, run]));
    for (const [agent, follow] of following) {
      if (running.get(agent)?.turn === follow.turn) continue;
      following.delete(agent);
      void follow.stream.then((events) => events.stop()).catch(() => {});
    }
    for (const run of running.values()) {
      if (following.has(run.agentId)) continue;
      const follow = { turn: run.turn } as AgentFollow;
      following.set(run.agentId, follow);
      const current = () => following.get(run.agentId) === follow;
      const letGo = () => current() && following.delete(run.agentId);
      follow.stream = this.#streamTurn(ws, run, current, letGo);
      follow.stream.catch((error: unknown) => {
        console.error("agent socket:", errorMessage(error));
        letGo();
      });
    }
  }

  /**
   * Send `ws` one agent's turn as it goes: a snapshot of it, then each batch, while `current` says the socket still
   * follows it. `letGo` when the stream ends by itself.
   */
  async #streamTurn(ws: WebSocket, run: { agentId: string; session: string; turn: number }, current: () => boolean, letGo: () => void) {
    const message = (events: readonly AgentEvent[]) => ({
      type: "agentEvents" as const,
      agent: run.agentId,
      turn: run.turn,
      events: events.map((event) => withoutImageData(withoutSystemPrompt(event))),
    });
    const events = await this.#chat.agentEvents(run.session);
    const now = Date.now();
    // A snapshot without the turn's input: not placed yet, or a compaction cut it out of the context. Its id says which.
    const placed = events.snapshot.entries.some((entry) => isTurnEntry(entry, run.turn));
    const [started, inputId] = await Promise.all([
      this.#chat.toolsStartedAt(events.snapshot),
      placed ? undefined : this.#chat.turnInputId(run.session, run.turn).catch(() => undefined),
    ]);
    const filter = new TurnFilter(run.turn, inputId);
    // Let go meanwhile (its turn ended, or the socket closed): nothing more to send.
    if (!current()) {
      await events.stop();
      return events;
    }
    const toolsElapsedMs = Object.fromEntries(Object.entries(started).map(([id, at]) => [id, Math.max(0, now - at)]));
    send(ws, { ...message(filter.pass([events.snapshot])), toolsElapsedMs });
    events.start(async (batch) => {
      const passed = filter.pass(batch);
      // A socket that cannot be sent to is gone: stop following for it, as its pi stream does.
      if (passed.length && current() && !send(ws, message(passed))) {
        letGo();
        await events.stop();
      }
    });
    void events.closed.then(letGo);
    return events;
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

/** What a page's chat tells its agent about the page (`what`: "discusses" it, or it "has a new version"). */
function pageNote(page: ChatPage, what: "discusses" | "has a new version" | "came from"): string {
  const which = `the page (artifact) "${page.title}", id ${page.id}, version ${page.version}`;
  if (what === "discusses") return `This chat discusses ${which}. People here ask about it; read it with artifact_read when a question needs it.`;
  if (what === "came from") return `This chat branched off from one that discusses ${which}. Read it with artifact_read when a question needs it.`;
  return `The page this chat discusses has a new version: ${which}. Read it again with artifact_read before answering about what changed.`;
}

/** A branch's title, from the chat it branched off from. */
function branchTitleOf(title: string): string {
  return `${title || "Chat"} (branch)`;
}
