import { skillPath, type SkillInfo, type SkillInput } from "../shared/skills.ts";
import type { ArtifactSummary, ArtifactView, ChatPeopleView, ChatSummary, CloneAccess, CreatedInvite, ProxyRequest, ProxyResponse, DeclaredTool } from "../shared/protocol.ts";

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

/** The JSON body of a successful response; otherwise throws with the Worker's error message. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { response, body } = await fetchJson(path, init);
  if (!response.ok) throw Object.assign(new Error((body as { error?: string } | null)?.error ?? response.statusText), { status: response.status });
  return body as T;
}

const send = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const post = (body: unknown) => send("POST", body);

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
  people: (chatId: string) => request<ChatPeopleView>(`/api/chats/${chatId}/people`),
  createInvite: (chatId: string) => request<CreatedInvite>(`/api/chats/${chatId}/invites`, post({})),
  revokeInvite: (chatId: string, inviteId: string) => request<object>(`/api/chats/${chatId}/invites/${inviteId}`, { method: "DELETE" }),
  /** The owner removes a member; a member passes their own uid to leave. */
  removeMember: (chatId: string, uid: string) => request<object>(`/api/chats/${chatId}/members/${uid}`, { method: "DELETE" }),
  acceptInvite: (token: string) => request<{ chatId: string }>("/api/invites/accept", post({ token })),
  artifacts: () => request<ArtifactSummary[]>("/api/artifacts"),
  artifact: (id: string) => request<ArtifactView>(`/api/artifacts/${id}`),
  artifactTools: (id: string, version: number) => request<DeclaredTool[]>(`/api/artifacts/${id}/tools?version=${version}`),
  cloneAccess: (id: string) => request<CloneAccess>(`/api/artifacts/${id}/clone`, post({})),
  /** Resolves with the Worker's ProxyResponse, errors included; rejects only when the request itself fails. */
  proxy: async (id: string, call: ProxyRequest): Promise<ProxyResponse> => {
    const { response, body } = await fetchJson(`/api/artifacts/${id}/mcp`, post(call));
    const proxied = body as ProxyResponse | null;
    if (proxied && typeof proxied.ok === "boolean") return proxied;
    throw new Error(`The proxy answered ${response.status}`);
  },
  skills: () => request<SkillInfo[]>("/api/skills"),
  /** Save one of the user's skills, from its fields or from a SKILL.md file's text. */
  saveSkill: (skill: (SkillInput | { markdown: string }) & { enabled?: boolean }) => request<SkillInfo>("/api/skills", post(skill)),
  /** `updatedAt` is the version the user read; the server refuses to turn on a skill that changed since. */
  setSkillEnabled: (skill: SkillInfo, enabled: boolean) =>
    request<SkillInfo>(skillPath(skill), send("PATCH", { enabled, updatedAt: skill.updatedAt || undefined })),
  deleteSkill: (skill: SkillInfo) => request<object>(skillPath(skill), { method: "DELETE" }),
  skillMarkdownUrl: (skill: SkillInfo) => `${skillPath(skill)}/SKILL.md`,
  files: () => request<FileInfo[]>("/api/files"),
  upload: (file: File) => {
    const form = new FormData();
    form.set("file", file);
    return request<{ path: string }>("/api/files", { method: "POST", body: form });
  },
  chatSocketUrl: (chatId: string) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/chats/${chatId}/ws`,
};
