import { useCallback, useEffect, useId, useState } from "react";
import { isDraftAgent, MAX_CHAT_AGENTS, type AgentDefinition, type AgentTurnView, type ChatAgentView } from "../../shared/agents.ts";
import { AGENT_NAME } from "../../shared/mentions.ts";
import { everyone, type ChatPeople, type Presence } from "../../shared/protocol.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";
import { Icon } from "../Icon.tsx";
import { useDismiss } from "../layout.tsx";
import { callerName, turnLine } from "./agentLines.ts";
import { formatElapsed, useElapsed } from "./elapsed.ts";
import { ownerLabel } from "./Mentions.tsx";
import { AgentAvatar, Avatar, tintOf } from "./people.tsx";
import { SentTime } from "./SentTime.tsx";
import type { AgentsLive } from "./useChat.ts";

/** What an agent is doing, as its badge's hover and its menu say it. */
function agentState(agent: ChatAgentView): string {
  if (agent.off) return "off: its owner turned it off";
  if (agent.busy) return agent.queued ? `working, ${agent.queued} more waiting` : "working";
  return agent.queued ? `${agent.queued} waiting` : "idle";
}

/**
 * Who is in the chat: its people first, each in their colour with a dot for those who have it open now; then, after a
 * divider, pi and the chat's other agents, each with its own badge colour, a dot on the one working and a faded badge
 * for one its owner turned off. Names, job lines and owners show on hover. Each agent opens a menu: what it does, its
 * latest turns, and for the owner Remove. The owner's Agents button adds agents. Without `bar` (a chat of the owner alone,
 * with no agents yet) only that button shows.
 */
export function PeopleBar({
  chatId,
  people,
  online,
  uid,
  piWorking,
  agents,
  live,
  bar = true,
}: {
  chatId: string;
  people: ChatPeople;
  online: readonly Presence[];
  uid: string;
  piWorking: boolean;
  agents: readonly ChatAgentView[];
  /** The agents' live turns, for when each started as this socket heard it (useChat). */
  live: AgentsLive;
  bar?: boolean;
}) {
  // Each open window is a socket; someone no longer in the chat may still show for a moment, so only people in it count.
  const windows = new Map(online.map((presence) => [presence.uid, presence.windows]));
  const all = everyone(people);
  const here = all.filter((person) => windows.has(person.uid)).length;
  const isOwner = people.owner.uid === uid;
  // One popup at a time: an agent's menu (by its id), or the owner's list of agents to add.
  const [open, setOpen] = useState<string | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const box = useDismiss<HTMLDivElement>(open !== null, close);
  const agent = open && agents.find((view) => view.id === open);
  return (
    <div className="people-area" ref={box}>
      {bar && (
      <div className="people-bar" aria-label={`${all.length} ${all.length === 1 ? "person" : "people"}, ${here} here now; ${agents.length + 1} agents`}>
        {all.map((person) => {
          const count = windows.get(person.uid) ?? 0;
          const you = person.uid === uid;
          const state = count === 0 ? "away" : count > 1 ? `here now, in ${count} windows` : "here now";
          return (
            <span key={person.uid} className={count ? "person online" : "person"} title={`${person.name}${you ? " (you)" : ""}: ${state}`}>
              <Avatar name={person.name} tint={tintOf(people, person.uid)} online={count > 0} />
              <span className="sr-only">
                {you ? "You" : person.name}
                {count > 1 && <small> ×{count}</small>}
              </span>
            </span>
          );
        })}
        <span className="people-divider" aria-hidden="true" />
        <span className="person agent" title={`${AGENT_NAME}, the chat's assistant: ${piWorking ? "working" : "idle"}`}>
          <AgentAvatar working={piWorking} />
          <span className="sr-only">
            {AGENT_NAME}
            {piWorking && <small> working</small>}
          </span>
        </span>
        {agents.map((view) => (
          <button
            key={view.id}
            type="button"
            className={view.off ? "person agent off" : "person agent"}
            title={`@${view.name} · ${view.job} · ${ownerLabel(view, uid)} · ${agentState(view)}`}
            aria-expanded={open === view.id}
            onClick={() => setOpen(open === view.id ? null : view.id)}
          >
            <AgentAvatar badge={view} working={view.busy} off={view.off} />
            <span className="sr-only">
              @{view.name}, {agentState(view)}
            </span>
          </button>
        ))}
      </div>
      )}
      {isOwner && (
        <button
          type="button"
          className="icon-button agents-button"
          onClick={() => setOpen(open === ADDING ? null : ADDING)}
          aria-expanded={open === ADDING}
          title="Agents in this chat"
          aria-label="Agents in this chat"
        >
          <Icon size={16} stroke={1.8}>
            <rect x="5" y="7" width="14" height="11" rx="3" />
            <path d="M12 4v3M9.5 12h.01M14.5 12h.01" />
          </Icon>
        </button>
      )}
      {agent && (
        <AgentMenu
          key={agent.id}
          chatId={chatId}
          agent={agent}
          startedAt={live[agent.id]?.turn === agent.running?.turn ? live[agent.id]?.startedAt : undefined}
          uid={uid}
          isOwner={isOwner}
          onClose={close}
        />
      )}
      {open === ADDING && <AddAgents chatId={chatId} roster={agents} onClose={close} />}
    </div>
  );
}

/** The key of the owner's list of agents to add, among the bar's popups. */
const ADDING = "+agents";

/** How many of an agent's latest turns its menu lists. */
const RUNS_SHOWN = 8;

/**
 * An agent's menu, from its badge in the people bar: its job line and owner, what it is doing, its latest turns (who
 * asked, when, how long, how it ended), read when the menu opens, and for the chat's owner, Remove.
 */
function AgentMenu({
  chatId,
  agent,
  startedAt,
  uid,
  isOwner,
  onClose,
}: {
  chatId: string;
  agent: ChatAgentView;
  startedAt?: number;
  uid: string;
  isOwner: boolean;
  onClose: () => void;
}) {
  const [turns, setTurns] = useState<AgentTurnView[] | null>(null);
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState(false);
  const title = useId();
  // Read again when it starts or ends a turn, so the list keeps up while the menu is open.
  const running = agent.running?.turn;
  useEffect(() => {
    let live = true;
    api.chatAgents(chatId).then(
      (all) => live && setTurns(all.turns[agent.id]?.slice(0, RUNS_SHOWN) ?? []),
      (e: unknown) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [chatId, agent.id, running, agent.queued]);
  const remove = async () => {
    setRemoving(true);
    try {
      await api.removeChatAgent(chatId, agent.id);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setRemoving(false);
    }
  };
  return (
    <div className="agent-menu" role="dialog" aria-labelledby={title}>
      <div className="agent-menu-head">
        <AgentAvatar badge={agent} working={agent.busy} off={agent.off} />
        <strong id={title}>@{agent.name}</strong>
        <span className="owner-pill">{ownerLabel(agent, uid)}</span>
      </div>
      <p className="agent-menu-job">{agent.job}</p>
      <p className="agent-menu-state">
        {/* Keyed by its turn: a new turn counts from its own start, not the one before's. */}
        {agent.running ? <Working key={agent.running.turn} running={agent.running} startedAt={startedAt} /> : agentState(agent)}
      </p>
      <div className="section-head">Runs</div>
      {turns === null && !error && <p className="agent-menu-empty">Loading…</p>}
      {turns?.length === 0 && <p className="agent-menu-empty">No turns yet: call it with @{agent.name}.</p>}
      {turns && turns.length > 0 && (
        <ul className="agent-runs">
          {turns.map((turn) => (
            <li key={turn.id} className={`agent-run ${turn.status}`}>
              <span>{turnLine(turn, Date.now())}</span>
              <SentTime at={turn.endedAt ?? turn.startedAt ?? turn.createdAt} />
            </li>
          ))}
        </ul>
      )}
      {error && <div className="chat-error">{error}</div>}
      {isOwner && (
        <button type="button" className="danger" onClick={remove} disabled={removing}>
          {removing ? "Removing…" : "Remove from this chat"}
        </button>
      )}
    </div>
  );
}

/** How long since `at`, counting on each second. */
export function Since({ at }: { at: number }) {
  return <>{formatElapsed(useElapsed(at))}</>;
}

/**
 * "Working for 12s, Ana asked", counting on from when the turn started: as the socket heard it (`startedAt`, set when
 * the roster's view arrived), else from the view's own elapsed time.
 */
function Working({ running, startedAt: heard }: { running: NonNullable<ChatAgentView["running"]>; startedAt?: number }) {
  const [fallback] = useState(() => Date.now() - running.elapsedMs);
  const startedAt = heard ?? fallback;
  return (
    <>
      Working for <Since at={startedAt} />, {running.calledBy.schedule ? "on its schedule" : `${callerName(running.calledBy)} asked`}
    </>
  );
}

/**
 * The owner's list of their agents that are on and not in the chat yet, each with Add: the agent joins the chat's roster
 * and answers when called. Drafts the model proposed wait for their owner in the agent editor, and do not show.
 */
function AddAgents({ chatId, roster, onClose }: { chatId: string; roster: readonly ChatAgentView[]; onClose: () => void }) {
  const [mine, setMine] = useState<AgentDefinition[] | null>(null);
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.agents().then(
      (agents) => live && setMine(agents),
      (e: unknown) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  const here = new Set(roster.map((agent) => agent.id));
  const addable = mine?.filter((agent) => agent.enabled && !isDraftAgent(agent) && !here.has(agent.id)) ?? [];
  const full = roster.length >= MAX_CHAT_AGENTS;
  const add = async (agent: AgentDefinition) => {
    setAdding(agent.id);
    setError(undefined);
    try {
      await api.addChatAgent(chatId, agent.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setAdding(null);
    }
  };
  return (
    <div className="agent-menu add-agents" role="dialog" aria-label="Add agents to this chat">
      <div className="agent-menu-head">
        <strong>Agents</strong>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close" title="Close">
          ×
        </button>
      </div>
      <p className="agent-menu-job">
        Agents answer when someone calls them with @name or replies to them, and work as you. Remove one from its badge in the bar.
      </p>
      {mine === null && !error && <p className="agent-menu-empty">Loading…</p>}
      {mine && addable.length === 0 && (
        <p className="agent-menu-empty">{mine.length ? "All your agents that are on are in this chat." : "You have no agents yet."}</p>
      )}
      {addable.length > 0 && (
        <ul className="agent-runs">
          {addable.map((agent) => (
            <li key={agent.id} className="agent-pick">
              <AgentAvatar badge={agent} />
              <span className="agent-pick-name">
                <strong>@{agent.name}</strong>
                <small>{agent.job}</small>
              </span>
              <button type="button" onClick={() => add(agent)} disabled={adding !== null || full} title={full ? `A chat holds at most ${MAX_CHAT_AGENTS} agents` : undefined}>
                {adding === agent.id ? "Adding…" : "Add"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <div className="chat-error">{error}</div>}
    </div>
  );
}
