import type { ChatKind } from "../../shared/chat-kinds.ts";
import {
  memorySection,
  readsOwnNotes,
  type MemoryNote,
  type MemoryReader,
  type MemoryWriter,
  type Recalled,
  type Forgot,
} from "../../shared/memory.ts";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { AGENT_NAME } from "../../shared/mentions.ts";
import { errorMessage } from "../../shared/util.ts";
import { piLogEntry } from "../agents/turns.ts";
import type { Learned, LearnedNote } from "./memory.ts";
import type { MemoryHost } from "./tools.ts";

/** The notes a conversation's prompt holds; `off`: the owner's directory reads and saves none in this chat. */
export type NotesRead = { notes: MemoryNote[]; more: number; off?: true };

/** What a chat reaches of a user's notes (UserDirectory's methods, which RPC makes promises). */
export interface NotesDirectory {
  readNotes(reader: MemoryReader): NotesRead | Promise<NotesRead>;
  useNotes(ids: readonly string[]): void | Promise<void>;
  recallNotes(reader: MemoryReader, query: string, shown: readonly string[], offset?: number): Recalled | Promise<Recalled>;
  learnNote(writer: MemoryWriter, note: LearnedNote): Learned | Promise<Learned>;
  forgetNoteFor(writer: MemoryWriter, id: string): Forgot | Promise<Forgot>;
}

/**
 * An agent of the chat's roster, by the session a call comes from, with whether its turn now is its owner's. `run`: the
 * session is one of its runs' (an item's, a reply's, a page rebuild's), whose report may go to chats others are in.
 */
export interface MemoryAgent {
  agentId: string;
  ownerUid: string;
  name: string;
  byOwner: boolean;
  run?: true;
}

/** What ChatMemory needs of the chat object it runs in. */
export interface ChatMemoryDeps {
  ownerUid: string;
  chatId: string;
  kind(): ChatKind;
  /** Nobody but the owner is in the chat. */
  alone(): boolean;
  /** The roster's agent whose conversation `conversation` is; null for pi's. */
  agentFor(conversation: string): MemoryAgent | null;
  /** pi's running turn answers only the owner's own messages (runAskedByOwner over its log). */
  piByOwner(): Promise<boolean>;
  /**
   * Have the next model request of a conversation (pi's for none, else a session) start its prompt afresh, leaving out
   * every earlier one: an earlier prompt held the owner's own notes, which its readers may no longer see. With
   * `compacting`, a compaction it could not stop summarizes the earlier context: once that settles, it is due again.
   */
  freshPrompt(conversation: string | undefined): Promise<{ compacting?: Promise<unknown>; placed: Promise<unknown> }>;
  directory(uid: string): NotesDirectory;
  /** Where the chat keeps which notes each conversation's prompt already held, so a note's use counts once in each. */
  kv: { get<T>(key: string): T | undefined; put(key: string, value: unknown): void };
}

/** How many pages of pi's log runAskedByOwner reads at most: a longer run is not judged the owner's. */
export const MAX_RUN_PAGES = 20;

/**
 * Whether the run pi is in answers only the owner's own messages, from its log read newest first (`pages`): every
 * input since the end of its last run (a reply that ended it, not one calling tools) is a message of `ownerUid`'s,
 * none an agent's hand-off or another input (piLogEntry). Read from the transcript, so a run resumed after a restart
 * is judged as it was. `pages` go back to the start of the log when no run ended before (only this run is read); past
 * MAX_RUN_PAGES of them, it is not the owner's.
 */
export async function runAskedByOwner(pages: AsyncIterable<readonly EntryRecord[]>, ownerUid: string): Promise<boolean> {
  let asked = false;
  let read = 0;
  for await (const page of pages) {
    if (++read > MAX_RUN_PAGES) return false;
    for (const entry of page) {
      const seen = piLogEntry(entry);
      if (!seen) continue;
      if ("reply" in seen) {
        // A failed request is retried in the same run (or compacted after an overflow): only another reply ends one.
        // Read past one that did end it, the run is judged over more inputs, never fewer.
        if (seen.reply.stopReason !== "toolUse" && seen.reply.stopReason !== "error") return asked;
      } else if (seen.input !== "message" || seen.uid !== ownerUid) return false;
      else asked = true;
    }
  }
  // The start of the log: the run is the conversation's first.
  return asked;
}

/** pi's conversation, as the memos and the counts of uses key it. */
const PI = "pi";
const SHOWN_KEY = "memory.shown:";
/** The conversations (PI, or a session) whose prompt held the owner's own notes since it last started afresh. */
const OWN_KEY = "memory.own";
/** The conversations whose requests leave out a summary of theirs (see #forgetOwn). */
const SUMMARIES_KEY = "memory.summaries";
/** How many note ids a conversation keeps as shown; past it, the oldest go (a use may then count again). */
const MAX_SHOWN = 1_000;

/** A conversation's section as its turn started: its text, and the notes it holds. */
type Section = { text: string; ids: string[] };
/** A conversation as the memos key it (PI, or its session), and its agent (null for pi's). */
type Who = { key: string; agent: MemoryAgent | null };

/**
 * The memory notes of one chat: who reads and who saves them for each conversation in it (pi's, and each agent's
 * session), and the prompt section each one reads, set when its turn starts and kept for the turn, so the prompt
 * changes only between turns.
 *
 * pi works for whoever calls it: only a turn that answers the owner's own message, in a chat nobody else is in, saves
 * as the owner; in any other, what it saves waits for the owner's confirm and it forgets nothing. An agent's turn knows
 * who asked (`byOwner`); a turn its owner did not ask for is never offered memory_note or memory_forget
 * (allowedTools), and both refuse it too. A run's sessions never read the owner's own notes, as its report may be
 * posted where others read it.
 *
 * A prompt stays in its conversation's transcript: once the owner's own notes were in one and the chat is shared (or
 * changes its kind), the conversation's next request starts its prompt afresh (`freshPrompt`), so no model reads them.
 */
export class ChatMemory {
  readonly #deps: ChatMemoryDeps;
  /** Each conversation's section, as its turn started, with who could read the chat then (`#audience`). */
  readonly #sections = new Map<string, { audience: string; section: Promise<Section> }>();
  /** The conversations whose prompt is being started afresh now (#forgetOwn). */
  readonly #freshening = new Map<string, Promise<void>>();
  /** The conversations whose fresh start waits for a compaction's summary (#forgetOwn): that wait starts it again. */
  readonly #awaitingSummary = new Set<string>();

  constructor(deps: ChatMemoryDeps) {
    this.#deps = deps;
  }

  #who(conversation: string): Who {
    const agent = this.#deps.agentFor(conversation);
    return { key: agent ? conversation : PI, agent };
  }

  /** The chat's kind and whether anyone else is in it: a section read under another is not used. */
  #audience(): string {
    return `${this.#deps.kind()}:${this.#deps.alone()}`;
  }

  #reader(agent: MemoryAgent | null): MemoryReader {
    return {
      chatId: this.#deps.chatId,
      kinds: [this.#deps.kind()],
      alone: this.#deps.alone() && !agent?.run,
      ...(agent && { agentId: agent.agentId }),
    };
  }

  async #writer(agent: MemoryAgent | null): Promise<MemoryWriter> {
    const reader = this.#reader(agent);
    const byOwner = agent ? agent.byOwner : reader.alone && (await this.#deps.piByOwner().catch(() => false));
    return { ...reader, byOwner, learnedBy: agent ? agent.name : AGENT_NAME };
  }

  /** Whose notes a conversation reads: its agent's owner's, and pi's owner's (the chat's). */
  #directory(agent: MemoryAgent | null): NotesDirectory {
    return this.#deps.directory(agent?.ownerUid ?? this.#deps.ownerUid);
  }

  /** The conversations kept under `list` in the chat's kv (OWN_KEY, SUMMARIES_KEY). */
  #marked(list: string): string[] {
    return this.#deps.kv.get<string[]>(list) ?? [];
  }

  #mark(list: string, key: string): void {
    const marked = this.#marked(list);
    if (!marked.includes(key)) this.#deps.kv.put(list, [...marked, key]);
  }

  #unmark(list: string, key: string): void {
    this.#deps.kv.put(
      list,
      this.#marked(list).filter((each) => each !== key),
    );
  }

  #own(): string[] {
    return this.#marked(OWN_KEY);
  }

  #markOwn(key: string): void {
    this.#mark(OWN_KEY, key);
  }

  /**
   * Start afresh the prompt of conversation `key` when it held the owner's own notes, which `reader` does not read. One
   * at a time for each conversation: a refresh and audienceChanged at once write one fresh start, not two.
   */
  #forgetOwn(key: string, reader: MemoryReader): Promise<void> {
    if (readsOwnNotes(reader) || !this.#own().includes(key) || this.#awaitingSummary.has(key)) return Promise.resolve();
    const going = this.#freshening.get(key);
    if (going) return going;
    const fresh = this.#deps
      .freshPrompt(key === PI ? undefined : key)
      .then(({ compacting, placed }) => {
        // Marked until the summary is left out too: if this object goes away first, the next turn does it.
        if (compacting) {
          // Each request leaves summaries out until the edits that do are in (leavesOutSummaries).
          this.#mark(SUMMARIES_KEY, key);
          this.#awaitingSummary.add(key);
          void compacting
            .finally(() => this.#awaitingSummary.delete(key))
            // Read as the conversation reads now: its agent's, or pi's.
            .then(() => this.#forgetOwn(key, this.#reader(key === PI ? null : this.#deps.agentFor(key))))
            .catch((error: unknown) => console.error("memory prompt:", errorMessage(error)));
        } else {
          this.#unmark(OWN_KEY, key);
          if (this.#marked(SUMMARIES_KEY).includes(key))
            void placed.then(() => this.#unmark(SUMMARIES_KEY, key)).catch((error: unknown) => console.error("memory prompt:", errorMessage(error)));
        }
      })
      .finally(() => this.#freshening.delete(key));
    this.#freshening.set(key, fresh);
    return fresh;
  }

  /**
   * Read a conversation's notes again as its turn starts: pi's (no `conversation`), or an agent's session's. Starts its
   * prompt afresh first when an earlier one held the owner's own notes and it reads them no longer, and counts a use of
   * each note its prompt holds for the first time. Never rejects: on a failure the section says it.
   */
  async refresh(conversation?: string): Promise<string> {
    const who = conversation === undefined ? { key: PI, agent: null } : this.#who(conversation);
    await this.#forgetOwn(who.key, this.#reader(who.agent)).catch((error: unknown) => console.error("memory prompt:", errorMessage(error)));
    return (await this.#refresh(who)).text;
  }

  /** Read `who`'s section, kept for its turn. Not while a request is prepared (see #section): the next refresh does it. */
  #refresh(who: Who): Promise<Section> {
    const section = this.#read(who.key, who.agent);
    this.#sections.set(who.key, { audience: this.#audience(), section });
    return section;
  }

  /**
   * The chat was shared, or changed its kind: every conversation whose prompt held the owner's own notes starts it
   * afresh at its next request, a turn already going included. Never rejects: a failure is logged, and the
   * conversation's next turn tries again (refresh).
   */
  async audienceChanged(): Promise<void> {
    const reader = this.#reader(null);
    if (readsOwnNotes(reader)) return;
    // Their kept sections are read again anyway (#section): they were read for another audience.
    await Promise.all(
      this.#own().map((key) => this.#forgetOwn(key, reader).catch((error: unknown) => console.error("memory prompt:", errorMessage(error)))),
    );
  }

  async #read(key: string, agent: MemoryAgent | null): Promise<Section> {
    const reader = this.#reader(agent);
    const directory = this.#directory(agent);
    try {
      const { notes, more, off } = await directory.readNotes(reader);
      // Off the record as the owner's directory knows it (its sidebar's kind, or a chat not theirs): say so, as the
      // tools refuse there.
      if (off) return { text: memorySection({ kinds: ["off_record"] }, []), ids: [] };
      if (notes.some((note) => note.scope === "user")) this.#markOwn(key);
      const shown = new Set(this.#deps.kv.get<string[]>(SHOWN_KEY + key) ?? []);
      const ids = notes.map((note) => note.id);
      const unseen = ids.filter((id) => !shown.has(id));
      if (unseen.length) {
        this.#deps.kv.put(SHOWN_KEY + key, [...shown, ...unseen].slice(-MAX_SHOWN));
        // Only a count, not waited for: a failure leaves the section as it is.
        void Promise.resolve(directory.useNotes(unseen)).catch((error: unknown) => console.error("memory uses:", errorMessage(error)));
      }
      return { text: memorySection(reader, notes, more), ids };
    } catch (error) {
      console.error("memory:", errorMessage(error));
      return { text: "Memory notes could not be read for this turn.", ids: [] };
    }
  }

  /** `who`'s section as it is kept, or read again when the chat's audience changed since. */
  #section(who: Who): Promise<Section> {
    const kept = this.#sections.get(who.key);
    return kept && kept.audience === this.#audience() ? kept.section : this.#refresh(who);
  }

  /** What the memory tools and section run on (worker/memory/tools.ts). */
  host(): MemoryHost {
    return {
      // Read again when the chat was shared or changed its kind since: never a section read for fewer readers.
      section: async (conversation) => (await this.#section(this.#who(conversation))).text,
      leavesOutSummaries: (conversation) => {
        const { key, agent } = this.#who(conversation);
        return this.#marked(SUMMARIES_KEY).includes(key) && !readsOwnNotes(this.#reader(agent));
      },
      note: async (conversation, note) => {
        const { agent } = this.#who(conversation);
        return this.#directory(agent).learnNote(await this.#writer(agent), note);
      },
      // The notes the prompt does not hold first: those it holds the model has already.
      recall: async (conversation, query, offset) => {
        const who = this.#who(conversation);
        const { ids } = await this.#section(who);
        const found = await this.#directory(who.agent).recallNotes(this.#reader(who.agent), query, ids, offset);
        // Now in the transcript too: left out once the chat has more readers (freshPrompt).
        if (found.notes.some((note) => note.scope === "user")) this.#markOwn(who.key);
        return found;
      },
      forget: async (conversation, id) => {
        const { agent } = this.#who(conversation);
        return this.#directory(agent).forgetNoteFor(await this.#writer(agent), id);
      },
    };
  }
}
