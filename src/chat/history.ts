import type { EntryRecord } from "@earendil-works/pi-durable";
import { useCallback, useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { CHAT_MESSAGE_KIND, type ChatMessageData } from "../../shared/protocol.ts";
import type { Mention } from "../../shared/mentions.ts";
import { byViewer, sentAt, userText } from "./entries.ts";

/**
 * The viewer's own earlier messages, which the composer brings back to send again or edit: Up and Down in it step
 * through them as a shell does through its commands, and the composer's "more" menu lists them to pick one.
 */

/** A message of the viewer's, as the composer brings it back: its text, and the files, artifacts and people it named. */
export interface Recalled {
  id: number;
  text: string;
  mentions?: Mention[];
  sentAt?: number;
}

/**
 * What the viewer `uid` sent in the chat, newest first, each text once (where it was last sent). A plain `pi.user` entry
 * is the owner's (`isOwner`). A message with only files has no text to bring back, so it is left out.
 */
export function ownMessages(entries: readonly EntryRecord[], uid: string, isOwner: boolean): Recalled[] {
  const seen = new Set<string>();
  const out: Recalled[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const message = recalled(entry, uid, isOwner);
    if (!message || !/\S/.test(message.text) || seen.has(message.text)) continue;
    seen.add(message.text);
    out.push(message);
  }
  return out;
}

function recalled(entry: EntryRecord, uid: string, isOwner: boolean): Recalled | undefined {
  if (!byViewer(entry, uid, isOwner)) return undefined;
  const at = { id: entry.id as number, sentAt: sentAt(entry) };
  if (entry.kind === CHAT_MESSAGE_KIND) {
    const { text, mentions } = entry.data as unknown as ChatMessageData;
    return { ...at, text, mentions };
  }
  const message = entry.model?.[0];
  return entry.kind === "pi.user" && message?.role === "user" ? { ...at, text: userText(message) } : undefined;
}

/**
 * Where Up or Down (`step` -1 or 1, toward older or newer) takes the composer, or undefined to leave the key to the
 * input (it moves the caret). `at` is the message brought back last, which counts only while the draft is still its
 * text: once edited, the arrows move the caret again. Up starts from an empty draft; from a message brought back it goes
 * on to the one before when the caret is on the first line or at the end (where bringing one back puts it). Down goes
 * from a message brought back to the one after when the caret is on the last line, and past the newest gives `null`:
 * back to what the composer had before.
 */
export function historyStep(
  history: readonly Recalled[],
  at: number | undefined,
  draft: string,
  caret: { start: number; end: number },
  step: -1 | 1,
): Recalled | null | undefined {
  if (caret.start !== caret.end) return undefined;
  const current = browsing(history, at, draft);
  if (step === -1) {
    if (draft === "") return history[0];
    if (current < 0) return undefined;
    return !draft.slice(0, caret.start).includes("\n") || caret.start === draft.length ? history[current + 1] : undefined;
  }
  if (current < 0 || draft.includes("\n", caret.start)) return undefined;
  return current === 0 ? null : history[current - 1];
}

/** Where the message brought back last (`at`) is in `history`, while the draft is still its text; else -1. */
function browsing(history: readonly Recalled[], at: number | undefined, draft: string): number {
  if (at === undefined) return -1;
  const index = history.findIndex((message) => message.id === at);
  return index >= 0 && history[index].text === draft ? index : -1;
}

/**
 * The composer's history: `onKeyDown` takes Up and Down as `historyStep` says, `recall` brings back one message picked
 * from the list. Either puts its text in the draft with the caret at the end, and hands it to `onRecall`, so the files
 * and artifacts it named go with it again. What was typed before is kept, and Down past the newest gives it back. Both
 * stay the same function from one render to the next (they read the latest history and draft when called), so the
 * list that calls `recall` does not draw again as a reply streams in.
 */
export function useHistory(
  history: readonly Recalled[],
  draft: string,
  setDraft: (text: string) => void,
  input: RefObject<HTMLTextAreaElement | null>,
  onRecall: (message: Recalled) => void,
) {
  const latest = useRef({ history, draft, setDraft, onRecall });
  useLayoutEffect(() => {
    latest.current = { history, draft, setDraft, onRecall };
  });
  const at = useRef<number>(undefined);
  const saved = useRef("");

  const recall = useCallback(
    (message: Recalled | null) => {
      const { history, draft, setDraft, onRecall } = latest.current;
      if (browsing(history, at.current, draft) < 0) saved.current = draft;
      at.current = message?.id;
      if (message) onRecall(message);
      const text = message ? message.text : saved.current;
      setDraft(text);
      requestAnimationFrame(() => {
        const el = input.current;
        el?.focus();
        el?.setSelectionRange(text.length, text.length);
      });
    },
    [input],
  );

  /** Up and Down, when they step through the history; true when this one did. */
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      const el = input.current;
      const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
      if (!el || !step || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return false;
      const { history, draft } = latest.current;
      const next = historyStep(history, at.current, draft, { start: el.selectionStart, end: el.selectionEnd }, step);
      if (next === undefined) return false;
      event.preventDefault();
      recall(next);
      return true;
    },
    [input, recall],
  );

  /** After sending: the next Up starts again from the newest. */
  const reset = useCallback(() => {
    at.current = undefined;
    saved.current = "";
  }, []);
  return { onKeyDown, recall, reset };
}
