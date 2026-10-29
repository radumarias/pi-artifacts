import type { ArtifactSummary, ArtifactView, ChatSummary, CloneAccess, ProxyRequest, ProxyResponse, ToolInfo } from "../shared/protocol.ts";

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

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

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
  artifacts: () => request<ArtifactSummary[]>("/api/artifacts"),
  artifact: (id: string) => request<ArtifactView>(`/api/artifacts/${id}`),
  artifactTools: (id: string, version: number) => request<ToolInfo[]>(`/api/artifacts/${id}/tools?version=${version}`),
  cloneAccess: (id: string) => request<CloneAccess>(`/api/artifacts/${id}/clone`, post({})),
  /** Resolves with the Worker's ProxyResponse, errors included; rejects only when the request itself fails. */
  proxy: async (id: string, call: ProxyRequest): Promise<ProxyResponse> => {
    const { response, body } = await fetchJson(`/api/artifacts/${id}/mcp`, post(call));
    const proxied = body as ProxyResponse | null;
    if (proxied && typeof proxied.ok === "boolean") return proxied;
    throw new Error(`The proxy answered ${response.status}`);
  },
  files: () => request<FileInfo[]>("/api/files"),
  upload: (file: File) => {
    const form = new FormData();
    form.set("file", file);
    return request<{ path: string }>("/api/files", { method: "POST", body: form });
  },
  chatSocketUrl: (chatId: string) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/chats/${chatId}/ws`,
};
