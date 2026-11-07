import { createContext, useContext, useState } from "react";
import { defaultAvatar } from "../../shared/agents.ts";
import { actorName, type ActionActor, type ActionKind, type PendingActionView } from "../../shared/limits.ts";
import type { FeedAction } from "../../shared/feed.ts";
import { AGENT_NAME } from "../../shared/mentions.ts";
import { errorMessage } from "../../shared/util.ts";
import { decisionLabels, endedText, expiresText } from "../agents/limits/rules.ts";
import { api } from "../api.ts";
import { AgentAvatar } from "./people.tsx";
import { useClock } from "./SentTime.tsx";

/** What the chat's action cards read: each action's live state (the `actions` socket message), and who may decide. */
export interface ChatActionsView {
  actions: ReadonlyMap<string, PendingActionView>;
  /** The viewer owns the chat: only they run, approve or decline what waits in it. */
  isOwner: boolean;
  /** The owner's name, for anyone else: whom the action waits for. */
  ownerName?: string;
}

export const ChatActions = createContext<ChatActionsView>({ actions: new Map(), isOwner: false });

/** The input's JSON over this many lines is folded, with a button to show it all. */
const FOLD_LINES = 12;

/** Who made a call: pi's badge, an agent's own, or a page's letters on the quiet colour. */
function ActorBadge({ actor }: { actor: ActionActor }) {
  if (!actor.agentId && actor.name === AGENT_NAME) return <AgentAvatar />;
  return <AgentAvatar badge={{ avatar: actor.avatar || defaultAvatar(actor.name), color: actor.color ?? "slate" }} />;
}

/** What an actor does with a call, in words: proposes it (Recommend) or asks to make it (an approval). */
const verbOf = (kind: ActionKind) => (kind === "proposal" ? "proposes" : "asks to");

/**
 * Run or approve an action, or decline it, as its owner: what it came to, until the chat's own state of it says more
 * (the feed's item follows once it is resolved), and the error when the request failed.
 */
function useDecision<A extends FeedAction>(action: A) {
  const [after, setAfter] = useState<PendingActionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (decision: "approve" | "decline") => {
    setBusy(true);
    setError(null);
    try {
      setAfter(await api.decideAction(action.chatId, action.id, decision));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  // The live state wins once it moved on from waiting: it is the chat's, and newer than the answer kept here.
  const view: A | PendingActionView = after && action.status === "pending" ? after : action;
  return { view, busy, error, decide };
}

/** Approve and Decline (Run and Dismiss for a proposal), as the card and the feed show them. */
function DecisionButtons({
  kind,
  busy,
  decide,
  className,
}: {
  kind: ActionKind;
  busy: boolean;
  decide: (decision: "approve" | "decline") => void;
  className: string;
}) {
  const labels = decisionLabels(kind);
  return (
    <div className={className}>
      <button type="button" className="primary" disabled={busy} onClick={() => decide("approve")}>
        {labels.approve}
      </button>
      <button type="button" disabled={busy} onClick={() => decide("decline")}>
        {labels.decline}
      </button>
    </div>
  );
}

const TONES: Partial<Record<PendingActionView["status"], string>> = { done: "done", failed: "failed", running: "running" };

/**
 * A held call's card in the chat (a `chat.action` entry): who made it and that it proposes it (level 2) or asks to make
 * it (an approval), the exact call with its input, why it waits, the rules that warned, when it expires, and how it
 * ended. Its state is the chat's, live; the entry's own is how it was made. Only the chat's owner gets the buttons.
 */
export function ActionCard({ action: made }: { action: PendingActionView }) {
  const { actions, isOwner, ownerName } = useContext(ChatActions);
  const live = actions.get(made.id) ?? made;
  const { view, busy, error, decide } = useDecision(live);
  const waiting = view.status === "pending";
  const now = useClock(waiting);
  const ended = endedText(view, now);
  const open = waiting && view.expiresAt > now;
  const tone = ended === null ? "pending" : (TONES[view.status] ?? "closed");
  return (
    <article className={`action-card ${tone}`} aria-label={`${actorName(view.actor)} ${verbOf(view.kind)} ${view.server}.${view.tool}`}>
      <header className="action-card-head">
        <ActorBadge actor={view.actor} />
        <div className="action-card-title">
          <span>
            <strong>{actorName(view.actor)}</strong> {verbOf(view.kind)}{" "}
            <code>
              {view.server}.{view.tool}
            </code>
          </span>
          <small>{view.why}</small>
        </div>
        {open && <span className="pill action-expiry">{expiresText(view.expiresAt, now)}</span>}
      </header>
      <CallInput input={view.input} />
      {view.warnings && view.warnings.length > 0 && (
        <ul className="action-warnings" aria-label="Warnings">
          {view.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      {ended !== null ? (
        <p className="action-ended">{ended}</p>
      ) : isOwner ? (
        <DecisionButtons className="action-buttons" kind={view.kind} busy={busy} decide={(decision) => void decide(decision)} />
      ) : (
        <p className="action-ended">
          Waits for {ownerName ?? "the chat’s owner"} to {view.kind === "proposal" ? "run it" : "approve it"}.
        </p>
      )}
      {error && <p className="form-error">{error}</p>}
    </article>
  );
}

/** A call's input as pretty JSON, folded when long. */
export function CallInput({ input }: { input: unknown }) {
  const [open, setOpen] = useState(false);
  const text = JSON.stringify(input, null, 2) ?? "";
  const lines = text.split("\n");
  const long = lines.length > FOLD_LINES;
  return (
    <div className="action-input">
      <pre>
        <code>{long && !open ? `${lines.slice(0, FOLD_LINES).join("\n")}\n…` : text}</code>
      </pre>
      {long && (
        <button type="button" className="link-button" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

/**
 * An approval's Approve and Decline in the feed (Run and Dismiss for a proposal), while it waits, with when it expires; once decided
 * here, what came of it. One decided elsewhere (its card in the chat) or expired waits no more, and shows nothing.
 */
export function ActionDecision({ action, waiting }: { action: FeedAction; waiting: boolean }) {
  const { view, busy, error, decide } = useDecision(action);
  const decidedHere = view !== action;
  const now = useClock(view.status === "pending" && (waiting || decidedHere));
  const ended = endedText(view, now);
  // A resolved item says how its action ended, as it kept it; one resolved without saying (an older item) says nothing.
  if (!waiting && !decidedHere && view.status === "pending") return null;
  return (
    <div className="feed-decision">
      {ended !== null ? (
        <small>{ended}</small>
      ) : (
        <>
          <DecisionButtons className="feed-decision-buttons" kind={view.kind} busy={busy} decide={(decision) => void decide(decision)} />
          <small>{expiresText(view.expiresAt, now)}</small>
        </>
      )}
      {error && <small className="form-error">{error}</small>}
    </div>
  );
}
