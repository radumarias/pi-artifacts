import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { baseName } from "../../shared/attachments.ts";
import {
  activeQuery,
  AGENT_NAME,
  AGENT_TOKEN,
  splitAgent,
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
import { everyone, type ChatPeople } from "../../shared/protocol.ts";
import { formatBytes } from "../../shared/util.ts";
import { api } from "../api.ts";
import { AgentAvatar, Avatar, tintOf, tintStyle, useSharedChat } from "./people.tsx";

/** The agent, as the picker offers it in a shared chat, where "@pi" is what calls it. */
const AGENT_CHOICE = { agent: true, detail: "agent · asks it to answer" } as const;
type Choice = MentionChoice | typeof AGENT_CHOICE;

/**
 * "@" in the composer: as the user types "@" (or presses the @ button), a list of the chat owner's files and
 * artifacts opens over the input, filtered by what follows the "@". Arrows move, Enter or Tab picks, Escape closes.
 * A pick puts `@<path>`, `@<title>` or `@<name>` in the text and is sent with the message while that text is still there.
 * In a `shared` chat (its `people`, and the viewer's `uid`) the agent comes first: "@pi" in a message is what calls it
 * there; then the others in the chat, who are told when a message tags them.
 */
export function useMentions(
  chatId: string,
  draft: string,
  setDraft: (text: string) => void,
  input: RefObject<HTMLTextAreaElement | null>,
  people: ChatPeople | null,
  uid: string,
) {
  const shared = people !== null;
  const [options, setOptions] = useState<MentionOptions | null>(null);
  const [picked, setPicked] = useState<Mention[]>([]);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  // Escape closes the list until the "@" it was for is gone or another is typed.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const loading = useRef(false);

  const typed = activeQuery(draft, caret);
  // A picked mention's "@" is done while its text is there and the caret is within or just after it, wherever the caret
  // came from; edit the text, or type on past it, and the list reopens.
  const done =
    typed !== null &&
    [...picked.map(mentionLabel), ...(shared ? [AGENT_NAME] : [])].some(
      (label) => draft.startsWith(`@${label}`, typed.start) && typed.query.trimEnd().length <= label.length,
    );
  const query = typed && !done && typed.start !== dismissedAt ? typed : null;

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

  // Everyone else in a shared chat: they are known before the files and artifacts load.
  const others = useMemo<MentionChoice[]>(
    () =>
      people
        ? everyone(people)
            .filter((person) => person.uid !== uid)
            .map((person) => ({
              mention: { kind: "person" as const, uid: person.uid, name: person.name },
              detail: person.uid === people.owner.uid ? "owner · gets a notice" : "in this chat · gets a notice",
            }))
        : [],
    [people, uid],
  );
  const all = useMemo<MentionChoice[]>(
    () =>
      options
        ? [
            ...options.artifacts.map((a) => ({
              mention: { kind: "artifact" as const, id: a.id, title: a.title },
              detail: `artifact · v${a.latest}${a.chatId === chatId ? " · this chat" : ""}`,
            })),
            ...options.files.map((f) => ({
              mention: { kind: "file" as const, path: f.path, ...(f.own && { own: true as const }) },
              detail: f.own ? `your file · ${formatBytes(f.size)}` : formatBytes(f.size),
            })),
          ]
        : [],
    [options, chatId],
  );
  const choices = useMemo<Choice[]>(() => {
    if (!query) return [];
    const callsAgent = shared && AGENT_NAME.startsWith(query.query.trim().toLowerCase());
    return [...(callsAgent ? [AGENT_CHOICE] : []), ...matchMentions([...others, ...all], query.query)];
  }, [all, others, query?.query, shared]);
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

  const pick = (choice: Choice) => {
    if (!query) return;
    // The agent is called by the text itself: nothing to send with the message.
    if ("agent" in choice) return replace(query.start, caret, `${AGENT_TOKEN} `);
    replace(query.start, caret, `${mentionToken(choice.mention)} `);
    // Its text now follows the "@", so the list closes for it (see `done`).
    setPicked((current) => (current.some((m) => sameMention(m, choice.mention)) ? current : [...current, choice.mention]));
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
  /** A message brought back to send again: what it named counts as picked again, so it goes with the text as before. */
  const restore = (mentions: readonly Mention[] = []) =>
    setPicked((current) => [...current, ...mentions.filter((mention) => !current.some((m) => sameMention(m, mention)))]);

  // The agent and the people are there before the files and artifacts have loaded.
  return { open, loaded: options !== null || choices.length > 0, choices, active, setActive, pick, onKeyDown, track, insertAt, take, clear, restore };
}

export function MentionList({ mentions }: { mentions: ReturnType<typeof useMentions> }) {
  const { open, loaded, choices, active, setActive, pick } = mentions;
  const people = useSharedChat();
  if (!open) return null;
  return (
    <div className="mention-list" role="listbox" aria-label={people ? "People, files and artifacts" : "Files and artifacts"}>
      {!loaded ? (
        <div className="mention-empty">Loading…</div>
      ) : choices.length === 0 ? (
        <div className="mention-empty">
          {people ? "No one, and no file or artifact, matches." : "No file or artifact matches."} Upload files from the sidebar.
        </div>
      ) : (
        choices.map((choice, i) => (
          <Fragment key={choiceKey(choice)}>
            {(i === 0 || choiceGroup(choices[i - 1]) !== choiceGroup(choice)) && (
              <div className="mention-group" role="presentation">
                {choiceGroup(choice)}
              </div>
            )}
            <button
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
              {"agent" in choice ? (
                <AgentAvatar />
              ) : choice.mention.kind === "person" && people ? (
                <Avatar name={choice.mention.name} tint={tintOf(people, choice.mention.uid)} />
              ) : (
                <span className="mention-icon">{choice.mention.kind === "file" ? "▤" : "▦"}</span>
              )}
              <span className="mention-label">{"agent" in choice ? AGENT_NAME : mentionLabel(choice.mention)}</span>
              <small>{choice.detail}</small>
            </button>
          </Fragment>
        ))
      )}
    </div>
  );
}

/** The heading a choice is listed under: the agent, people, then files and artifacts. */
function choiceGroup(choice: Choice): string {
  if ("agent" in choice) return "Agent";
  return { person: "People", file: "Files", artifact: "Artifacts" }[choice.mention.kind];
}

function choiceKey(choice: Choice): string {
  if ("agent" in choice) return "agent";
  const { mention } = choice;
  if (mention.kind === "person") return `p:${mention.uid}`;
  return mention.kind === "file" ? `f:${mention.own ? "own:" : ""}${mention.path}` : `a:${mention.id}`;
}

/**
 * A message's text with its mentions as chips: a file by its name (path on hover), an artifact as a link to its page,
 * a person in their colour (stronger where it is the viewer, `me`), and the agent where it was called.
 */
export function MentionText({ text, mentions, me }: { text: string; mentions?: Mention[]; me?: string }) {
  const people = useSharedChat();
  if (!text.includes("@")) return <>{text}</>;
  return (
    <>
      {splitMentions(text, mentions ?? []).map((part, i) =>
        typeof part === "string" ? (
          <AgentRun key={i} text={part} />
        ) : part.kind === "person" ? (
          <span
            key={i}
            className={part.uid === me ? "mention-chip person me" : "mention-chip person"}
            style={people ? tintStyle(tintOf(people, part.uid)) : undefined}
            title={part.uid === me ? "Mentions you" : `Mentions ${part.name}`}
          >
            @{part.name}
          </span>
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

/** Plain text, with the agent as a chip where it is called. */
function AgentRun({ text }: { text: string }) {
  return (
    <>
      {splitAgent(text).map((part, i) =>
        part.call ? (
          <span key={i} className="mention-chip agent" title={`Asks ${AGENT_NAME} to answer`}>
            {part.text}
          </span>
        ) : (
          part.text
        ),
      )}
    </>
  );
}
