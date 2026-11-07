import {
  isChatKind,
  kindChoices,
  KIND_TEXT,
  legacyKind,
  losesAccess,
  type BranchedFrom,
  type ChatKind,
  type ChatMemberVia,
  type ChatPage,
} from "../shared/chat-kinds.ts";

/** The part of a Durable Object's KV storage the chat's kind needs; the tests put a Map behind it. */
export interface Kv {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
}

const KIND_KEY = "kind";
const PAGE_KEY = "page";
const BRANCHED_FROM_KEY = "branchedFrom";
/** A branch of a chat on a page: the page, for its agents to know, though the branch is not on it. */
const CONTEXT_PAGE_KEY = "contextPage";
/** Not exported: the people of a chat stay behind with it. */
const SHUT_OUT_KEY = "shutOut";
/** Not exported: this branch took a place among its conversation's MAX_BRANCHES (an imported one took none). */
const COUNTED_KEY = "branchCounted";

/** The chat storage keys an export carries (with the chat's other settings, worker/chat-dump.ts). */
export const KIND_KV = [KIND_KEY, PAGE_KEY, BRANCHED_FROM_KEY, CONTEXT_PAGE_KEY];

/** The most people one chat remembers left it or were removed. */
export const MAX_SHUT_OUT = 500;

/** The most branches one conversation has, counted against the chat they all came from (UserDirectory.takeBranch). */
export const MAX_BRANCHES = 100;

/**
 * One chat's kind (shared/chat-kinds.ts), the page it discusses and where it branched off from, in the chat object's
 * own storage. A chat from before kinds has none stored: it is a group if it has members, else private, until it is
 * changed.
 */
export class ChatKindState {
  readonly #kv: Kv;
  readonly #hasMembers: () => boolean;

  constructor(kv: Kv, hasMembers: () => boolean) {
    this.#kv = kv;
    this.#hasMembers = hasMembers;
  }

  kind(): ChatKind {
    return this.stored() ?? legacyKind(this.#hasMembers());
  }

  /** The kind stored, if one is. */
  stored(): ChatKind | undefined {
    const stored = this.#kv.get<string>(KIND_KEY);
    return isChatKind(stored) ? stored : undefined;
  }

  setKind(kind: ChatKind): void {
    this.#kv.put(KIND_KEY, kind);
  }

  page(): ChatPage | undefined {
    return this.#kv.get<ChatPage>(PAGE_KEY);
  }

  setPage(page: ChatPage): void {
    this.#kv.put(PAGE_KEY, page);
  }

  branchedFrom(): BranchedFrom | undefined {
    return this.#kv.get<BranchedFrom>(BRANCHED_FROM_KEY);
  }

  /** Set by branchOff, which took the branch's place: `counted` says deleting it gives the place back. */
  setBranchedFrom(from: BranchedFrom, counted = false): void {
    this.#kv.put(BRANCHED_FROM_KEY, from);
    if (counted) this.#kv.put(COUNTED_KEY, true);
  }

  /**
   * The chat came in by import, without its people: one that was open to others is its owner's alone again, and
   * discusses no page (the link to it stayed behind); one off the record stays so. Its kind now.
   */
  imported(): ChatKind {
    this.#kv.delete(PAGE_KEY);
    const kind = this.stored() === "off_record" ? "off_record" : "private";
    this.setKind(kind);
    return kind;
  }

  /**
   * The owner removed `uid` from the chat: neither the owner adding them (addMember) nor opening the page it discusses
   * (joinPage) lets them back in; an invite does (letBackIn). The newest MAX_SHUT_OUT are kept.
   */
  shutOut(uid: string): void {
    this.#kv.put(SHUT_OUT_KEY, [...this.#shutOut().filter((other) => other !== uid), uid].slice(-MAX_SHUT_OUT));
  }

  isShutOut(uid: string): boolean {
    return this.#shutOut().includes(uid);
  }

  letBackIn(uid: string): void {
    const shut = this.#shutOut();
    if (shut.includes(uid)) this.#kv.put(SHUT_OUT_KEY, shut.filter((other) => other !== uid));
  }

  #shutOut(): string[] {
    return this.#kv.get<string[]>(SHUT_OUT_KEY) ?? [];
  }

  /** The page this chat's agents should know of: the one it is on, or (a branch of a chat on one) the one it came from. */
  knownPage(): ChatPage | undefined {
    return this.page() ?? this.#kv.get<ChatPage>(CONTEXT_PAGE_KEY);
  }

  /** The root a deleted branch gives its place back to: only one branchOff counted, never an imported one. */
  countedRoot(): string | undefined {
    return this.#kv.get<boolean>(COUNTED_KEY) === true ? this.branchedFrom()?.root : undefined;
  }

  setContextPage(page: ChatPage): void {
    this.#kv.put(CONTEXT_PAGE_KEY, page);
  }
}

/**
 * The kind of a branch (branchOff), from the kind of the chat it came from and whether someone besides the owner is in
 * it: off the record stays so; else private with nobody else in it, and a group with someone. Never on a page: the
 * page's chat is the one its author started.
 */
export function branchKind(from: ChatKind, withMember: boolean): ChatKind {
  if (from === "off_record") return "off_record";
  return withMember ? "group" : "private";
}

/** The owner's change of a chat's kind, checked: the members it removes, or why it cannot be made. */
export type KindPlan = { removed: ChatMemberVia[] } | { error: string; status: 400 | 409; loses?: ChatMemberVia[] };

/**
 * Plan changing a chat of `from` to `to`, for the owner who confirmed that `confirmed` (uids) lose access. Narrowing
 * lists who loses access first and then removes exactly them: if the list changed since it was shown (someone joined,
 * or left), nothing changes and the new list comes back, to confirm again.
 */
export function planKindChange(from: ChatKind, to: unknown, members: readonly ChatMemberVia[], confirmed: readonly string[], hasPage: boolean): KindPlan {
  if (!isChatKind(to) || !kindChoices(hasPage).includes(to)) {
    return { error: to === "page" ? "Only a chat made from a page with Discuss can be on a page." : "Not a kind of chat.", status: 400 };
  }
  const loses = losesAccess(to, members);
  if (from === to) return { removed: [] };
  const asked = new Set(confirmed);
  if (loses.length !== asked.size || loses.some((member) => !asked.has(member.uid))) {
    return { error: `Who loses access changed: check the list again before making the chat ${KIND_TEXT[to].label.toLowerCase()}.`, status: 409, loses };
  }
  return { removed: loses };
}
