// Types shared by the Worker, the React app and the artifact page runtime.
// The MCP shapes mirror the contract Claude's artifacts use, so pages written
// for one read naturally against the other.

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
}

/** An artifact as GET /api/artifacts/:id returns it: everything but the chat it lives in. */
export type ArtifactView = Omit<ArtifactMeta, "chatId"> & { isOwner: boolean };

/** A read-only Git token for one artifact's repo (POST /api/artifacts/:id/clone). */
export interface CloneAccess {
  remote: string;
  token: string;
  expiresAt: string;
}

/** The tool that publishes an artifact, and the details its result carries: the chat UI opens the preview from them. */
export const PUBLISH_TOOL = "artifact_publish";
export interface PublishedDetails {
  artifactId: string;
  version: number;
  title: string;
}

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Set on a chat someone else owns and invited you to: their name. */
  sharedBy?: string;
}

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
}

/** Browser → ChatAgent over the chat WebSocket. */
export type ChatClientMessage = { type: "prompt"; text: string } | { type: "abort" };

/** ChatAgent → browser. `events` carries pi-durable AgentEvents verbatim; `people` comes on connect and whenever the people or invites change. */
export type ChatServerMessage =
  | { type: "events"; events: unknown[] }
  | { type: "people"; people: ChatPeopleView }
  | { type: "error"; message: string };

/** The close code of a chat socket whose user is not (or no longer) in the chat: the app stops reconnecting. */
export const SOCKET_NOT_A_MEMBER = 4403;

/** The minimum polling interval a page can ask for, as at Claude. */
export const MIN_REFETCH_MS = 30_000;

/** Lowercase hex ids: artifact ids and chat ids. */
export const ID_PATTERN = /^[a-z0-9]{8,32}$/;
/** User ids: the hashed Cloudflare Access subject, or in demo mode a slug of the name typed at sign-in. */
export const UID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;
