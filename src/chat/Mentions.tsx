import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { ChatAgentView } from "../../shared/agents.ts";
import { baseName } from "../../shared/attachments.ts";
import {
  activeQuery,
  AGENT_NAME,
  splitCalls,
  keptMentions,
  matchPicks,
  mentionLabel,
  mentionToken,
  sameMention,
  splitMentions,
  type Mention,
  type MentionChoice,
  type MentionInput,
  type MentionOptions,
} from "../../shared/mentions.ts";
import { everyone, type ChatPeople, type Person } from "../../shared/protocol.ts";
import { formatBytes } from "../../shared/util.ts";
import { api } from "../api.ts";
import { AgentAvatar, Avatar, tintOf, tintStyle, toneStyle, useChatAgents, useSharedChat } from "./people.tsx";

/**
 * An agent as the picker offers it: pi, or another agent of the chat's roster (`view`), with its job line. Picking one
 * calls it: the text itself does, so nothing is sent with the message.
 */
type AgentPick = { agent: true; name: string; job: string; handleOnly?: boolean; view?: ChatAgentView };
/** For the owner, when nobody they know matches: tag the name anyway, and get an invite link to send them. */
type InviteChoice = { invite: string; detail: string };
type Choice = MentionChoice | AgentPick | InviteChoice;

const PI_CHOICE: AgentPick = { agent: true, name: AGENT_NAME, job: "the chat's assistant", handleOnly: true };

/** What "@" knows of the chat around it, besides its people and agents. */
export interface MentionsAround {
  /** The people the user shares other chats with, whom tagging offers to add (TagCard). */
  known?: readonly Person[];
  /** The user owns the chat: a name nobody matches can get an invite link. */
  canInvite?: boolean;
  /** All in the chat, the owner too, also in a chat nobody shares, where `people` is null: who is not an outsider. */
  inChat?: readonly Person[];
  /** Its agents answer only messages that call them (its kind): "@pi" is offered, even with nobody else in it yet. */
  callsOnly?: boolean;
}

const NOBODY: readonly Person[] = [];

/** Someone just tagged who is not in the chat: one the user knows, or (`invite`) a name nobody matched. */
export type Outsider = Person | { name: string; invite: true };

/**
 * "@" in the composer: as the user types "@" (or presses the @ button), a list of the chat owner's files and
 * artifacts opens over the input, filtered by what follows the "@". Arrows move, Enter or Tab picks, Escape closes.
 * A pick puts `@<path>`, `@<title>` or `@<name>` in the text and is sent with the message while that text is still there.
 * The chat's agents come first (`agents`, its roster, with pi in a `shared` chat or one with agents): "@name" in a
 * message is what calls one. Then, in a shared chat (its `people`, and the viewer's `uid`), the others in it, who are
 * told when a message tags them.
 */
export function useMentions(
  chatId: string,
  draft: string,
  setDraft: (text: string) => void,
  input: RefObject<HTMLTextAreaElement | null>,
  people: ChatPeople | null,
  uid: string,
  agents: readonly ChatAgentView[] = [],
  { known = NOBODY, canInvite = false, inChat = NOBODY, callsOnly = false }: MentionsAround = {},
) {
  const shared = people !== null;
  // pi is called by name in a chat whose agents answer only calls (with members, or of a kind that does even before
  // anyone joins), and in one with other agents (where a message that names only them is theirs).
  const callsPi = shared || callsOnly || agents.length > 0;
  const callable = useMemo<AgentPick[]>(
    () => (callsPi ? [PI_CHOICE, ...agents.map((view) => ({ agent: true as const, name: view.name, job: view.job, view }))] : []),
    [callsPi, agents],
  );
  // Names picked to invite by link: like a picked mention, their "@" is done (see `done`).
  const [invited, setInvited] = useState<string[]>([]);
  // The last person tagged who is not in the chat, until the user answers the card about them.
  const [outsider, setOutsider] = useState<Outsider | null>(null);
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
    [...picked.map(mentionLabel), ...callable.map((choice) => choice.name), ...invited].some(
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
  // The people the user knows who are not in the chat: tagging one asks whether to add them (TagCard).
  const outsiders = useMemo(() => {
    const here = new Set([uid, ...inChat.map((person) => person.uid)]);
    return known.filter((person) => !here.has(person.uid));
  }, [uid, inChat, known]);
  const others = useMemo<MentionChoice[]>(() => {
    const inside = people
      ? everyone(people)
          .filter((person) => person.uid !== uid)
          .map((person) => ({
            mention: { kind: "person" as const, uid: person.uid, name: person.name },
            detail: person.uid === people.owner.uid ? "owner · gets a notice" : "in this chat · gets a notice",
          }))
      : [];
    const known = outsiders.map((person) => ({ mention: { kind: "person" as const, uid: person.uid, name: person.name }, detail: "not in this chat" }));
    return [...inside, ...known];
  }, [people, uid, outsiders]);
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
    const matched = matchPicks(callable, [...others, ...all], query.query);
    // A name, typed in full, that is nobody the user knows and no agent's handle: the owner may invite them by link.
    const name = query.query.trim();
    const handle = [AGENT_NAME, ...agents.map((agent) => agent.name)].some((agent) => agent.toLowerCase().startsWith(name.toLowerCase()));
    const invite =
      canInvite &&
      !handle &&
      /^[\p{L}][\p{L}\p{N}._-]{1,31}$/u.test(name) &&
      !matched.some((choice) => "agent" in choice || choice.mention.kind === "person")
        ? [{ invite: name, detail: "not in this chat · invite by link" }]
        : [];
    return [...matched, ...invite];
  }, [all, others, query?.query, callable, canInvite, agents]);
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
    // An agent is called by the text itself: nothing to send with the message.
    if ("agent" in choice) return replace(query.start, caret, `@${choice.name} `);
    // Nobody to send either: the card offers an invite link.
    if ("invite" in choice) {
      setOutsider({ name: choice.invite, invite: true });
      setInvited((names) => (names.includes(choice.invite) ? names : [...names, choice.invite]));
      return replace(query.start, caret, `@${choice.invite} `);
    }
    const { mention } = choice;
    if (mention.kind === "person" && outsiders.some((person) => person.uid === mention.uid)) setOutsider({ uid: mention.uid, name: mention.name });
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
  const clear = () => {
    setPicked([]);
    setInvited([]);
  };
  /**
   * A message brought back to send again (`text`, with the caret at its end): what it named counts as picked again, so
   * it goes with the text as before, and an "@" at its end that named nothing does not open the list.
   */
  const restore = (text: string, mentions: readonly Mention[] = []) => {
    setPicked((current) => [...current, ...mentions.filter((mention) => !current.some((m) => sameMention(m, mention)))]);
    setDismissedAt(activeQuery(text, text.length)?.start ?? null);
    // Where the caret lands, so the list is not about the old draft's caret for a render (which could let go of the dismissal).
    setCaret(text.length);
  };

  // The agent and the people are there before the files and artifacts have loaded.
  return {
    open,
    loaded: options !== null || choices.length > 0,
    choices,
    active,
    setActive,
    pick,
    onKeyDown,
    track,
    insertAt,
    take,
    clear,
    restore,
    outsider,
    dismissOutsider: () => setOutsider(null),
  };
}

export function MentionList({ mentions, uid }: { mentions: ReturnType<typeof useMentions>; uid: string }) {
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
                <AgentAvatar badge={choice.view} />
              ) : "invite" in choice ? (
                <Avatar name={choice.invite} tint={0} />
              ) : choice.mention.kind === "person" ? (
                <Avatar name={choice.mention.name} tint={people ? tintOf(people, choice.mention.uid) : 0} />
              ) : (
                <span className="mention-icon">{choice.mention.kind === "file" ? "▤" : "▦"}</span>
              )}
              <span className="mention-label">{"agent" in choice ? choice.name : "invite" in choice ? choice.invite : mentionLabel(choice.mention)}</span>
              {"agent" in choice ? (
                <>
                  <small className="mention-job">{choice.job}</small>
                  {choice.view && <span className="owner-pill">{ownerLabel(choice.view, uid)}</span>}
                </>
              ) : (
                <small>{choice.detail}</small>
              )}
            </button>
          </Fragment>
        ))
      )}
    </div>
  );
}

/** Whose an agent is, as its pill in the picker and its menu say it: "yours", or its owner's name. */
export function ownerLabel(agent: Pick<ChatAgentView, "ownerUid" | "ownerName">, uid: string): string {
  return agent.ownerUid === uid ? "yours" : `${agent.ownerName}'s`;
}

/** The heading a choice is listed under: agents, people, then files and artifacts. */
function choiceGroup(choice: Choice): string {
  if ("agent" in choice) return "Agents";
  if ("invite" in choice) return "People";
  return { person: "People", file: "Files", artifact: "Artifacts" }[choice.mention.kind];
}

function choiceKey(choice: Choice): string {
  if ("agent" in choice) return `agent:${choice.name}`;
  if ("invite" in choice) return `i:${choice.invite}`;
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

/** Plain text, with pi and the chat's other agents as chips where they are called, each in its own colour. */
function AgentRun({ text }: { text: string }) {
  const agents = useChatAgents();
  const names = useMemo(() => agents.map((agent) => agent.name), [agents]);
  return (
    <>
      {splitCalls(text, names).map((part, i) => {
        if (!part.call) return part.text;
        const agent = agents.find((view) => view.name === part.call);
        return (
          <span
            key={i}
            className={agent ? "mention-chip agent toned" : "mention-chip agent"}
            style={agent && toneStyle(agent.color)}
            title={`Asks ${part.call} to answer`}
          >
            {part.text}
          </span>
        );
      })}
    </>
  );
}
