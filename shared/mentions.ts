import { baseName } from "./attachments.ts";
import { ID_PATTERN } from "./protocol.ts";
import { MAX_PATH } from "./uploads.ts";

/**
 * Files and artifacts named in a message with "@". The composer offers them as
 * the user types "@", puts `@<path>` or `@<title>` in the text, and sends the
 * picks with the message, so the agent gets the exact path or artifact id
 * however the text reads. The text itself stays as the user wrote it.
 */

/** What the browser sends: a file by its path in the chat owner's files, an artifact by its id. */
export type MentionInput = { kind: "file"; path: string } | { kind: "artifact"; id: string };

/** A mention as the message's transcript entry records it. A type, not an interface, so it is JSON pi can store. */
export type Mention = { kind: "file"; path: string } | { kind: "artifact"; id: string; title: string };

/** What the composer offers after "@", from GET /api/chats/:id/mentions. */
export interface MentionOptions {
  files: { path: string; size: number }[];
  artifacts: { id: string; title: string; latest: number; chatId: string }[];
}

/** Mentions one message may carry. */
export const MAX_MENTIONS = 20;

/** What a mention reads as in the text: "@" and the file's path, or the artifact's title. */
export function mentionLabel(mention: Mention): string {
  return mention.kind === "file" ? mention.path : mention.title;
}

export function mentionToken(mention: Mention): string {
  return `@${mentionLabel(mention)}`;
}

/** The same file or artifact. */
export function sameMention(a: MentionInput, b: MentionInput): boolean {
  return a.kind === "file" ? b.kind === "file" && a.path === b.path : b.kind === "artifact" && a.id === b.id;
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
  /** What the picker shows under the label: a file's size, an artifact's version and where it lives. */
  detail: string;
}

/**
 * The choices matching `query`, best first, at most `limit` of each kind:
 * names that start with it, then words that do, then names or paths that
 * contain it anywhere. Case does not matter. An empty query offers the newest.
 */
export function matchMentions(choices: readonly MentionChoice[], query: string, limit = 6): MentionChoice[] {
  const q = query.trim().toLowerCase();
  // Artifacts first: there are fewer of them, and a page is often what a message is about.
  const kind = (c: MentionChoice) => (c.mention.kind === "artifact" ? 0 : 1);
  const scored = choices
    .map((choice, order) => ({ choice, order, score: score(mentionLabel(choice.mention), q) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => kind(a.choice) - kind(b.choice) || b.score - a.score || a.order - b.order);
  const counts = { file: 0, artifact: 0 };
  return scored.filter(({ choice }) => counts[choice.mention.kind]++ < limit).map(({ choice }) => choice);
}

function score(label: string, q: string): number {
  if (!q) return 1;
  const lower = label.toLowerCase();
  const name = baseName(lower);
  if (name.startsWith(q)) return 4;
  if (lower.split(/[\s/_.-]+/).some((word) => word.startsWith(q))) return 3;
  if (name.includes(q)) return 2;
  return lower.includes(q) ? 1 : 0;
}

/** The picks whose "@" text is still in the message: one deleted from the text is no longer sent. */
export function keptMentions<T extends Mention>(text: string, mentions: readonly T[]): T[] {
  return mentions.filter((mention) => text.includes(mentionToken(mention)));
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
  for (const item of raw as Partial<{ kind: string; path: unknown; id: unknown }>[]) {
    const mention: MentionInput | null =
      item?.kind === "file" && typeof item.path === "string" && item.path.length > 0 && item.path.length <= MAX_PATH
        ? { kind: "file", path: item.path }
        : item?.kind === "artifact" && typeof item.id === "string" && ID_PATTERN.test(item.id)
          ? { kind: "artifact", id: item.id }
          : null;
    if (!mention) throw new Error("Each mention is a file with its path or an artifact with its id.");
    if (!parsed.some((other) => sameMention(other, mention))) parsed.push(mention);
  }
  return parsed;
}
