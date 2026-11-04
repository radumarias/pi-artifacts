import { createContext, useContext } from "react";
import { AGENT_NAME } from "../../shared/mentions.ts";
import { everyone } from "../../shared/protocol.ts";
import { AGENT_REACTOR, REACTIONS, type Reaction, type Reactions } from "../../shared/reactions.ts";
import { listSome } from "../../shared/util.ts";
import { useSharedChat } from "./people.tsx";

/** The chat's reactions, who is looking (`uid`), and how to add or take back theirs. */
export interface ChatReactions {
  reactions: Reactions;
  uid: string;
  react: (entry: number, emoji: Reaction, on: boolean) => void;
}

export const ReactionsContext = createContext<ChatReactions | null>(null);

/** One message's reactions, and how to toggle the viewer's: nothing for a message that has no entry (one streaming). */
export function useMessageReactions(entry: number | undefined) {
  const chat = useContext(ReactionsContext);
  if (!chat || entry === undefined) return null;
  const mine = (emoji: Reaction) => chat.reactions[entry]?.[emoji]?.includes(chat.uid) ?? false;
  return {
    byEmoji: chat.reactions[entry] ?? {},
    uid: chat.uid,
    mine,
    toggle: (emoji: Reaction) => chat.react(entry, emoji, !mine(emoji)),
  };
}

/** The emoji to react with, in a row: in the hover bar's picker and at the top of the "…" menu. */
export function EmojiRow({ onPick, isMine }: { onPick: (emoji: Reaction) => void; isMine: (emoji: Reaction) => boolean }) {
  return (
    <div className="emoji-row" role="group" aria-label="React">
      {REACTIONS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          className={isMine(emoji) ? "mine" : undefined}
          onClick={() => onPick(emoji)}
          aria-pressed={isMine(emoji)}
          title={`React with ${emoji}`}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}

/**
 * Under a message: each emoji it got, how many people reacted with it and who (on hover), the viewer's own marked; a
 * click adds or takes back theirs. `picked` is the agent having picked the message up, shown as its 👀.
 */
export function ReactionChips({ entry, picked = false, mine = false }: { entry?: number; picked?: boolean; mine?: boolean }) {
  const reactions = useMessageReactions(entry);
  const people = useSharedChat();
  const byEmoji = { ...reactions?.byEmoji };
  if (picked && !byEmoji["👀"]?.includes(AGENT_REACTOR)) byEmoji["👀"] = [AGENT_REACTOR, ...(byEmoji["👀"] ?? [])];
  const shown = REACTIONS.filter((emoji) => byEmoji[emoji]?.length);
  if (shown.length === 0) return null;
  const names = new Map(people ? everyone(people).map((person) => [person.uid, person.name]) : []);
  const nameOf = (uid: string) => (uid === reactions?.uid ? "You" : uid === AGENT_REACTOR ? AGENT_NAME : (names.get(uid) ?? "Someone who left"));
  return (
    <div className={mine ? "reactions mine" : "reactions"}>
      {shown.map((emoji) => {
        const who = byEmoji[emoji]!;
        const label = `${listSome(who.map(nameOf), 10)} reacted with ${emoji}`;
        return reactions ? (
          <button
            key={emoji}
            type="button"
            className={reactions.mine(emoji) ? "reaction mine" : "reaction"}
            onClick={() => reactions.toggle(emoji)}
            aria-pressed={reactions.mine(emoji)}
            title={label}
            aria-label={label}
          >
            <span aria-hidden="true">{emoji}</span>
            <span className="reaction-count">{who.length}</span>
          </button>
        ) : (
          <span key={emoji} className="reaction" title={label} aria-label={label}>
            {emoji}
          </span>
        );
      })}
    </div>
  );
}
