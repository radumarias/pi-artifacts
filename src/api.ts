import type {
  ArtifactVersionImport,
  ChatDumpCursor,
  ChatImportStart,
  ExportedChat,
  ExportedPageValues,
  ExportedSkill,
  ExportedSkillFiles,
  ExportStart,
  ImportedSettings,
  ImportPlan,
  ImportPlanRequest,
} from "../shared/data-export.ts";
import { formatCursor, NEXT_PART_HEADER, parseCursor } from "../shared/data-export.ts";
import type { MentionOptions } from "../shared/mentions.ts";
import type { ModelCatalog } from "../shared/models.ts";
import type { ChatSystemPrompt } from "../shared/system-prompt.ts";
import { skillPath, type SkillInfo, type SkillInput } from "../shared/skills.ts";
import { FILE_ROUTE, VIEW_PARAM, ZIP_ROUTE } from "../shared/uploads.ts";
import {
  SEAT_PARAM,
  SECOND_SEAT,
  SOCKET_PING,
  type ArtifactMeta,
  type ArtifactSummary,
  type ArtifactView,
  type ChatContents,
  type ChatDeletion,
  type ChatSummary,
  type CloneAccess,
  type CreatedInvite,
  type PageAiRequest,
  type PageAiResponse,
  type PageStorageRequest,
  type PageStorageResponse,
  type ProxyRequest,
  type ProxyResponse,
  type DeclaredTool,
} from "../shared/protocol.ts";

export type { ArtifactSummary };

export interface Me {
  uid: string;
  email?: string;
  auth: "access" | "demo";
}

export interface FileInfo {
  path: string;
  size: number;
}

/** The response and its JSON body, whatever the status; a body that is not JSON reads as null. */
async function fetchJson(path: string, init?: RequestInit): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(path, init);
  return { response, body: await response.json().catch(() => null) };
}

/** The error a failed response stands for: the Worker's message from its JSON body, else the status (HTTP/2 has no status text). */
const responseError = (response: Response, body: unknown) =>
  Object.assign(new Error((body as { error?: string } | null)?.error ?? (response.statusText || `HTTP ${response.status}`)), {
    status: response.status,
  });

/** Whether this window sits in its chat as the owner's second seat (secondSeat), which its URL says. */
export function inSecondSeat(search = location.search): boolean {
  return new URLSearchParams(search).get(SEAT_PARAM) === SECOND_SEAT;
}

const SEAT_QUERY = `?${SEAT_PARAM}=${SECOND_SEAT}`;

/** Where the owner's second seat in a chat opens. */
export const secondSeatPath = (chatId: string) => `/c/${chatId}${SEAT_QUERY}`;

/**
 * The URL of one of the open chat's routes: from a second seat's window, as that seat. Only the chat the window shows:
 * the sidebar beside it is the owner's.
 */
function chatPath(chatId: string, rest: string): string {
  const seated = location.pathname === `/c/${chatId}` && inSecondSeat();
  return `/api/chats/${chatId}${rest}${seated ? SEAT_QUERY : ""}`;
}

/** The JSON body of a successful response; otherwise throws with the Worker's error message. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { response, body } = await fetchJson(path, init);
  if (!response.ok) throw responseError(response, body);
  return body as T;
}

/** An upload's form: a `file` and a `path` field per file, in order (see worker/files-routes.ts). */
function uploadForm(files: readonly { file: File; path: string }[]): FormData {
  const form = new FormData();
  for (const { file, path } of files) {
    form.append("file", file);
    form.append("path", path);
  }
  return form;
}

/**
 * Ping `ws` while it is open: between messages a socket can stay quiet for hours, and proxies close a quiet socket.
 * The Durable Object's runtime answers the ping (SOCKET_PING) without waking the object; a reconnect would wake it.
 */
export function keepAlive(ws: WebSocket): void {
  const timer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(SOCKET_PING.request), SOCKET_PING.everyMs);
  ws.addEventListener("close", () => clearInterval(timer));
}

const socketUrl = (path: string) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

const send = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const post = (body: unknown) => send("POST", body);

/** A page's call through the Worker: its answer, errors included (`ok: false`); throws only when the request itself fails. */
async function pageCall<T extends { ok: boolean }>(path: string, body: unknown): Promise<T> {
  const { response, body: answer } = await fetchJson(path, post(body));
  if (answer && typeof (answer as T).ok === "boolean") return answer as T;
  throw new Error(`The Worker answered ${response.status}`);
}

export const api = {
  /** The signed-in user, or null with the Worker's auth mode when nobody is. */
  me: async (): Promise<{ me: Me | null; auth: Me["auth"] }> => {
    const { response, body } = await fetchJson("/api/me");
    const me = (body ?? {}) as Partial<Me>;
    const auth = me.auth === "demo" ? "demo" : "access";
    return response.ok && me.uid ? { me: me as Me, auth } : { me: null, auth };
  },
  signIn: (name: string) => request<{ uid: string }>("/api/session", post({ name })),
  signOut: () => request<object>("/api/session", { method: "DELETE" }),
  chats: () => request<ChatSummary[]>("/api/chats"),
  createChat: () => request<ChatSummary>("/api/chats", { method: "POST" }),
  /** The user has seen the chat: it is no longer unread in their sidebar. `seenAt`: when they had last seen it, if something came in since. */
  markSeen: (chatId: string) => request<{ seenAt?: number }>(`/api/chats/${chatId}/seen`, { method: "POST" }),
  /** The user stopped looking at the chat (left it, or hid the window): what it showed them is read. Sent also as the page closes. */
  leftChat: (chatId: string) => request<object>(`/api/chats/${chatId}/seen?left`, { method: "POST", keepalive: true }),
  /** What deleting a chat would delete with it. Only for its owner. */
  chatDeletion: (chatId: string) => request<ChatDeletion>(`/api/chats/${chatId}/deletion`),
  /** Delete a chat for everyone in it, with its artifacts and those of its files in `files` (from chatDeletion). Only for its owner. */
  deleteChat: (chatId: string, files: readonly string[]) => request<object>(`/api/chats/${chatId}`, send("DELETE", { files })),
  createInvite: (chatId: string) => request<CreatedInvite>(`/api/chats/${chatId}/invites`, post({})),
  revokeInvite: (chatId: string, inviteId: string) => request<object>(`/api/chats/${chatId}/invites/${inviteId}`, { method: "DELETE" }),
  /** The owner removes a member; a member passes their own uid to leave. */
  removeMember: (chatId: string, uid: string) => request<object>(chatPath(chatId, `/members/${uid}`), { method: "DELETE" }),
  /** The owner joins their chat a second time, as a member (secondSeat); open it at secondSeatPath. */
  joinSecondSeat: (chatId: string) => request<object>(`/api/chats/${chatId}/seat`, post({})),
  acceptInvite: (token: string) => request<{ chatId: string }>("/api/invites/accept", post({ token })),
  artifacts: () => request<ArtifactSummary[]>("/api/artifacts"),
  models: () => request<ModelCatalog>("/api/models"),
  /** Ask AI Gateway's providers for their models again now (at most once a minute; sooner gives the last answer). */
  refreshModels: () => request<ModelCatalog>("/api/models", { method: "POST" }),
  /** `withChat`: also the chat that builds it, if the user is in that chat, to go back to it. */
  artifact: (id: string, withChat = false) => request<ArtifactView>(`/api/artifacts/${id}${withChat ? "?chat" : ""}`),
  /** The owner opened `version` of their artifact: it is no longer new in their sidebar. */
  markArtifactSeen: (id: string, version: number) => request<object>(`/api/artifacts/${id}/seen`, post({ version })),
  artifactTools: (id: string, version: number) => request<DeclaredTool[]>(`/api/artifacts/${id}/tools?version=${version}`),
  cloneAccess: (id: string) => request<CloneAccess>(`/api/artifacts/${id}/clone`, post({})),
  /** Where `version` of an artifact's page is served, for the viewer to frame. */
  artifactPageUrl: (id: string, version: number) => `/u/${id}/v${version}`,
  /** Where `version` of an artifact is served as plain text, as the agent wrote it: without the runtime its page gets, nothing in it runs. */
  artifactSourceUrl: (id: string, version: number) => `${api.artifactPageUrl(id, version)}/source`,
  /** That source's text. Throws with the status when it cannot be read. */
  artifactSource: async (id: string, version: number, signal?: AbortSignal): Promise<string> => {
    const response = await fetch(api.artifactSourceUrl(id, version), { signal });
    if (!response.ok) throw responseError(response, await response.json().catch(() => null));
    return response.text();
  },
  /** Resolves with the Worker's ProxyResponse, errors included; rejects only when the request itself fails. */
  proxy: (id: string, call: ProxyRequest) => pageCall<ProxyResponse>(`/api/artifacts/${id}/mcp`, call),
  /** A page's saved values for this viewer (pi.use("storage")). Resolves with errors too; rejects only when the request fails. */
  pageStorage: (id: string, request: PageStorageRequest) => pageCall<PageStorageResponse>(`/api/artifacts/${id}/storage`, request),
  /** One answer from the page's model (pi.use("ai")), paid for by this viewer. */
  pageAi: (id: string, request: PageAiRequest) => pageCall<PageAiResponse>(`/api/artifacts/${id}/ai`, request),
  /** The user's own system prompt, added to the built-in one in all their chats. Always theirs to change. */
  systemPrompt: () => request<ChatSystemPrompt>("/api/me/system-prompt"),
  /** Save it; empty clears it. */
  setSystemPrompt: (text: string) => request<ChatSystemPrompt>("/api/me/system-prompt", send("PUT", { text })),
  /** A chat's system prompt, which adds to its owner's own: everyone in the chat reads it, only the owner changes it. */
  chatSystemPrompt: (chatId: string) => request<ChatSystemPrompt>(chatPath(chatId, "/system-prompt")),
  setChatSystemPrompt: (chatId: string, text: string) => request<ChatSystemPrompt>(chatPath(chatId, "/system-prompt"), send("PUT", { text })),
  skills: () => request<SkillInfo[]>("/api/skills"),
  /** Save one of the user's skills, from its fields or from a SKILL.md file's text. */
  saveSkill: (skill: (SkillInput | { markdown: string }) & { enabled?: boolean }) => request<SkillInfo>("/api/skills", post(skill)),
  /** `updatedAt` is the version the user read; the server refuses to turn on a skill that changed since. */
  setSkillEnabled: (skill: SkillInfo, enabled: boolean) =>
    request<SkillInfo>(skillPath(skill), send("PATCH", { enabled, updatedAt: skill.updatedAt || undefined })),
  deleteSkill: (skill: SkillInfo) => request<object>(skillPath(skill), { method: "DELETE" }),
  skillMarkdownUrl: (skill: SkillInfo) => `${skillPath(skill)}/SKILL.md`,
  /** Import a skill package: a zip with its SKILL.md and files. Says which files it left out, and why. */
  importSkillPackage: (zip: File) =>
    request<SkillInfo & { skipped: string[] }>("/api/skills/import", { method: "POST", headers: { "content-type": "application/zip" }, body: zip }),
  files: () => request<FileInfo[]>("/api/files"),
  /**
   * Where a user file is served: an image opens in the browser, anything else downloads. `base` is where the files are
   * served from: the user's own (FILE_ROUTE), or a chat's for someone it is shared with (chatFileRoute).
   */
  fileUrl: (path: string, base = FILE_ROUTE) => base + encodePath(path),
  /** Where a user file shows in the browser, if it is of a kind the app previews (shared/uploads.ts viewType); otherwise it downloads. */
  fileViewUrl: (path: string, base = FILE_ROUTE) => `${base}${encodePath(path)}?${VIEW_PARAM}`,
  /**
   * The first `bytes` of a user file (all of a shorter one), to read as they arrive; null for an empty file, which
   * has no first byte to give. Throws with the Worker's error when it cannot be read.
   */
  fileStart: async (path: string, bytes: number, signal?: AbortSignal, base = FILE_ROUTE): Promise<ReadableStream<Uint8Array> | null> => {
    const response = await fetch(api.fileUrl(path, base), { signal, headers: { range: `bytes=0-${bytes - 1}` } });
    if (response.status === 416) return null;
    if (!response.ok || !response.body) throw responseError(response, await response.json().catch(() => null));
    return response.body;
  },
  /** Where a user folder downloads as a zip named after it, with the folder itself at its root. */
  folderZipUrl: (path: string) => ZIP_ROUTE + encodePath(path),
  /** Delete the user's own files and folders, each folder with everything under it. */
  deleteFiles: (files: readonly string[], folders: readonly string[]) => request<object>("/api/files", send("DELETE", { files, folders })),
  /** One request's worth of files (see uploadBatches), each with its name or its path inside a picked folder. */
  upload: (files: readonly { file: File; path: string }[]) => request<{ paths: string[] }>("/api/files", { method: "POST", body: uploadForm(files) }),
  /** Files for a chat message, stored under uploads/ in the chat owner's files; send the paths with the message. */
  attach: (chatId: string, files: readonly { file: File; path: string }[]) =>
    request<{ paths: string[] }>(chatPath(chatId, "/attachments"), { method: "POST", body: uploadForm(files) }),
  /** For someone a chat is shared with: what it holds of its owner's, its files and artifacts. */
  chatContents: (chatId: string) => request<ChatContents>(chatPath(chatId, "/contents")),
  /** What "@" offers in a chat's composer: the files and artifacts the chat's agent can open. */
  mentions: (chatId: string) => request<MentionOptions>(chatPath(chatId, "/mentions")),
  chatSocketUrl: (chatId: string) => socketUrl(chatPath(chatId, "/ws")),
  /** The sidebar's socket, which says when the chat list changed. */
  sidebarSocketUrl: () => socketUrl("/api/me/ws"),
};

/** Draft pages as an export carries them (worker/storage/drafts.ts Draft): JSON the import gives back as it came. */
/** A draft as the export holds it: as the Worker stores it (worker/storage/drafts.ts). */
export type DraftJson = Record<string, unknown>;

/** A GET's body as a blob, or null when it is not there (404); throws with the Worker's error otherwise. */
export async function fetchBlob(url: string): Promise<{ blob: Blob; response: Response } | null> {
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw responseError(response, await response.json().catch(() => null));
  return { blob: await response.blob(), response };
}

/** Export and import of everything the user has, a piece at a time (worker/data-routes.ts, src/data/). */
export const dataApi = {
  exportStart: () => request<ExportStart>("/api/me/export"),
  /** One part of a chat's storage as its JSON (a ChatDumpPart), kept as a blob, and where the next part starts. */
  exportChatPart: async (chatId: string, cursor?: ChatDumpCursor): Promise<{ part: Blob; next?: ChatDumpCursor }> => {
    const fetched = await fetchBlob(`/api/me/export/chats/${chatId}${cursor ? `?cursor=${formatCursor(cursor)}` : ""}`);
    if (!fetched) throw new Error("The chat is gone.");
    return { part: fetched.blob, next: parseCursor(fetched.response.headers.get(NEXT_PART_HEADER)) };
  },
  exportDrafts: (chatId: string) => request<DraftJson[]>(`/api/me/export/chats/${chatId}/drafts`),
  exportArtifact: (id: string) => request<ArtifactMeta>(`/api/me/export/artifacts/${id}`),
  exportSkillFiles: (name: string) => request<ExportedSkillFiles>(`/api/me/export/skills/${name}`),
  plan: (body: ImportPlanRequest) => request<ImportPlan>("/api/me/import/plan", post(body)),
  importSettings: (settings: ImportedSettings) => request<{ applied: string[] }>("/api/me/import/account", post(settings)),
  importSkill: (skill: ExportedSkill, files: ExportedSkillFiles["files"]) => request<{ skipped?: string }>("/api/me/import/skills", post({ skill, files })),
  /** One file at its own path; `skipped` when there is one there already. */
  importFile: (path: string, body: Blob) => request<{ skipped?: true }>(`/api/me/import/files/${encodePath(path)}`, { method: "PUT", body }),
  importChatBegin: (chatId: string, start: ChatImportStart) => request<object>(`/api/me/import/chats/${chatId}/begin`, post(start)),
  /** One part, as the export holds it (a ChatDumpPart's JSON). */
  importChatPart: (chatId: string, part: Blob) =>
    request<object>(`/api/me/import/chats/${chatId}/rows`, { method: "POST", headers: { "content-type": "application/json" }, body: part }),
  importChatDrafts: (chatId: string, drafts: DraftJson[]) => request<object>(`/api/me/import/chats/${chatId}/drafts`, post(drafts)),
  importChatFinish: (chatId: string, chat: Pick<ExportedChat, "title" | "createdAt" | "updatedAt">) =>
    request<object>(`/api/me/import/chats/${chatId}/finish`, post(chat)),
  importArtifactVersion: (id: string, version: ArtifactVersionImport) => request<{ latest: number }>(`/api/me/import/artifacts/${id}/versions`, post(version)),
  importPageValues: (values: ExportedPageValues[]) => request<{ imported: number }>("/api/me/import/page-values", post(values)),
};
