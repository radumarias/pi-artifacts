import { createContext, useContext, type CSSProperties } from "react";
import type { AgentColor } from "../../shared/agents.ts";
import { AGENT_NAME } from "../../shared/mentions.ts";
import { everyone, type ChatPeople } from "../../shared/protocol.ts";

/** How many colours people in a shared chat get (--person-0 to --person-7 in styles.css). */
const TINTS = 8;

/**
 * Each person's colour in a shared chat, the same in every window: by their place in the chat (the owner first, then
 * members as they joined), so up to eight people never share one; someone no longer in it gets one from their uid.
 */
export function tintOf(people: ChatPeople, uid: string): number {
  const place = everyone(people).findIndex((person) => person.uid === uid);
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

/** Another agent's badge than pi's: its own letters on its own colour. */
export interface AgentBadge {
  avatar: string;
  color: AgentColor;
}

/** An agent's badge, pi's unless `badge` says another's: square-cornered where a person's is round. `working` adds a dot while it runs. */
export function AgentAvatar({ working = false, badge }: { working?: boolean; badge?: AgentBadge }) {
  return (
    <span
      className={badge ? "avatar agent toned" : "avatar agent"}
      style={badge && ({ "--tone": `var(--agent-${badge.color})` } as CSSProperties)}
      aria-hidden="true"
    >
      {badge ? badge.avatar : "π"}
      {working && <i className="presence working" />}
    </span>
  );
}

/** An agent's badge and name, over its replies: pi's, or another's with `badge` and what `note` says of the reply. */
export function AgentByline({ name = AGENT_NAME, badge, note = "agent" }: { name?: string; badge?: AgentBadge; note?: string }) {
  return (
    <div className="byline agent">
      <AgentAvatar badge={badge} />
      <strong>{badge ? `@${name}` : name}</strong>
      <small>{note}</small>
    </div>
  );
}

function initial(name: string): string {
  return [...name.trim()][0]?.toUpperCase() ?? "?";
}
