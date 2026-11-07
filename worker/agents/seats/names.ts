import { AGENT_NAME_PATTERN, copyName, RESERVED_AGENT_NAMES } from "../../../shared/agents.ts";

/**
 * The chat of its owner's whose object a member's agent has its seats in: one per agent, apart from the owner's own
 * chats (no route reaches a chat id with a hyphen). The agent's own home conversation can take this over.
 */
export function seatChatId(agentId: string): string {
  return `seat-${agentId}`;
}

/**
 * A member's agent's handle in a chat: its own name when free there, else that name with its owner's first name
 * ("planner-ana"), else with a number. Null when none fits.
 */
export function memberAgentName(name: string, ownerName: string, taken: (name: string) => boolean): string | null {
  if (!taken(name)) return name;
  const first =
    ownerName
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(" ")[0] ?? "";
  const alias = `${name.slice(0, Math.max(2, 23 - first.length))}-${first}`.slice(0, 24).replace(/-+$/, "");
  if (first && AGENT_NAME_PATTERN.test(alias) && !RESERVED_AGENT_NAMES.has(alias) && !taken(alias)) return alias;
  return copyName(name, taken);
}
