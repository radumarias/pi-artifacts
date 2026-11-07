import { baseName } from "./attachments.ts";
import { ID_PATTERN, UID_PATTERN } from "./protocol.ts";
import { MAX_PATH } from "./uploads.ts";

/**
 * Files, artifacts and people named in a message with "@". The composer offers
 * them as the user types "@", puts `@<path>`, `@<title>` or `@<name>` in the
 * text, and sends the picks with the message, so the agent gets the exact path
 * or artifact id however the text reads, and a person tagged hears of it. The
 * text itself stays as the user wrote it.
 */

/**
 * What the browser sends: a file by its path in the chat owner's files (or, with `own`, in the author's own files, for
 * someone the chat is shared with: the chat copies it to the owner's), an artifact by its id, a person in a shared chat
 * by their uid (they are told they were tagged).
 */
export type MentionInput = { kind: "file"; path: string; own?: true } | { kind: "artifact"; id: string } | { kind: "person"; uid: string };

/** A mention as the message's transcript entry records it. A type, not an interface, so it is JSON pi can store. */
export type Mention =
  | { kind: "file"; path: string; own?: true }
  | { kind: "artifact"; id: string; title: string }
  | { kind: "person"; uid: string; name: string };

/**
 * What the composer offers after "@", from GET /api/chats/:id/mentions. `own` files are the author's, offered to
 * someone the chat is shared with besides the chat's own files.
 */
export interface MentionOptions {
  files: { path: string; size: number; own?: true }[];
  artifacts: { id: string; title: string; latest: number; chatId: string }[];
}

/** The agent's name, as the chat shows it. */
export const AGENT_NAME = "pi";
/** How a message in a shared chat calls the agent; any other message there is people talking among themselves. */
export const AGENT_TOKEN = `@${AGENT_NAME}`;
/**
 * "@name" as a word: not inside an address ("x@pi.dev"), a longer name ("@pierre") or a path ("@pi/notes.md"). The
 * first group is what comes before the "@". How "@pi" is found, and the chat's other agents by their names.
 */
export function callPattern(name: string, flags = "i"): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  return new RegExp(`(^|[^\\w@.])@${escaped}(?![\\w/@-]|\\.\\w)`, flags);
}

/**
 * The names among `names` the text calls with "@name", outside the files and artifacts it names (a file "pi notes.md"
 * calls no one), in the order it first calls them.
 */
export function calledNames(text: string, names: readonly string[], mentions: readonly Mention[] = []): string[] {
  const found: { name: string; at: number }[] = [];
  let offset = 0;
  for (const part of splitMentions(text, mentions)) {
    if (typeof part !== "string") {
      offset += mentionToken(part).length;
      continue;
    }
    for (const name of names) {
      if (found.some((hit) => hit.name === name)) continue;
      const match = callPattern(name).exec(part);
      if (match) found.push({ name, at: offset + match.index + match[1].length });
    }
    offset += part.length;
  }
  return found.sort((a, b) => a.at - b.at).map(({ name }) => name);
}

/** Whether a message calls the agent ("@pi"), outside the files and artifacts it names (a file "pi notes.md" is not it). */
export function summonsAgent(text: string, mentions: readonly Mention[] = []): boolean {
  return calledNames(text, [AGENT_NAME], mentions).length > 0;
}

/**
 * The text split into plain runs and the calls in it: "@pi", and "@name" for each of `names` (the chat's other agents),
 * as typed ("@PI" stays so), with the name each one calls, for the transcript to show them as chips.
 */
export function splitCalls(text: string, names: readonly string[] = []): { text: string; call?: string }[] {
  const hits: { at: number; end: number; name: string }[] = [];
  for (const name of [AGENT_NAME, ...names]) {
    for (const match of text.matchAll(callPattern(name, "gi"))) {
      const at = match.index + match[1].length;
      hits.push({ at, end: at + name.length + 1, name });
    }
  }
  hits.sort((a, b) => a.at - b.at);
  const parts: { text: string; call?: string }[] = [];
  let plain = 0;
  for (const hit of hits) {
    if (hit.at < plain) continue;
    if (hit.at > plain) parts.push({ text: text.slice(plain, hit.at) });
    parts.push({ text: text.slice(hit.at, hit.end), call: hit.name });
    plain = hit.end;
  }
  if (plain < text.length) parts.push({ text: text.slice(plain) });
  return parts;
}

/** An agent as the "@" picker offers it: its handle and job line, for matching; pi's only by its handle (`handleOnly`). */
export interface AgentChoice {
  name: string;
  job: string;
  handleOnly?: boolean;
}

/** How well an agent matches a picker query (lowercase): 4 its handle starts with it, 3 a job word does, 2 and 1 hold it. */
function agentScore({ name, job, handleOnly }: AgentChoice, q: string): number {
  if (!q) return 1;
  if (name.startsWith(q)) return 4;
  if (handleOnly) return name.includes(q) ? 2 : 0;
  const words = job.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  if (words.some((word) => word.startsWith(q))) return 3;
  if (name.includes(q)) return 2;
  return job.toLowerCase().includes(q) ? 1 : 0;
}

/**
 * The agents the "@" picker offers for `query`, best first: handles that start with it, then handles or job lines with a
 * word that does, then those that hold it anywhere. An empty query offers them all, in the roster's order (pi first
 * when it is among them). Case does not matter.
 */
export function matchAgents<T extends AgentChoice>(agents: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  return agents
    .map((agent, order) => ({ agent, order, score: agentScore(agent, q) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ agent }) => agent);
}

/**
 * What the "@" picker lists for `query`: the agents (matchAgents), then people, artifacts and files (matchMentions). A
 * person whose name starts with the query comes before agents whose handles do not, so "@th" tags Thomas rather than
 * calling an agent whose job line has "the".
 */
export function matchPicks<T extends AgentChoice>(agents: readonly T[], choices: readonly MentionChoice[], query: string): (T | MentionChoice)[] {
  const q = query.trim().toLowerCase();
  const found = matchAgents(agents, query);
  const mentions = matchMentions(choices, query);
  const named = (choice: MentionChoice) => choice.mention.kind === "person" && score(mentionLabel(choice.mention), q) === 4;
  if (!q || !mentions.some(named) || found.some((agent) => agent.name.startsWith(q))) return [...found, ...mentions];
  const people = mentions.filter((choice) => choice.mention.kind === "person");
  return [...people, ...found, ...mentions.filter((choice) => choice.mention.kind !== "person")];
}

/** Mentions one message may carry. */
export const MAX_MENTIONS = 20;

/** What a mention reads as in the text: "@" and the file's path, the artifact's title, or the person's name. */
export function mentionLabel(mention: Mention): string {
  return mention.kind === "file" ? mention.path : mention.kind === "artifact" ? mention.title : mention.name;
}

export function mentionToken(mention: Mention): string {
  return `@${mentionLabel(mention)}`;
}

/** The same file, artifact or person. */
export function sameMention(a: MentionInput, b: MentionInput): boolean {
  if (a.kind === "file") return b.kind === "file" && a.path === b.path && !a.own === !b.own;
  if (a.kind === "artifact") return b.kind === "artifact" && a.id === b.id;
  return b.kind === "person" && a.uid === b.uid;
}

/** The people a message tags, by uid. */
export function taggedPeople(mentions: readonly Mention[] = []): string[] {
  return mentions.flatMap((mention) => (mention.kind === "person" ? [mention.uid] : []));
}

/** The longest "@query" the picker follows; longer, and it was not a mention. */
const MAX_QUERY = 80;

/**
 * The "@" being typed at the caret, if any: where it starts and what follows it.
 * An "@" counts at the start of the text or after a space or line break, so an
 * email address does not open the picker. Paths and titles hold spaces, so the
 * query may too, but not a line break.
 */
export function activeQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start < 0 || (start > 0 && !/\s/.test(before[start - 1]))) return null;
  const query = before.slice(start + 1);
  if (query.length > MAX_QUERY || query.includes("\n")) return null;
  return { start, query };
}

/** One choice in the picker. */
export interface MentionChoice {
  mention: Mention;
  /** What the picker shows under the label: a file's size, an artifact's version and where it lives, who a person is. */
  detail: string;
}

/**
 * The choices matching `query`, best first, at most `limit` of each kind:
 * names that start with it, then words that do, then names or paths that
 * contain it anywhere. Case does not matter. An empty query offers the newest.
 */
export function matchMentions(choices: readonly MentionChoice[], query: string, limit = 6): MentionChoice[] {
  const q = query.trim().toLowerCase();
  // People first, then artifacts: there are fewer of them, and a person or a page is often what a message is about.
  const kind = (c: MentionChoice) => KIND_ORDER[c.mention.kind];
  const scored = choices
    .map((choice, order) => ({ choice, order, score: score(mentionLabel(choice.mention), q) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => kind(a.choice) - kind(b.choice) || b.score - a.score || a.order - b.order);
  const counts = { person: 0, file: 0, artifact: 0 };
  return scored.filter(({ choice }) => counts[choice.mention.kind]++ < limit).map(({ choice }) => choice);
}

const KIND_ORDER: Record<Mention["kind"], number> = { person: 0, artifact: 1, file: 2 };

function score(label: string, q: string): number {
  if (!q) return 1;
  const lower = label.toLowerCase();
  const name = baseName(lower);
  if (name.startsWith(q)) return 4;
  if (lower.split(/[\s/_.-]+/).some((word) => word.startsWith(q))) return 3;
  if (name.includes(q)) return 2;
  return lower.includes(q) ? 1 : 0;
}

/**
 * The picks whose "@" text is still in the message: one deleted from the text is no longer sent. Read as the
 * transcript shows them (splitMentions), so "@Sales" does not count as still there inside "@Sales dashboard".
 */
export function keptMentions<T extends Mention>(text: string, mentions: readonly T[]): T[] {
  const found = new Set(splitMentions(text, mentions));
  return mentions.filter((mention) => found.has(mention));
}

/**
 * The text split into plain runs and mentions, for the transcript to show
 * mentions as chips. The longest token wins where two start at one place.
 */
export function splitMentions(text: string, mentions: readonly Mention[]): (string | Mention)[] {
  const tokens = mentions.map((mention) => ({ mention, token: mentionToken(mention) })).sort((a, b) => b.token.length - a.token.length);
  const parts: (string | Mention)[] = [];
  let plain = 0;
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    const found = tokens.find(({ token }) => text.startsWith(token, at));
    if (!found) continue;
    if (at > plain) parts.push(text.slice(plain, at));
    parts.push(found.mention);
    plain = at + found.token.length;
    at = plain - 1;
  }
  if (plain < text.length) parts.push(text.slice(plain));
  return parts;
}

/** The mentions in a prompt message, checked for shape only; the chat checks what they name. Throws on a malformed list. */
export function parseMentions(raw: unknown): MentionInput[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("Mentions must be a list.");
  if (raw.length > MAX_MENTIONS) throw new Error(`A message takes at most ${MAX_MENTIONS} mentions.`);
  const parsed: MentionInput[] = [];
  for (const item of raw as Partial<{ kind: string; path: unknown; id: unknown; own: unknown; uid: unknown }>[]) {
    const mention: MentionInput | null =
      item?.kind === "file" && typeof item.path === "string" && item.path.length > 0 && item.path.length <= MAX_PATH
        ? { kind: "file", path: item.path, ...(item.own === true && { own: true as const }) }
        : item?.kind === "artifact" && typeof item.id === "string" && ID_PATTERN.test(item.id)
          ? { kind: "artifact", id: item.id }
          : item?.kind === "person" && typeof item.uid === "string" && UID_PATTERN.test(item.uid)
            ? { kind: "person", uid: item.uid }
            : null;
    if (!mention) throw new Error("Each mention is a file with its path, an artifact with its id or a person with their uid.");
    if (!parsed.some((other) => sameMention(other, mention))) parsed.push(mention);
  }
  return parsed;
}
