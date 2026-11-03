// Types shared by the Worker, the React app and the artifact page runtime.
// The MCP shapes mirror the contract Claude's artifacts use, so pages written
// for one read naturally against the other.

import type { Attachment, AttachmentInput } from "./attachments.ts";
import type { Mention, MentionInput } from "./mentions.ts";

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
  status?: ChatStatus;
  /** Set when the chat has a reply, or someone else's message, that this user has not seen yet. */
  unread?: true;
}

/** What the sidebar's socket (GET /api/me/ws) sends: the name of a list that changed, so the app reads it again. */
export type SidebarList = "chats" | "artifacts" | "skills";

/** Someone in a chat: a verified uid, and the name the others see (their email, or the demo name). */
export interface Person {
  uid: string;
  name: string;
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
  /** Files and artifacts the message names with "@" (see shared/mentions.ts). */
  mentions?: Mention[];
}

/**
 * A notice in the transcript that someone joined or left a shared chat. A passive entry: everyone sees it at once,
 * even mid-run, and the model never reads it (it learns who is in the chat from its prompt).
 */
export const CHAT_PEOPLE_KIND = "chat.people";
export interface ChatPeopleData extends Person {
  /** `rejoined`: someone already in the chat opened an invite link to it, in another window or on another device. */
  event: "joined" | "rejoined" | "left" | "removed";
}

/** A message waiting for the agent: sent while it was busy, in the order it will be answered. `id` is pi's submission id. */
export interface QueuedMessage extends ChatMessageData {
  id: number;
}

/** Someone with the chat open right now, and in how many windows (or devices). */
export interface Presence {
  uid: string;
  windows: number;
}

/** Browser → ChatAgent over the chat WebSocket. */
export type ChatClientMessage =
  // `attachments` were uploaded first, with POST /api/chats/:id/attachments; `text` may then be empty.
  // `mentions` are the files and artifacts picked with "@" whose text is still in `text`.
  | { type: "prompt"; text: string; attachments?: AttachmentInput[]; mentions?: MentionInput[] }
  | { type: "abort" }
  // Run the chat on another model or effort (shared/models.ts). The change reaches every socket as pi's agent_changed.
  | { type: "model"; model: string; thinkingLevel?: string };

/**
 * ChatAgent → browser. `events` carries pi-durable AgentEvents verbatim; `people` comes on connect and whenever the people or invites change.
 * A snapshot taken mid-run comes with `runElapsedMs`: how long ago, by the server's clock, the run's first message was
 * placed, which the snapshot does not say. A duration rather than a time, so the browser's clock need not agree.
 */
export type ChatServerMessage =
  /** `queued`, with a snapshot or a batch that changes pi's inbox: the people's messages waiting in it, oldest first. */
  | { type: "events"; events: unknown[]; runElapsedMs?: number; queued?: QueuedMessage[] }
  | { type: "people"; people: ChatPeopleView }
  /** Who has the chat open: whenever a window opens or closes. */
  | { type: "presence"; online: Presence[] }
  /** Sent just before the chat closes a removed person's socket, in case the close code is lost on the way. */
  | { type: "removed" }
  /** Sent to everyone just before the chat closes their sockets, when its owner deleted it. */
  | { type: "deleted" }
  | { type: "error"; message: string };

/** The close code of a chat socket whose user is not (or no longer) in the chat: the app stops reconnecting. */
export const SOCKET_NOT_A_MEMBER = 4403;

/** The minimum polling interval a page can ask for, as at Claude. */
export const MIN_REFETCH_MS = 30_000;

/** Lowercase hex ids: artifact ids and chat ids. */
export const ID_PATTERN = /^[a-z0-9]{8,32}$/;
/** User ids: the hashed Cloudflare Access subject, or in demo mode a slug of the name typed at sign-in. */
export const UID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;
