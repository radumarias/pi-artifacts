import { AGENT_ID_PATTERN } from "../../shared/agents.ts";
import { ID_PATTERN } from "../../shared/protocol.ts";

/** Where an agent's page opens: on one of its tabs and fields, from a chat (`chat`: back to it, or a shared agent of it). */
export interface AgentPlace {
  /** An agent's id, or "new" for the form of a new one. */
  id: string;
  tab?: string;
  /** A field to scroll to and focus: what a draft card's Change opens. */
  field?: string;
  /** The chat it was opened from: a link back to it, and for someone else's agent the chat that shares it. */
  chat?: string;
}

export const NEW_AGENT = "new";

/** The page's path for `place`. */
export function agentPath({ id, tab, field, chat }: AgentPlace): string {
  const query = new URLSearchParams({ ...(tab && { tab }), ...(field && { field }), ...(chat && { chat }) }).toString();
  return `/agents/${id}${query ? `?${query}` : ""}`;
}

/** The place a URL of the app names, if it is an agent's page. */
export function agentPlace(url: URL): AgentPlace | null {
  const id = url.pathname.match(/^\/agents\/([^/]+)$/)?.[1];
  if (!id || (id !== NEW_AGENT && !AGENT_ID_PATTERN.test(id))) return null;
  const param = (name: string) => url.searchParams.get(name) ?? undefined;
  const chat = param("chat");
  return { id, tab: param("tab"), field: param("field"), chat: chat && ID_PATTERN.test(chat) ? chat : undefined };
}

/**
 * Go to `path` in the app from somewhere without its navigate (a card deep in a chat): the app follows the history's
 * popstate, as for Back.
 */
export function goTo(path: string): void {
  if (new URL(path, location.href).href !== location.href) history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}
