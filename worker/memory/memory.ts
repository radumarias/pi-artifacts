import type { ChatKind } from "../../shared/chat-kinds.ts";
import {
  checkNoteChange,
  checkNoteInput,
  byRank,
  checkNoteText,
  isExportedNote,
  MAX_RECALLED,
  offRecord,
  placeNote,
  promptNotes,
  reads,
  type MemoryKind,
  type MemoryNote,
  type MemoryNoteView,
  type MemoryReader,
  type MemoryScope,
  type MemoryWriter,
  type Recalled,
  dismisses,
} from "../../shared/memory.ts";
import { searchWords } from "../../shared/util.ts";
import type { Sql } from "../members.ts";
import { MemoryStore } from "./store.ts";

/** What memory needs to know of the rest of its owner's directory. */
export interface MemoryDeps {
  /** The kind of one of the owner's own chats, as its chat object last told; null for a chat that is not theirs. */
  chatKind(chatId: string): ChatKind | null;
  /** The names the owner's sidebar shows for their own chats, by id. */
  chatTitles(): ReadonlyMap<string, string>;
  /** The owner's agents' names, by id. */
  agentNames(): ReadonlyMap<string, string>;
  /** The notes changed: the open sidebars read them again. */
  changed(): void;
}

/** A note the model asks to save. */
export interface LearnedNote {
  text: unknown;
  scope: MemoryScope;
  kind: MemoryKind;
}

/** What saving a learned note did: the note, where it went, and whether it waits for a confirm. */
export type Learned = { note: MemoryNote; existed?: true; narrowed?: true } | { error: string };

/**
 * One user's memory notes, as their UserDirectory keeps them: the store, with the checks that need the rest of the
 * directory. Every reader and writer comes from a chat object of the owner's, which says the chat's kind and whether
 * anyone but the owner is in it; the kind the owner's sidebar holds is added, and the strictest wins, so a chat just
 * made off the record lets nothing in or out even where one of the two lags.
 */
export class UserMemory {
  readonly store: MemoryStore;
  readonly #deps: MemoryDeps;

  constructor(sql: Sql, deps: MemoryDeps, now?: () => number) {
    this.store = new MemoryStore(sql, now);
    this.#deps = deps;
  }

  /** `reader` with the kind the owner's sidebar holds for its chat added. */
  #checked<T extends MemoryReader>(reader: T): T {
    return { ...reader, kinds: [...reader.kinds, this.#deps.chatKind(reader.chatId)] };
  }

  /** Every note, forgotten ones too, newest first, with its chat's title and its agent's name. */
  list(): MemoryNoteView[] {
    const titles = this.#deps.chatTitles();
    const names = this.#deps.agentNames();
    return this.store.list().map((note) => {
      const chatTitle = note.chatId && titles.get(note.chatId);
      const agentName = note.agentId && names.get(note.agentId);
      return { ...note, ...(chatTitle !== undefined && { chatTitle }), ...(agentName !== undefined && { agentName }) };
    });
  }

  /** A note the owner writes from the Memory view: confirmed, as they wrote it. */
  add(input: unknown): MemoryNote | { error: string } {
    const note = checkNoteInput(input);
    if ("error" in note) return note;
    const target = this.#target(note);
    if (target) return target;
    const added = this.store.add({ ...note, source: "person", kind: "preference", confirmed: true });
    if ("error" in added) return added;
    this.#deps.changed();
    return added.note;
  }

  /** Why a note may not go to the agent or chat it names; null when it may. */
  #target(note: { scope: MemoryScope; agentId?: string; chatId?: string }): { error: string } | null {
    if (note.scope === "agent" && (!note.agentId || !this.#deps.agentNames().has(note.agentId))) return { error: "No such agent of yours." };
    if (note.scope === "chat") {
      const kind = note.chatId ? this.#deps.chatKind(note.chatId) : null;
      if (kind === null) return { error: "No such chat of yours." };
      if (offRecord([kind])) return { error: "That chat is off the record: it keeps no notes." };
    }
    return null;
  }

  /** A note the model saves in a conversation (see placeNote for where it goes, and whether it waits for a confirm). */
  learn(writer: MemoryWriter, input: LearnedNote): Learned {
    const text = checkNoteText(input.text);
    if (typeof text !== "string") return text;
    const place = placeNote(this.#checked(writer), input.scope, input.kind);
    if ("error" in place) return place;
    const added = this.store.add({ ...place, text, source: "learned", kind: input.kind, learnedBy: writer.learnedBy, byOwner: writer.byOwner });
    if ("error" in added) return added;
    this.#deps.changed();
    return { ...added, ...(place.narrowed && { narrowed: true as const }) };
  }

  /**
   * The notes a prompt holds for `reader` (promptNotes), and how many more it reads. `off`: the chat is off the record,
   * or not one of the owner's, as this directory knows it: nothing is read or saved there. Counts no use: see `use`.
   */
  read(reader: MemoryReader): { notes: MemoryNote[]; more: number; off?: true } {
    const checked = this.#checked(reader);
    if (offRecord(checked.kinds)) return { notes: [], more: 0, off: true };
    const readable = this.store.readable(checked);
    const notes = promptNotes(readable);
    return { notes, more: readable.length - notes.length };
  }

  /**
   * Count a read of each note: each time it enters a conversation's prompt, or a recall returns it. Only a count, which
   * the Memory view shows when it next reads the notes: the open sidebars are not told.
   */
  use(ids: readonly string[]): void {
    this.store.use(ids);
  }

  /**
   * The notes `reader` reads that hold every word of `query` (all for none), MAX_RECALLED of them from `offset`: those
   * not among `shown` (the ones its prompt holds) first, then by rank. With how many match in all.
   */
  recall(reader: MemoryReader, query: string, shown: readonly string[], offset = 0): Recalled {
    const words = searchWords(query);
    const inPrompt = new Set(shown);
    const matching = this.store
      .readable(this.#checked(reader))
      .filter((note) => words.every((word) => note.text.toLowerCase().includes(word)))
      .sort((a, b) => Number(inPrompt.has(a.id)) - Number(inPrompt.has(b.id)) || byRank(a, b));
    const start = Math.max(0, Math.floor(offset) || 0);
    const notes = matching.slice(start, start + MAX_RECALLED);
    this.use(notes.map((note) => note.id));
    return { notes, total: matching.length };
  }

  /**
   * The model forgets a note in a conversation: only one this conversation reads, and only in a turn its owner asked
   * for. It can be brought back from the Memory view.
   */
  forgetFor(writer: MemoryWriter, id: string): MemoryNote | { error: string } {
    if (!writer.byOwner) return { error: "Only the owner can have a note forgotten here; they can forget it under Memory." };
    const note = this.store.get(id);
    if (!note || !reads(this.#checked(writer), note)) return { error: `No note [${id}] is read here.` };
    return this.forget(id);
  }

  /** The owner changes a note from the Memory view: its text, pin, a confirm, or where it goes. */
  change(id: string, value: unknown): MemoryNote | { error: string } {
    const change = checkNoteChange(value);
    if ("error" in change) return change;
    if (change.scope) {
      const target = this.#target({ scope: change.scope, agentId: change.agentId, chatId: change.chatId });
      if (target) return target;
    }
    const changed = this.store.change(id, change);
    if (!("error" in changed)) this.#deps.changed();
    return changed;
  }

  /** Forget a note; one learned that waits for a confirm is dismissed: deleted, as nothing read it. */
  forget(id: string): MemoryNote | { error: string } {
    const note = this.store.get(id);
    if (note && dismisses(note)) return this.delete(id) ?? note;
    const forgotten = this.store.forget(id);
    if ("error" in forgotten) return forgotten;
    if (forgotten.changed) this.#deps.changed();
    return forgotten.note;
  }

  restore(id: string): MemoryNote | { error: string } {
    const restored = this.store.restore(id);
    if (!("error" in restored)) this.#deps.changed();
    return restored;
  }

  delete(id: string): { error: string } | null {
    if (!this.store.delete(id)) return { error: "No such note." };
    this.#deps.changed();
    return null;
  }

  forgetChat(chatId: string): void {
    this.store.forgetChat(chatId);
    this.#deps.changed();
  }

  forgetAgent(agentId: string): void {
    this.store.forgetAgent(agentId);
    this.#deps.changed();
  }

  /** The notes an export carries: all but those of a chat that is off the record now, which nothing takes out of it. */
  exported(): MemoryNote[] {
    const kinds = new Map<string, ChatKind | null>();
    const kindOf = (chatId: string) => (kinds.has(chatId) ? kinds.get(chatId)! : kinds.set(chatId, this.#deps.chatKind(chatId)).get(chatId)!);
    return this.store.list().filter((note) => note.scope !== "chat" || !note.chatId || !offRecord([kindOf(note.chatId)]));
  }

  /**
   * Notes from an export, each with its result: its agent by the id it has here (`agents`, from the export's ids), its
   * chat only when it is one of the owner's that is not off the record. A note of an agent or chat that did not come
   * along is left out. The sidebars are told once.
   */
  import(values: readonly unknown[], agents: Readonly<Record<string, string>> = {}): ({ id: string; skipped?: true } | { error: string })[] {
    const names = this.#deps.agentNames();
    const results = values.map((value) => this.#import(value, agents, names));
    if (results.some((result) => "id" in result && !result.skipped)) this.#deps.changed();
    return results;
  }

  #import(
    value: unknown,
    agents: Readonly<Record<string, string>>,
    names: ReadonlyMap<string, string>,
  ): { id: string; skipped?: true } | { error: string } {
    if (!isExportedNote(value)) return { error: "Not a memory note." };
    const agentId = value.agentId && (agents[value.agentId] ?? value.agentId);
    const note: MemoryNote = { ...value, ...(agentId && { agentId }) };
    if (note.agentId && !names.has(note.agentId)) {
      if (note.scope === "agent") return { error: "its agent was not imported" };
      delete note.agentId;
    }
    if (note.chatId) {
      const kind = this.#deps.chatKind(note.chatId);
      if (note.scope === "chat" && (kind === null || offRecord([kind])))
        return { error: kind === null ? "its chat was not imported" : "its chat is off the record" };
      if (kind === null) delete note.chatId;
    }
    return this.store.import(note);
  }
}
