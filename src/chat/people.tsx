import { createContext, useContext, type CSSProperties } from "react";
import { AGENT_NAME } from "../../shared/mentions.ts";
import type { ChatPeople } from "../../shared/protocol.ts";

/** How many colours people in a shared chat get (--person-0 to --person-7 in styles.css). */
const TINTS = 8;

/**
 * Each person's colour in a shared chat, the same in every window: by their place in the chat (the owner first, then
 * members as they joined), so up to eight people never share one; someone no longer in it gets one from their uid.
 */
export function tintOf(people: ChatPeople | null, uid: string): number {
  const place = people ? [people.owner, ...people.members].findIndex((person) => person.uid === uid) : -1;
  if (place >= 0) return place % TINTS;
  let hash = 0;
  for (const char of uid) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % TINTS;
}

/** The style that gives an element a person's colour as --tint. */
export function tintStyle(tint: number): CSSProperties {
  return { "--tint": `var(--person-${tint})` } as CSSProperties;
}

/** Who is in the chat, while it is shared: messages are then shown with their author's colour and the agent's name. */
export const SharedChat = createContext<ChatPeople | null>(null);

export function useSharedChat(): ChatPeople | null {
  return useContext(SharedChat);
}

/** A round badge with a person's first letter in their colour; `online` adds a dot for someone with the chat open. */
export function Avatar({ name, tint, online }: { name: string; tint: number; online?: boolean }) {
  return (
    <span className="avatar" style={tintStyle(tint)} aria-hidden="true">
      {initial(name)}
      {online !== undefined && <i className={online ? "presence online" : "presence"} />}
    </span>
  );
}

/** The agent's badge and name, over its replies in a shared chat. */
export function AgentByline() {
  return (
    <div className="byline agent">
      <span className="avatar agent" aria-hidden="true">
        π
      </span>
      <strong>{AGENT_NAME}</strong>
      <small>agent</small>
    </div>
  );
}

function initial(name: string): string {
  return [...name.trim()][0]?.toUpperCase() ?? "?";
}
