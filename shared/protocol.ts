// Types shared by the Worker, the React app and the artifact page runtime.
// The MCP shapes mirror the contract Claude's artifacts use, so pages written
// for one read naturally against the other.

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { EntryReactions, Reactions } from "./reactions.ts";
import type { Attachment, AttachmentInput } from "./attachments.ts";
import type { Mention, MentionInput } from "./mentions.ts";
import type { ChatAgentView } from "./agents.ts";

export type McpErrorCode =
  | "server_not_connected"
  | "server_unavailable"
  | "auth_required"
  | "not_in_manifest"
  | "not_granted"
  | "tool_error"
  | "bad_request"
  | "rate_limited"
  | "cancelled"
  | "upstream_error";

export interface McpError {
  code: McpErrorCode;
  message: string;
  server?: string;
  /** Present only as `true`: one unattended retry may succeed. */
  retryable?: true;
  retryAfterMs?: number;
  /** The tool's own result envelope, on `tool_error`. */
  result?: unknown;
}

export type ContentBlock = { type: "text"; text: string } | { type: string; [k: string]: unknown };

export interface CallToolResult {
  content: ContentBlock[];
  structuredContent?: unknown;
  /** `structuredContent`, else the first text block parsed as JSON, else that text. */
  payload?: unknown;
  /** Present when the result came from a cache; `storedAt` is when it was produced (epoch ms). */
  cache?: { storedAt: number; revalidating: boolean };
}

/** The Worker's answer to one proxied call: a result or an error, plus when to ask again. */
export type ProxyResponse =
  | { ok: true; result: CallToolResult; storedAt: number; nextRefreshAt?: number }
  | { ok: false; error: McpError };

export interface ProxyRequest {
  version: number;
  /** `read` for watches and cacheable reads (read-only tools only), `call` for one-shot calls. */
  mode: "read" | "call";
  server: string;
  tool: string;
  input: unknown;
  /** The page's declared freshness for this call, in ms. 0 = always execute. */
  staleMs?: number;
}

/** The most staleness a page's read may accept. */
export const MAX_STALE_MS = 24 * 60 * 60_000;

/** A request's `staleMs` as a number from 0 to MAX_STALE_MS: it comes from the page. */
export function clampStaleMs(staleMs: unknown): number {
  return Math.min(Math.max(Number(staleMs) || 0, 0), MAX_STALE_MS);
}

/** What went wrong with a page's saved values or model call. */
export type PageErrorCode = "bad_request" | "too_large" | "rate_limited" | "limit_reached" | "unavailable" | "bad_output";

export interface PageError {
  code: PageErrorCode;
  message: string;
  retryAfterMs?: number;
}

/**
 * A page's saved values (pi.use("storage")), as POST /api/artifacts/:id/storage takes them: load them, write changes
 * (null removes a key), or drop the viewer's own.
 */
export type PageStorageRequest = { op: "load" } | { op: "write"; changes: Record<string, string | null> } | { op: "reset" };

/** The values a page sees: the viewer's own over the author's. `isAuthor`: the viewer's values are everyone's defaults. */
export interface PageValues {
  values: Record<string, string>;
  isAuthor: boolean;
}

export type PageStorageResponse = ({ ok: true } & Partial<PageValues>) | { ok: false; error: PageError };

/**
 * How much one viewer may save for one page: each key and value, and all their own (removed keys of the author's
 * included). The runtime gets these numbers when a page is served (worker/artifacts/serve.ts) and refuses an oversized
 * key or value at once; the totals only the Worker can count, so a write over them fails in the background.
 */
export const PAGE_STORAGE_LIMITS = { keyChars: 256, valueChars: 100_000, totalChars: 500_000, keys: 500 } as const;

/** One call to a page's model (pi.use("ai")), as POST /api/artifacts/:id/ai takes it. */
export interface PageAiRequest {
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
  /** Answer with JSON: the reply is parsed (a fenced block too), and one that is not JSON is `bad_output`. */
  json?: boolean;
}

export type PageAiResponse = { ok: true; text: string; json?: unknown } | { ok: false; error: PageError };

/** How large a page's model call may be. */
export const PAGE_AI_LIMITS = { messages: 40, chars: 40_000, systemChars: 8_000, maxTokens: 2_000, defaultMaxTokens: 1_000 } as const;

export interface ToolInfo {
  name: string;
  description: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  inputSchema?: unknown;
}

/** Whether a tool says it only reads: what lets a viewer who is not the author call it, and the agent replay it. */
export function isReadOnly(tool: ToolInfo): boolean {
  return tool.annotations?.readOnlyHint === true;
}

/** A tool an artifact version declared, with the server it belongs to: what GET /api/artifacts/:id/tools lists. */
export type DeclaredTool = ToolInfo & { server: string };

/** What an artifact's frame may do: run scripts and open popups, with an opaque origin (no allow-same-origin). */
export const ARTIFACT_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";

/** What a page may call. Fixed per version at publish time; the page cannot widen it. */
export interface ArtifactManifest {
  mcp?: { servers: { server: string; tools: string[] }[] };
}

export interface ArtifactVersion {
  version: number;
  publishedAt: number;
  manifest: ArtifactManifest;
  /** What changed, in the agent's words: the version's commit message. */
  message?: string;
}

export interface ArtifactMeta {
  id: string;
  title: string;
  ownerUid: string;
  chatId: string;
  createdAt: number;
  updatedAt: number;
  latest: number;
  versions: ArtifactVersion[];
}

/** The manifest one version of an artifact declared, if that version exists. */
export function manifestOf(meta: Pick<ArtifactMeta, "versions">, version: number): ArtifactManifest | undefined {
  return meta.versions.find((v) => v.version === version)?.manifest;
}

/** Whether an artifact belongs to this user's chat: the one rule for who may publish to it and read its source. */
export function isOwnedBy(meta: Pick<ArtifactMeta, "ownerUid" | "chatId">, uid: string, chatId: string): boolean {
  return meta.ownerUid === uid && meta.chatId === chatId;
}

/** An artifact as the app lists it in the sidebar. */
export interface ArtifactSummary {
  id: string;
  title: string;
  chatId: string;
  latest: number;
  updatedAt: number;
  /** Set when a version was published that its owner has not opened yet. */
  unread?: true;
}

/**
 * An artifact as GET /api/artifacts/:id returns it: everything but who owns it, and the chat it lives in only when asked
 * (?chat) by people in that chat, who can open it there to keep building it.
 */
export type ArtifactView = Omit<ArtifactMeta, "chatId" | "ownerUid"> & { isOwner: boolean; chatId?: string };

/** A read-only Git token for one artifact's repo (POST /api/artifacts/:id/clone). */
export interface CloneAccess {
  remote: string;
  token: string;
  expiresAt: string;
}

/** The agent's tool that lists the MCP servers afresh. */
export const MCP_DISCOVER_TOOL = "mcp_discover";

/** Between the server's slug and the tool's name in an MCP tool's agent name (mcpToolName in worker/agent/mcp.ts). */
export const MCP_TOOL_SEPARATOR = "__";

/** An MCP tool's server slug and tool, from its agent name (mcpToolName); nothing for a built-in tool. */
export function mcpParts(name: string): [server: string, tool: string] | undefined {
  let split = name.indexOf(MCP_TOOL_SEPARATOR);
  if (split <= 0) return undefined;
  // A server slug can end in "_" ("Reports (beta)" is "reports_beta_"): the separator is the last two of the run.
  while (name[split + MCP_TOOL_SEPARATOR.length] === "_") split++;
  return [name.slice(0, split), name.slice(split + MCP_TOOL_SEPARATOR.length)];
}

/** The tool that publishes an artifact, and the details its result carries: the chat UI opens the preview from them. */
export const PUBLISH_TOOL = "artifact_publish";
// Types, not interfaces: tool details must be JSON, which an interface does not promise.
export type PublishedDetails = {
  artifactId: string;
  version: number;
  title: string;
  check?: CheckedDetails;
};

/** The tool that renders a page in a headless browser before it is published, and what its result shows in the chat. */
export const CHECK_TOOL = "artifact_check";
export type CheckedDetails = {
  /** A small JPEG data URL of the rendered page. */
  thumb: string;
  errors: number;
  warnings: number;
};

/** What a code review of a page found (worker/artifacts/review.ts): "fix" stops the page until it is fixed, "suggest" does not. */
export type ReviewFindingKind = "bug" | "security" | "performance" | "simplify";
export type ReviewFinding = {
  severity: "fix" | "suggest";
  kind: ReviewFindingKind;
  /** The page's line it is about, when the reviewer said. */
  line?: number;
  problem: string;
  fix?: string;
};

/** How many of `findings` are to fix, and how many are suggestions. */
export function countFindings(findings: readonly ReviewFinding[]): { fixes: number; suggestions: number } {
  const fixes = findings.filter((finding) => finding.severity === "fix").length;
  return { fixes, suggestions: findings.length - fixes };
}

/** A check's code review as its result shows it in the chat: a step of its own under the check. */
export type ReviewedDetails = {
  findings: ReviewFinding[];
  /** The model that answered, by its id. */
  by?: string;
  /** In dollars, at list prices; counted in the chat's cost under REVIEW_LEDGER_PREFIX. */
  cost: number;
  ms: number;
  /** Set when the review did not finish: why. */
  failed?: string;
};

/** A check's result details: what the chat shows of the check, and of the code review that ran beside it. */
export type CheckedResultDetails = { check: CheckedDetails; review?: ReviewedDetails };

/** The tool that saves a page the agent writes, or its edits to one, as a draft for the check and the publish to take by id. */
export const WRITE_TOOL = "artifact_write";

/** The tool that lists the pages the agent wrote in a chat and has not published, and gets one back. */
export const DRAFTS_TOOL = "artifact_drafts";

/**
 * What a chat's agent is up to, as the sidebar shows it: "running" while it works (or messages wait for it), "waiting"
 * when its last reply ended on a question to the people in the chat. Null where it is neither.
 */
export type ChatStatus = "running" | "waiting";

/** What a tool that writes the user's files (files_write, run_python, run_bash) says it saved: deleting the chat can delete them. */
export interface SavedFilesDetails {
  saved: string[];
}

/** GET /api/chats/:id/deletion, for the owner: what deleting the chat would delete with it. */
export interface ChatDeletion {
  title: string;
  /** Published from this chat: deleted with it, and their links stop working. */
  artifacts: { id: string; title: string }[];
  /** The owner's files attached to its messages or saved by its agent, that are still there. Only those the owner sends back with the DELETE are deleted. */
  files: string[];
  /** How many people it is shared with: they lose it at once. */
  members: number;
}

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Set on a chat someone else owns and invited you to: their name. */
  sharedBy?: string;
  /** Set on your own chat once you invited people and they joined. */
  shared?: true;
  status?: ChatStatus;
  /** Set when the chat has a reply, or someone else's message, that this user has not seen yet. */
  unread?: true;
  /** Set when someone tagged this user ("@name") in a message they have not seen yet. */
  mentioned?: true;
}

/**
 * What the sidebar's socket (GET /api/me/ws) sends: the name of a list that changed, so the app reads it again. A
 * MentionNotice comes as JSON.
 */
export type SidebarList = "chats" | "artifacts" | "skills" | "agents";

/** Someone tagged this user in a shared chat: the app shows it, and the browser too when it may and the app is not in view. */
export interface MentionNotice {
  type: "mention";
  chatId: string;
  /** The chat's title; none when the chat is named after this very message. */
  title?: string;
  /** Who tagged them. */
  from: string;
  /** The start of the message. */
  text: string;
  /** When it was sent: one message's notices share it, so windows can show it once. */
  at: number;
}

/** Someone in a chat: a verified uid, and the name the others see (their email, or the demo name). */
export interface Person {
  uid: string;
  name: string;
}

/**
 * A chat's owner can also sit in it a second time, as a separate person ("Ada (2)") who is a member like anyone they
 * invited: to try the chat as the people they share it with see it, from the one sign-in. That window's URL says so
 * (`?as=second`), and its requests carry it; the Worker turns only the verified owner into this person, for their own
 * chats, so nobody else can be it. Its uid cannot be anyone's own: those are hex (or demo slugs, which prove nothing).
 */
export const SEAT_PARAM = "as";
export const SECOND_SEAT = "second";

const SEAT_SUFFIX = "-seat2";

export function secondSeatUid(uid: string): string {
  return `${uid.slice(0, 26)}${SEAT_SUFFIX}`;
}

/** Whether a uid is one a second seat has, which no one may sign in as (demo names are refused it). */
export function isSecondSeatUid(uid: string): boolean {
  return uid.endsWith(SEAT_SUFFIX);
}

export function secondSeat(owner: Person): Person {
  return { uid: secondSeatUid(owner.uid), name: `${owner.name} (2)` };
}

/** Everyone in a chat: its owner first, then its members as they joined. */
export function everyone(people: ChatPeople): Person[] {
  return [people.owner, ...people.members];
}

/** Who is in a chat. Members joined by an invite; only the owner can invite or remove them. */
export interface ChatPeople {
  owner: Person;
  members: Person[];
}

/** An invite link the owner has not seen used yet. Only its id and times: the secret is shown once, when it is made. */
export interface ChatInvite {
  id: string;
  createdAt: number;
  expiresAt: number;
}

/** What one person's app is told about a chat's people: everyone in it, and for its owner the invites still open. */
export type ChatPeopleView = ChatPeople & { invites?: ChatInvite[] };

/** POST /api/chats/:id/invites: a single-use link to the chat. */
export interface CreatedInvite extends ChatInvite {
  url: string;
}

/**
 * The transcript entry each prompt is placed as, instead of pi's `pi.user`, so a shared
 * chat shows who wrote what. The model gets the text as a user message, prefixed with the
 * author's name once the chat has members.
 */
export const CHAT_MESSAGE_KIND = "chat.message";
export interface ChatMessageData extends Person {
  text: string;
  /** Files attached to the message, as the model got them (see shared/attachments.ts). */
  attachments?: Attachment[];
  /** Files, artifacts and people the message names with "@" (see shared/mentions.ts). */
  mentions?: Mention[];
  /**
   * Said in a shared chat without calling the agent ("@pi"): people talking among themselves. Shown at once, and
   * the model gets it only as context, from a `chat.aside` entry beside it; no run starts.
   */
  aside?: true;
  /** Called the agent in a shared chat: the app shows it was picked up once it is in the transcript. */
  summoned?: true;
  /** The message this one answers, quoted as it was when it was sent. */
  replyTo?: ReplyQuote;
  /** When it was sent (ms since the epoch), which for a message that waited in the queue is before it was written. */
  sentAt?: number;
  /** In a chat on Auto, the model and effort picked to answer it. */
  auto?: AutoPick;
  /** Which MCP tools were offered to answer it, when the chat has enough of them to pick (worker/agent/tool-pick.ts). */
  tools?: ToolPickNote;
}

/**
 * The tool picker's pick for a message: the agent tool names offered (none for a message that needs no MCP tool), the
 * picker and what its call cost, and how long it took. With no picker, it failed (`failed` says why), and every tool
 * was offered. `added`: a reply was running, so the picks were added to the tools it has. `unchanged`: the tools could
 * not be changed at all (`failed` says why), so the reply had the ones it had. A type, so pi can store it.
 */
export type ToolPickNote = {
  tools: string[];
  /** How many MCP tools there were to pick from. */
  of: number;
  picker?: RouterSpend;
  failed?: string;
  added?: true;
  unchanged?: true;
  ms: number;
};

/**
 * What Auto picked for a message that called the agent: a model (the picker's id) and an effort, why, and the router
 * that picked. With no router, the chat kept the model it ran on: none could pick (it failed or took too long), or a
 * reply was running. `ms`: how long picking took. A type, not an interface, so it is JSON pi can store.
 */
export type AutoPick = {
  model: string;
  thinkingLevel: ModelThinkingLevel;
  /** The router's reason, a few words. */
  reason?: string;
  router?: RouterSpend;
  /**
   * Routers that failed before one picked (ahead of it in the order, or asked beside it), each with its error, cut short:
   * also when the chat then kept its model (a reply started meanwhile, or the pick was not in the picker).
   */
  missed?: string;
  /** With no router: why the chat kept its model, as the tooltip shows it (a running reply, or each router's error, cut short). */
  failed?: string;
  /** With no router: it kept its model because a reply was running, which is no failure. */
  running?: true;
  ms: number;
};

/** What `failed` said of a running reply before picks had `running`: messages sent then keep it. */
const LEGACY_RUNNING = /^a reply (was still running when it was sent|started while the router picked)/;

/** Whether a call behind Auto's pick failed: a router failed before one picked, or no router could pick (not for a running reply). */
export function autoPickFailed(pick: AutoPick): boolean {
  if (pick.missed) return true;
  if (pick.router) return false;
  return !pick.running && !LEGACY_RUNNING.test(pick.failed ?? "");
}

/** A router call: the router's picker id, what the call cost, in dollars and tokens, and how long the call alone took (`ms`, absent on older picks). */
export type RouterSpend = { model: string; cost: number; input: number; output: number; ms?: number };

/**
 * A message a reply quotes: its transcript entry, who wrote it (pi, another agent of the chat by `agentId`, or a person)
 * and the start of its text.
 */
export type ReplyQuote = { id: number; name: string; text: string } & ({ agent: true; agentId?: string } | { uid: string });

/** How much of the message a reply quotes. */
export const REPLY_QUOTE_CHARS = 280;

/**
 * What the model reads of an aside (ChatMessageData.aside): the person's message as a user message, and no data, so
 * the app shows only the `chat.message` entry. Written while the agent works, pi places it at its next step.
 */
export const CHAT_ASIDE_KIND = "chat.aside";

/** GET /api/chats/:id/contents: what a chat holds of its owner's, for the people it is shared with to open. */
export interface ChatContents {
  /** The owner's files attached in the chat or saved by its agent, that are still there. */
  files: { path: string; size: number }[];
  /** The artifacts published from the chat. */
  artifacts: ArtifactSummary[];
}

/**
 * A notice in the transcript that someone joined or left a shared chat, or stopped its agent. A passive entry: everyone sees it at once,
 * even mid-run, and the model never reads it (it learns who is in the chat from its prompt).
 */
export const CHAT_PEOPLE_KIND = "chat.people";
export interface ChatPeopleData extends Person {
  /**
   * `rejoined`: someone already in the chat opened an invite link to it, in another window or on another device.
   * `stopped`: they stopped the agent mid-run.
   */
  event: "joined" | "rejoined" | "left" | "removed" | "stopped" | "agent-added" | "agent-removed";
  /** For agent-added and agent-removed: the agent's handle. */
  agent?: string;
}

/** A message waiting for the agent: sent while it was busy, in the order it will be answered. `id` is pi's submission id. */
export interface QueuedMessage extends ChatMessageData {
  id: number;
}

/**
 * A person's message the chat is getting ready to put in (its files read, the agent's tools refreshed, on Auto the
 * model picked), which can take seconds: everyone sees it at once, faded, until it is in the transcript or the queue.
 * `attachments`: their names, and thumbnails of images. `picking`: on Auto, the router is picking the model for it.
 */
export type IncomingMessage = Person & {
  text: string;
  sentAt: number;
  attachments?: IncomingAttachment[];
  replyTo?: ReplyQuote;
  picking?: true;
};

/** What an incoming message shows of a file it attaches before the file is read. */
export type IncomingAttachment = { path: string; thumb?: string };

/** Which incoming message a `chat.message` (or one queued) is: its author's, sent at that time. */
export function incomingKey(message: { uid: string; sentAt?: number }): string {
  return `${message.uid}:${message.sentAt}`;
}

/** Someone with the chat open right now, and in how many windows (or devices). */
export interface Presence {
  uid: string;
  windows: number;
}

/** Browser → ChatAgent over the chat WebSocket. */
export type ChatClientMessage =
  // `attachments` were uploaded first, with POST /api/chats/:id/attachments; `text` may then be empty.
  // `mentions` are the files, artifacts and people picked with "@" whose text is still in `text`.
  // `replyTo` is the transcript entry of the message it answers: a person's message, or one of the agent's replies.
  | { type: "prompt"; text: string; attachments?: AttachmentInput[]; mentions?: MentionInput[]; replyTo?: number }
  // Stop the chat: pi and every agent, with what waits for them; with `agent`, only that agent of the roster.
  | { type: "abort"; agent?: string }
  // Add (`on`) or take back a reaction (shared/reactions.ts) to a transcript entry: a person's message or the agent's reply.
  | { type: "react"; entry: number; emoji: string; on: boolean }
  // Run the chat on another model or effort (shared/models.ts), or on Auto (AUTO_MODEL). The change reaches every socket
  // as pi's agent_changed, and a turn to or from Auto as `auto`.
  | { type: "model"; model: string; thinkingLevel?: string };

/**
 * ChatAgent → browser. `events` carries pi-durable AgentEvents verbatim; `people` comes on connect and whenever the people or invites change.
 * A snapshot taken mid-run comes with `runElapsedMs`: how long ago, by the server's clock, the run's first message was
 * placed, which the snapshot does not say, and `toolsElapsedMs`: how long each of its running calls has run, by call id.
 * Durations rather than times, so the browser's clock need not agree.
 */
export type ChatServerMessage =
  /** `queued`, with a snapshot or a batch that changes pi's inbox: the people's messages waiting in it, oldest first. */
  | { type: "events"; events: unknown[]; runElapsedMs?: number; toolsElapsedMs?: Record<string, number>; queued?: QueuedMessage[] }
  | { type: "people"; people: ChatPeopleView }
  /** Everyone's reactions on connect; then, whenever one changes, its entry's (`entry`, `reactions` all of that entry's). */
  | { type: "reactions"; reactions: Reactions }
  | { type: "reacted"; entry: number; reactions: EntryReactions }
  /** Who has the chat open: whenever a window opens or closes. */
  | { type: "presence"; online: Presence[] }
  /**
   * The messages the chat is getting ready to put in, oldest first: on connect, and whenever one comes or goes.
   * `placed`: the one that went, when it went in (it shows in the transcript or the queue next), not when it was dropped.
   */
  | { type: "incoming"; incoming: IncomingMessage[]; placed?: string }
  /** Whether the chat is on Auto (shared/models.ts AUTO_MODEL): on connect, and whenever someone turns it on or off. */
  | { type: "auto"; on: boolean }
  /**
   * To the author of a message in a shared chat that did not call the agent, but looks meant for it ("pi, can you…"):
   * its transcript entry, under which the app offers to call the agent on it.
   */
  | { type: "callHint"; entry: number }
  /** The chat's agents besides pi (shared/agents.ts): on connect, and whenever one is added, removed, starts or ends a turn. */
  | { type: "agents"; agents: ChatAgentView[] }
  /** Sent just before the chat closes a removed person's socket, in case the close code is lost on the way. */
  | { type: "removed" }
  /** Sent to everyone just before the chat closes their sockets, when its owner deleted it. */
  | { type: "deleted" }
  | { type: "error"; message: string };

/** The close code of a chat socket whose user is not (or no longer) in the chat: the app stops reconnecting. */
export const SOCKET_NOT_A_MEMBER = 4403;

/**
 * The keep-alive a chat or sidebar socket sends while it is quiet, and the answer it gets. The Durable Object's
 * runtime answers it (setWebSocketAutoResponse), so it never wakes the object.
 */
export const SOCKET_PING = { request: "ping", response: "pong", everyMs: 30_000 } as const;

/**
 * How often a chat stores a streaming answer and running tool output, which is how they reach the browsers. Each
 * store writes about seven SQLite rows: at pi's default of 100 ms a question wrote some 8,600. The app reveals each
 * step's new text over this time, until the next step comes (useRevealedText).
 */
export const STREAM_STEP_MS = 1_000;

/** The minimum polling interval a page can ask for, as at Claude. */
export const MIN_REFETCH_MS = 30_000;

/** Lowercase hex ids: artifact ids and chat ids. */
export const ID_PATTERN = /^[a-z0-9]{8,32}$/;
/** User ids: the hashed Cloudflare Access subject, or in demo mode a slug of the name typed at sign-in. */
export const UID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;
