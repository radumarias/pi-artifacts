import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { baseName } from "../../shared/attachments.ts";
import {
  activeQuery,
  keptMentions,
  matchMentions,
  mentionLabel,
  mentionToken,
  sameMention,
  splitMentions,
  type Mention,
  type MentionChoice,
  type MentionInput,
  type MentionOptions,
} from "../../shared/mentions.ts";
import { formatBytes } from "../../shared/util.ts";
import { api } from "../api.ts";

/**
 * "@" in the composer: as the user types "@" (or presses the @ button), a list of the chat owner's files and
 * artifacts opens over the input, filtered by what follows the "@". Arrows move, Enter or Tab picks, Escape closes.
 * A pick puts `@<path>` or `@<title>` in the text and is sent with the message while that text is still there.
 */
export function useMentions(chatId: string, draft: string, setDraft: (text: string) => void, input: RefObject<HTMLTextAreaElement | null>) {
  const [options, setOptions] = useState<MentionOptions | null>(null);
  const [picked, setPicked] = useState<Mention[]>([]);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  // Escape closes the list until the "@" it was for is gone or another is typed.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const loading = useRef(false);

  const typed = activeQuery(draft, caret);
  const query = typed && typed.start !== dismissedAt ? typed : null;

  // Read when an "@" opens the list, so files uploaded and artifacts published since are in it.
  const wanted = query !== null;
  useEffect(() => {
    if (!wanted || loading.current) return;
    loading.current = true;
    api
      .mentions(chatId)
      .then(setOptions, () => setOptions({ files: [], artifacts: [] }))
      .finally(() => (loading.current = false));
  }, [wanted, chatId]);
  const typing = typed !== null;
  useEffect(() => {
    if (!typing) setDismissedAt(null);
  }, [typing]);

  const all = useMemo<MentionChoice[]>(
    () =>
      options
        ? [
            ...options.artifacts.map((a) => ({
              mention: { kind: "artifact" as const, id: a.id, title: a.title },
              detail: `artifact · v${a.latest}${a.chatId === chatId ? " · this chat" : ""}`,
            })),
            ...options.files.map((f) => ({ mention: { kind: "file" as const, path: f.path }, detail: formatBytes(f.size) })),
          ]
        : [],
    [options, chatId],
  );
  const choices = useMemo(() => (query ? matchMentions(all, query.query) : []), [all, query?.query]);
  // An "@" in running text ("@ the team") matches nothing once a space follows: then it was not a mention.
  const open = query !== null && !(options && choices.length === 0 && /\s/.test(query.query));

  /** Put `token` in place of draft[start, end), with the caret after it. */
  const replace = (start: number, end: number, token: string) => {
    const at = start + token.length;
    setDraft(draft.slice(0, start) + token + draft.slice(end));
    setCaret(at);
    setActive(0);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(at, at);
    });
  };

  const pick = (choice: MentionChoice) => {
    if (!query) return;
    replace(query.start, caret, `${mentionToken(choice.mention)} `);
    setPicked((current) => (current.some((m) => sameMention(m, choice.mention)) ? current : [...current, choice.mention]));
    // The "@" is done: its text still reads as a query, but the list should not reopen for it.
    setDismissedAt(query.start);
  };

  /** Keys the list takes while it is open; true when it took this one. */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape") {
      setDismissedAt(query!.start);
    } else if (choices.length === 0) {
      return false;
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + choices.length) % choices.length);
    } else if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      pick(choices[Math.min(active, choices.length - 1)]);
    } else {
      return false;
    }
    event.preventDefault();
    return true;
  };

  /** Follow the caret: the list is about the "@" just before it. */
  const track = () => {
    setCaret(input.current?.selectionStart ?? draft.length);
    setActive(0);
  };

  /** Put an "@" at the caret, with a space before it when it would touch a word, and open the list. */
  const insertAt = () => {
    const at = input.current?.selectionStart ?? draft.length;
    replace(at, at, at > 0 && !/\s/.test(draft[at - 1]) ? " @" : "@");
    setDismissedAt(null);
  };

  /** The picks still named in `text`, to send with it; the list starts empty for the next message. */
  const take = (text: string): MentionInput[] => keptMentions(text, picked);
  const clear = () => setPicked([]);

  return { open, loaded: options !== null, choices, active, setActive, pick, onKeyDown, track, insertAt, take, clear };
}

export function MentionList({ mentions }: { mentions: ReturnType<typeof useMentions> }) {
  const { open, loaded, choices, active, setActive, pick } = mentions;
  if (!open) return null;
  return (
    <div className="mention-list" role="listbox" aria-label="Files and artifacts">
      {!loaded ? (
        <div className="mention-empty">Loading…</div>
      ) : choices.length === 0 ? (
        <div className="mention-empty">No file or artifact matches. Upload files from the sidebar.</div>
      ) : (
        choices.map((choice, i) => (
          <button
            key={choice.mention.kind === "file" ? `f:${choice.mention.path}` : `a:${choice.mention.id}`}
            type="button"
            role="option"
            aria-selected={i === active}
            className={i === active ? "mention-choice active" : "mention-choice"}
            // Before the input loses focus, so the caret is still where the "@" is.
            onMouseDown={(e) => {
              e.preventDefault();
              pick(choice);
            }}
            onMouseEnter={() => setActive(i)}
          >
            <span className="mention-icon">{choice.mention.kind === "file" ? "▤" : "▦"}</span>
            <span className="mention-label">{mentionLabel(choice.mention)}</span>
            <small>{choice.detail}</small>
          </button>
        ))
      )}
    </div>
  );
}

/** A message's text with its mentions as chips: a file by its name (path on hover), an artifact as a link to its page. */
export function MentionText({ text, mentions }: { text: string; mentions?: Mention[] }) {
  if (!mentions?.length) return <>{text}</>;
  return (
    <>
      {splitMentions(text, mentions).map((part, i) =>
        typeof part === "string" ? (
          part
        ) : part.kind === "artifact" ? (
          <a key={i} className="mention-chip" href={`/a/${part.id}`} target="_blank" rel="noreferrer" title={`Artifact "${part.title}": open its page`}>
            @{part.title}
          </a>
        ) : (
          <span key={i} className="mention-chip" title={part.path}>
            @{baseName(part.path)}
          </span>
        ),
      )}
    </>
  );
}
