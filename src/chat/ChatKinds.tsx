import { createContext, useState } from "react";
import {
  answersEveryMessage,
  kindChoices,
  KIND_TEXT,
  narrows,
  widens,
  type ChatEventData,
  type ChatKind,
  type ChatPage,
} from "../../shared/chat-kinds.ts";
import { AGENT_TOKEN, AGENT_NAME } from "../../shared/mentions.ts";
import type { Person } from "../../shared/protocol.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";
import { opensElsewhere, useDismiss } from "../layout.tsx";
import type { Outsider } from "./Mentions.tsx";

/** Branch off a new chat from a transcript entry (ChatView provides it), and the entry a message's actions are for. */
export const BranchOff = createContext<((entry: number) => void) | null>(null);
export const EntryOf = createContext<number | undefined>(undefined);

/** A change of kind waiting for the owner to confirm it: who loses access, and what it means for the history. */
interface Pending {
  kind: ChatKind;
  loses: Person[];
}

/**
 * Beside the chat's title: its kind (shared/chat-kinds.ts). Its owner changes it from here. Narrowing lists who loses
 * access first, and removes exactly them when confirmed; widening says that everyone added sees the whole history.
 * Anyone else sees what the kind means.
 */
export function KindChip({ chatId, kind, page, isOwner }: { chatId: string; kind: ChatKind; page?: ChatPage; isOwner: boolean }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setPending(null);
      setError(null);
    }
  };
  const box = useDismiss<HTMLDivElement>(open, close);
  const text = KIND_TEXT[kind];
  const ask = async (to: ChatKind) => {
    setError(null);
    if (to === kind) return close(false);
    setBusy(true);
    try {
      const { loses } = await api.kindPreview(chatId, to);
      setPending({ kind: to, loses });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await api.changeKind(
        chatId,
        pending.kind,
        pending.loses.map((person) => person.uid),
      );
      close(false);
    } catch (e) {
      // Someone joined or left since the list was shown: show the new one, to confirm again.
      const loses = (e as { loses?: Person[] }).loses;
      if (loses) setPending({ kind: pending.kind, loses });
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="kind-chip-box" ref={box}>
      <button
        type="button"
        className={`kind-chip kind-${kind}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`${text.label}: ${text.who}. ${text.agents}.`}
        onClick={() => close(!open)}
      >
        {text.label}
        {isOwner && <span aria-hidden="true"> ▾</span>}
      </button>
      {open && (
        <div className="kind-panel" role="dialog" aria-label="What kind of chat this is">
          {!isOwner ? (
            <KindLines kind={kind} page={page} />
          ) : pending ? (
            <KindConfirm from={kind} pending={pending} busy={busy} onConfirm={() => void confirm()} onCancel={() => setPending(null)} />
          ) : (
            <ul className="kind-choices">
              {kindChoices(page !== undefined).map((choice) => (
                <li key={choice}>
                  <button type="button" className={choice === kind ? "kind-choice active" : "kind-choice"} aria-pressed={choice === kind} disabled={busy} onClick={() => void ask(choice)}>
                    <KindLines kind={choice} page={choice === "page" ? page : undefined} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error && <p className="form-error">{error}</p>}
        </div>
      )}
    </div>
  );
}

function KindLines({ kind, page }: { kind: ChatKind; page?: ChatPage }) {
  const text = KIND_TEXT[kind];
  return (
    <span className="kind-lines">
      <strong>{text.label}</strong>
      <span>
        {text.who}
        {page && <> · {page.title}</>}
      </span>
      <span>{text.agents}</span>
      <span>{text.leaves}</span>
    </span>
  );
}

/** The owner's last look before the kind changes: who loses access when narrowing, and that widening shows the history. */
function KindConfirm({ from, pending, busy, onConfirm, onCancel }: { from: ChatKind; pending: Pending; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const to = KIND_TEXT[pending.kind];
  return (
    <div className="kind-confirm">
      <strong>Make this chat {to.label.toLowerCase()}?</strong>
      {pending.loses.length > 0 && (
        <>
          <p>{pending.loses.length === 1 ? "This person loses access now:" : `These ${pending.loses.length} people lose access now:`}</p>
          <ul className="kind-loses">
            {pending.loses.map((person) => (
              <li key={person.uid}>{person.name}</li>
            ))}
          </ul>
        </>
      )}
      {widens(from, pending.kind) && <p>Everyone added from now on sees the whole history, including what was said before.</p>}
      {pending.kind === "off_record" && <p>From now on nothing leaves this chat: no memory notes, search, routines or feed previews.</p>}
      {from === "off_record" && <p>What is said from now on may leave this chat again: {to.leaves.toLowerCase()}.</p>}
      {answersEveryMessage(pending.kind) !== answersEveryMessage(from) && (
        <p>{answersEveryMessage(pending.kind) ? `${AGENT_NAME} will answer every message.` : `${AGENT_NAME} will answer only when someone calls ${AGENT_TOKEN}.`}</p>
      )}
      <div className="kind-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className={narrows(from, pending.kind) && pending.loses.length ? "danger" : "primary"} onClick={onConfirm} disabled={busy}>
          {pending.loses.length ? `Remove ${pending.loses.length === 1 ? "them" : "them all"} and change` : "Change"}
        </button>
      </div>
    </div>
  );
}

/** A transcript line about the chat itself (CHAT_EVENT_KIND): its kind changed, its page has a new version, a branch. */
export function ChatEventNotice({ data, uid, onOpenChat }: { data: ChatEventData; uid: string; onOpenChat?: (chatId: string) => void }) {
  const who = (person: Person) => (person.uid === uid ? "You" : person.name);
  const link = (chatId: string, title: string) => (
    <a
      href={`/c/${chatId}`}
      onClick={(event) => {
        if (!onOpenChat || opensElsewhere(event)) return;
        event.preventDefault();
        onOpenChat(chatId);
      }}
    >
      {title}
    </a>
  );
  if (data.event === "kind") {
    const label = KIND_TEXT[data.kind].label.toLowerCase();
    const removed = data.removed?.length ? ` · ${data.removed.map((person) => person.name).join(", ")} lost access` : "";
    const answers = answersEveryMessage(data.kind) !== answersEveryMessage(data.from);
    return (
      <>
        <div className="chat-notice">{data.by ? `${who(data.by)} made the chat ${label}${removed}` : `The chat is now ${data.kind === "group" ? "a group" : label}`}</div>
        {answers && (
          <div className="chat-notice">
            {answersEveryMessage(data.kind) ? `${AGENT_NAME} now answers every message` : `${AGENT_NAME} now answers only when someone calls ${AGENT_TOKEN}`}
          </div>
        )}
      </>
    );
  }
  if (data.event === "page") {
    return (
      <div className="chat-notice">
        <a href={`/a/${data.page.id}`} target="_blank" rel="noreferrer">
          {data.page.title}
        </a>{" "}
        has a new version, v{data.page.version}
      </div>
    );
  }
  if (data.event === "branch") {
    return (
      <div className="chat-notice branch-line">
        {who(data.by)} branched off {link(data.chatId, data.title)} from an earlier message
      </div>
    );
  }
  return (
    <div className="chat-notice branch-line">
      Above: the conversation this chat carries from {link(data.from.chatId, data.from.title)}, where {data.by.uid === uid ? "you" : data.by.name} branched it off
    </div>
  );
}

/**
 * Over the composer, once the user tagged someone who is not in the chat: adding them shows them everything said so
 * far. The owner adds them here; anyone else can start a new chat with them, with none of this one's messages.
 * `invite`: someone the user shares no chat with, whom only an invite link reaches.
 */
export function TagCard({
  person,
  isOwner,
  onNotNow,
  onAdd,
  onNewChat,
  onInvite,
}: {
  person: Outsider;
  isOwner: boolean;
  onNotNow: () => void;
  onAdd: () => Promise<void>;
  onNewChat: () => Promise<void>;
  /** Make an invite link: shown here, with Copy (a copy must come from the click itself, not after a request). */
  onInvite: () => Promise<string>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const run = (action: () => Promise<void>, after?: () => void) => async () => {
    setBusy(true);
    setError(null);
    try {
      await action();
      after?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const invite = "invite" in person;
  return (
    <div className="tag-card" role="alert">
      <p>
        <strong>@{person.name}</strong> isn't in this chat. Adding them shows them everything said so far.
      </p>
      {invite && !isOwner && <p className="tag-card-note">Only the chat's owner can invite people to it.</p>}
      <div className="tag-card-actions">
        <button type="button" onClick={onNotNow} disabled={busy}>
          Not now
        </button>
        {!invite && (
          <button type="button" onClick={run(onNewChat)} disabled={busy}>
            New chat with them
          </button>
        )}
        {isOwner &&
          (invite ? (
            !link && (
              <button type="button" className="primary" onClick={run(async () => setLink(await onInvite()))} disabled={busy}>
                Make an invite link
              </button>
            )
          ) : (
            <button type="button" className="primary" onClick={run(onAdd)} disabled={busy}>
              Add to this chat
            </button>
          ))}
      </div>
      {link && (
        <div className="tag-card-link">
          <input readOnly value={link} aria-label="Invite link" onFocus={(e) => e.target.select()} />
          <button
            type="button"
            className="primary"
            onClick={() =>
              void navigator.clipboard.writeText(link).then(
                () => setCopied(true),
                () => setError("Copying was not allowed: select the link and copy it."),
              )
            }
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
