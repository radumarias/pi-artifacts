import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import {
  COPIED_FIELDS,
  type AgentChatUse,
  type AgentChanges,
  type AgentDefinition,
  type AgentInput,
  type SharedAgentView,
} from "../../shared/agents.ts";
import type { ChatSummary } from "../../shared/protocol.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";
import { AgentAvatar } from "../chat/people.tsx";
import { MenuButton, opensElsewhere } from "../layout.tsx";
import { AgentTabs } from "./AgentTabs.tsx";
import { SAVE_FIRST, stateLabel } from "./glance.ts";
import { agentPath, NEW_AGENT, type AgentPlace } from "./nav.ts";
import { RunsTab } from "./RunsTab.tsx";
import { SetupTab } from "./SetupTab.tsx";
import { KnowsTab } from "../memory/KnowsTab.tsx";
import { WorkflowTab } from "./WorkflowTab.tsx";
import { dropAgent, putAgent, reloadAgents, useAgents } from "./store.ts";
import { FollowButton } from "../feed/FeedNav.tsx";

/**
 * What the page shows: one of the user's own agents, a new one being made, or someone else's that a chat shares with
 * them (read-only: a change saves their own copy).
 */
export type AgentSubject =
  | { kind: "own"; agent: AgentDefinition }
  | { kind: "new" }
  | { kind: "shared"; agent: SharedAgentView; chatId: string; chatTitle?: string };

/** What every tab of the agent page is given. */
export interface AgentTabProps {
  subject: AgentSubject;
  /** The field to scroll to and focus as the tab opens (a draft card's Change). */
  field?: string;
  /**
   * Save the tab's changes: the user's own agent changed from `version` (the one the tab started from), a new one made,
   * or for a shared one their own copy of `version`. Resolves with what was saved; rejects with the reason, shown by the tab.
   */
  save: (fields: AgentInput, version: number | undefined) => Promise<AgentDefinition>;
  /** Say something under the header that outlasts the tab (which starts again for another agent): a save, a conflict. */
  notice: (notice: PageNotice | null) => void;
  /** Whether the tab has changes not saved yet: the header holds what would make a new version meanwhile. */
  onDirty?: (dirty: boolean) => void;
  /** Where the page is (a tab that opens deeper, as Runs on one run, reads it) and how to go elsewhere in the app. */
  place: AgentPlace;
  navigate: (path: string) => void;
}

/** A line under the page's header, about one agent: the page of another says nothing of it. */
export interface PageNotice {
  agentId: string;
  text: string;
  error?: boolean;
}

/** What a tab saves without editing: the rest of the definition (its trigger, scope, workflow, autonomy) stays as it is. */
const KEPT = [...COPIED_FIELDS, "autonomy", "reviewBeforePosting"] as const satisfies readonly (keyof AgentInput)[];

/** A tab of the agent page. Later tabs (workflow and runs, limits, what it knows) add themselves here. */
export interface AgentTab {
  id: string;
  label: string;
  /** The fields it edits: a Change for one of them opens this tab. */
  fields: readonly string[];
  Component: ComponentType<AgentTabProps>;
}

export const TABS: AgentTab[] = [
  {
    id: "setup",
    label: "Setup",
    fields: ["name", "job", "instructions", "avatar", "color", "model", "effort", "servers", "sharedServers", "reviewBeforePosting"],
    Component: SetupTab,
  },
  { id: "workflow", label: "Workflow", fields: ["trigger", "scope", "workflow"], Component: WorkflowTab },
  { id: "runs", label: "Runs", fields: [], Component: RunsTab },
  { id: "knows", label: "Knows", fields: [], Component: KnowsTab },
];

/** The tab a place opens: the one asked for, else the one that edits its field, else the first. */
export function tabFor(tabs: readonly AgentTab[], place: Pick<AgentPlace, "tab" | "field">): AgentTab {
  return tabs.find((tab) => tab.id === place.tab) ?? tabs.find((tab) => place.field && tab.fields.includes(place.field)) ?? tabs[0];
}

/**
 * An agent's page: its header (badge, name, job line, whether it is on, Turn on or off, Delete) and its tabs, of which
 * this one has Setup. Someone else's agent, shared in a chat, opens read-only, saying whose it is and that it runs as
 * them; their first change saves their own copy.
 */
export function AgentPage({
  place,
  chats,
  navigate,
  onMenu,
}: {
  place: AgentPlace;
  chats: readonly ChatSummary[];
  navigate: (path: string) => void;
  onMenu?: () => void;
}) {
  const { agents, error: listError } = useAgents();
  const [notice, setNotice] = useState<PageNotice | null>(null);
  const [dirty, setDirty] = useState(false);
  const own = agents?.find((agent) => agent.id === place.id);
  // Someone else's agent, as the chat it was opened from shares it.
  const [shared, setShared] = useState<SharedAgentView | null>(null);
  const [sharedError, setSharedError] = useState<string | null>(null);
  const lookShared = place.id !== NEW_AGENT && agents !== null && !own && place.chat !== undefined;
  useEffect(() => {
    if (!lookShared || !place.chat) return;
    let live = true;
    setSharedError(null);
    api.sharedAgent(place.chat, place.id).then(
      (view) => live && setShared(view),
      (error: unknown) => live && setSharedError(errorMessage(error)),
    );
    return () => {
      live = false;
    };
  }, [lookShared, place.chat, place.id]);

  const chatTitle = place.chat && chats.find((chat) => chat.id === place.chat)?.title;
  const subject: AgentSubject | null =
    place.id === NEW_AGENT
      ? { kind: "new" }
      : own
        ? { kind: "own", agent: own }
        : shared && shared.id === place.id && place.chat
          ? { kind: "shared", agent: shared, chatId: place.chat, chatTitle }
          : null;

  const tab = tabFor(TABS, place);
  const save = useCallback(
    async (fields: AgentInput, version: number | undefined): Promise<AgentDefinition> => {
      if (!subject) throw new Error("This agent is not loaded yet.");
      let saved: AgentDefinition;
      if (subject.kind === "own") {
        const { agent } = subject;
        const kept = Object.fromEntries(KEPT.filter((key) => !tab.fields.includes(key)).map((key) => [key, agent[key]]));
        // The version the tab started from: a change made since is refused, rather than undone.
        saved = await api.saveAgent(agent.id, { ...kept, ...fields, version: version ?? agent.version });
      } else if (subject.kind === "new") saved = await api.createAgent(fields);
      else {
        // A copy takes what the tab leaves out from the original, so what the tab cleared is said as cleared (null).
        const cleared: AgentChanges = Object.fromEntries(tab.fields.map((key) => [key, null]));
        saved = await api.copyAgent(subject.chatId, subject.agent.id, { ...cleared, ...fields, version: version ?? subject.agent.version });
      }
      // The user directory tells the sidebar's socket too, which reads the list again.
      putAgent(saved);
      if (subject.kind !== "own") navigate(agentPath({ id: saved.id }));
      return saved;
    },
    [subject, tab, navigate],
  );

  const back = place.chat && (
    <a
      className="agent-back"
      href={`/c/${place.chat}`}
      onClick={(event) => {
        if (opensElsewhere(event)) return;
        event.preventDefault();
        navigate(`/c/${place.chat}`);
      }}
    >
      ← Back to {chatTitle ? `“${chatTitle}”` : "the chat"}
    </a>
  );

  if (!subject) {
    const failed = (lookShared && sharedError) || listError;
    const gone = agents !== null && !own && !lookShared;
    return (
      <div className="agent-page">
        {onMenu && <MenuButton onClick={onMenu} />}
        {back}
        <p className={failed || gone ? "form-error" : "skills-note"}>
          {failed ? `Could not open this agent: ${failed}` : gone ? "This agent is not yours, or it was deleted." : "Loading the agent…"}
        </p>
      </div>
    );
  }

  return (
    <div className="agent-page">
      {back}
      {/* Its own state (a delete being asked) is about one agent: another starts with none. */}
      <AgentHeader key={place.id} subject={subject} navigate={navigate} onMenu={onMenu} dirty={dirty} />
      {notice?.agentId === place.id && (
        <p className={notice.error ? "form-error agent-notice" : "skills-note agent-notice"} role="status">
          {notice.text}
        </p>
      )}
      <AgentTabs tabs={TABS} current={tab.id} dirty={dirty} open={(id) => navigate(agentPath({ id: place.id, tab: id, chat: place.chat }))} />
      <div role="tabpanel" aria-label={tab.label}>
        {/* A new tab state for each agent; a tab follows its newer versions itself, keeping changes not yet saved. */}
        <tab.Component
          key={subject.kind === "new" ? NEW_AGENT : subject.agent.id}
          subject={subject}
          field={place.field}
          save={save}
          notice={setNotice}
          onDirty={setDirty}
          place={place}
          navigate={navigate}
        />
      </div>
    </div>
  );
}

/** The page's top: badge, name, job line, the state pill, and for the user's own agent Turn on or off and Delete. */
function AgentHeader({
  subject,
  navigate,
  onMenu,
  dirty,
}: {
  subject: AgentSubject;
  navigate: (path: string) => void;
  onMenu?: () => void;
  /** The tab has changes not saved: turning it on or off makes a new version, which would start the tab again. */
  dirty: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<AgentChatUse[] | null>(null);
  if (subject.kind === "new") {
    return (
      <header className="agent-head">
        {onMenu && <MenuButton onClick={onMenu} />}
        <div className="agent-head-text">
          <h2>New agent</h2>
          <p>A helper with its own name, job and instructions, that people call in a chat with @name.</p>
        </div>
      </header>
    );
  }
  const { agent } = subject;
  const turn = async (mine: AgentDefinition, on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      putAgent(await api.setAgentEnabled(mine, on));
    } catch (e) {
      setError(errorMessage(e));
      void reloadAgents();
    } finally {
      setBusy(false);
    }
  };
  const askDelete = async () => {
    setError(null);
    try {
      setDeleting(await api.agentChats(agent.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const state = subject.kind === "own" && stateLabel(subject.agent);
  return (
    <header className="agent-head">
      {onMenu && <MenuButton onClick={onMenu} />}
      <AgentAvatar badge={agent} />
      <div className="agent-head-text">
        <h2>{agent.name}</h2>
        <p>{agent.job}</p>
      </div>
      <div className="agent-head-actions">
        {subject.kind === "own" && state ? (
          <>
            <span className={`pill agent-state ${state.tone}`}>{state.text}</span>
            <button
              type="button"
              className={subject.agent.enabled ? undefined : "primary"}
              disabled={busy || dirty}
              title={dirty ? SAVE_FIRST : undefined}
              onClick={() => void turn(subject.agent, !subject.agent.enabled)}
            >
              {subject.agent.enabled ? "Turn off" : "Turn on"}
            </button>
            <button type="button" disabled={busy} onClick={() => void askDelete()}>
              Delete
            </button>
          </>
        ) : (
          subject.kind === "shared" && (
            <>
              <span className="pill agent-state off">{subject.agent.ownerName}’s · read-only</span>
              {/* Its posts reach the follower's feed while its owner shares it in this chat, and they are in it. */}
              <FollowButton kind="agent" id={subject.agent.id} chatId={subject.chatId} ownerUid={subject.agent.ownerUid} />
            </>
          )
        )}
      </div>
      {error && <p className="form-error agent-head-note">{error}</p>}
      {deleting && <DeleteAgent agent={agent} chats={deleting} onClose={() => setDeleting(null)} onDeleted={() => navigate("/")} />}
    </header>
  );
}

/** Asks before deleting an agent, naming the chats it leaves; Escape and Cancel close it, not while it is being deleted. */
function DeleteAgent({
  agent,
  chats,
  onClose,
  onDeleted,
}: {
  agent: Pick<AgentDefinition, "id" | "name">;
  chats: readonly AgentChatUse[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => dialog.current?.showModal(), []);
  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      await api.deleteAgent(agent.id);
      dropAgent(agent.id);
      onDeleted();
    } catch (e) {
      setError(errorMessage(e));
      setDeleting(false);
    }
  };
  return (
    <dialog ref={dialog} className="confirm-dialog" onClose={onClose} onCancel={(e) => deleting && e.preventDefault()}>
      <h2>Delete @{agent.name}?</h2>
      {chats.length ? (
        <>
          <p>It leaves {chats.length === 1 ? "the chat" : `the ${chats.length} chats`} it is in; its past replies stay in them:</p>
          <ul className="confirm-list">
            {chats.map((use) => (
              <li key={use.chatId}>{use.title}</li>
            ))}
          </ul>
        </>
      ) : (
        <p>It is in no chat.</p>
      )}
      <p>This cannot be undone.</p>
      {error && <p className="form-error">{error}</p>}
      <div className="confirm-actions">
        <button type="button" disabled={deleting} onClick={() => dialog.current?.close()}>
          Cancel
        </button>
        <button type="button" className="danger" disabled={deleting} onClick={() => void remove()}>
          {deleting ? "Deleting…" : "Delete"}
        </button>
      </div>
    </dialog>
  );
}
