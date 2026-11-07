import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import {
  AGENT_COLORS,
  defaultAvatar,
  MAX_AGENT_AVATAR,
  MAX_AGENT_INSTRUCTIONS,
  MAX_AGENT_JOB,
  type AgentChatUse,
  type AgentColor,
  type AgentInput,
  type AgentServerInfo,
  type AgentTurnView,
} from "../../shared/agents.ts";
import { AUTO_MODEL } from "../../shared/models.ts";
import { errorMessage, plural, singleFlight } from "../../shared/util.ts";
import { api } from "../api.ts";
import { ModelPicker, useCatalog } from "../chat/ModelPicker.tsx";
import { AgentAvatar } from "../chat/people.tsx";
import { opensElsewhere } from "../layout.tsx";
import { sentLabel } from "../chat/SentTime.tsx";
import type { AgentSubject, AgentTabProps } from "./AgentPage.tsx";
import { AssumedBadge } from "./AssumedBadge.tsx";
import { ASSUMED_FIELDS, CONFLICT_NOTICE, isAssumed, isConflict, withoutAssumed } from "./glance.ts";
import { goTo } from "./nav.ts";
import { reloadAgents } from "./store.ts";

/** What Auto means for an agent: the model of the chat it answers in. Stable, so the memoized picker keeps it. */
const CHAT_MODEL = { name: "Chat's model", hint: "Answers with the model of the chat it is in" };

/** The form's fields, as typed: the server lists as sets, null where the definition leaves them to the default. */
interface Form {
  name: string;
  job: string;
  instructions: string;
  avatar: string;
  color: AgentColor | "";
  model: string;
  effort?: ModelThinkingLevel;
  servers: Set<string> | null;
  sharedServers: Set<string> | null;
  /** A reply built on a server it does not share with the chat shows first as a draft only its owner sees. */
  review: boolean;
  /** It may post unprompted in chats that allow it (AgentDefinition.speaksUp). */
  speaksUp: boolean;
  assumed: string[];
}

/** The fields of the Setup tab that a guess of the model can be about, by the name the form gives each. */
const SETUP_ASSUMED: Record<string, readonly string[]> = {
  name: ["name"],
  job: ["job"],
  instructions: ["instructions"],
  avatar: ["avatar", "color"],
  model: ["model", "effort"],
  servers: ASSUMED_FIELDS.reads,
};

/** The version of the definition a form shows; none for a new one. */
const versionOf = (subject: AgentSubject) => (subject.kind === "new" ? undefined : subject.agent.version);

/** The deployment's MCP servers, one read for the forms open at once: read again as a form opens, so a sign-in shows. */
const readServers = singleFlight(api.agentServers);

/** Fields shown together with another one: a Change for them opens that one. */
const SHOWN_WITH: Record<string, string> = { effort: "model", sharedServers: "servers" };

function formOf(subject: AgentSubject): Form {
  if (subject.kind === "new")
    return {
      name: "",
      job: "",
      instructions: "",
      avatar: "",
      color: "",
      model: AUTO_MODEL,
      servers: null,
      sharedServers: null,
      review: false,
      speaksUp: false,
      assumed: [],
    };
  const { agent } = subject;
  return {
    name: agent.name,
    job: agent.job,
    instructions: agent.instructions,
    avatar: agent.avatar,
    color: agent.color,
    model: agent.model ?? AUTO_MODEL,
    effort: agent.effort,
    servers: agent.servers ? new Set(agent.servers) : null,
    sharedServers: agent.sharedServers ? new Set(agent.sharedServers) : null,
    review: "reviewBeforePosting" in agent && agent.reviewBeforePosting === true,
    speaksUp: agent.speaksUp === true,
    assumed: subject.kind === "own" ? (subject.agent.assumed ?? []) : [],
  };
}

/** The servers an agent may use, as the form shows them: those it lists, else every one. */
const usable = (form: Form, servers: readonly AgentServerInfo[]) => form.servers ?? new Set(servers.map((server) => server.name));
/** The servers others in a shared chat can make it use: those it lists, else those it may use that sign in nobody. */
const sharable = (form: Form, servers: readonly AgentServerInfo[]) => {
  const own = usable(form, servers);
  return form.sharedServers ?? new Set(servers.filter((server) => !server.signsIn && own.has(server.name)).map((server) => server.name));
};

/** The definition's fields from the form: the server lists only once the user changed them, so a default stays one. */
function inputOf(form: Form): AgentInput {
  const sorted = (set: Set<string>) => [...set].sort();
  return {
    name: form.name.trim().toLowerCase(),
    job: form.job,
    instructions: form.instructions,
    ...(form.avatar.trim() && { avatar: form.avatar.trim() }),
    ...(form.color && { color: form.color }),
    ...(form.model !== AUTO_MODEL && { model: form.model, ...(form.effort && { effort: form.effort }) }),
    ...(form.servers && { servers: sorted(form.servers) }),
    // A shared list names only servers the agent may use itself (any, when it lists none).
    ...(form.sharedServers && { sharedServers: sorted(form.sharedServers).filter((name) => !form.servers || form.servers.has(name)) }),
    ...(form.review && { reviewBeforePosting: true }),
    ...(form.speaksUp && { speaksUp: true }),
    ...(form.assumed.length && { assumed: form.assumed }),
  };
}

const sameSet = (a: Set<string> | null, b: Set<string> | null) =>
  a === null || b === null ? a === b : a.size === b.size && [...a].every((x) => b.has(x));
function changed(a: Form, b: Form): boolean {
  const plain = (["name", "job", "instructions", "avatar", "color", "model", "effort", "review", "speaksUp"] as const).some((key) => a[key] !== b[key]);
  return plain || !sameSet(a.servers, b.servers) || !sameSet(a.sharedServers, b.sharedServers) || a.assumed.join() !== b.assumed.join();
}

/**
 * The Setup tab: one form for what a chat reads before each of the agent's turns, as the mockup draws it. Its name
 * (called as @name), job line, instructions, badge and colour, model and effort, and the servers table with its two
 * switch columns: what the agent may use when its owner asks, and what anyone else in a shared chat can make it use.
 * A field the model guessed shows as Assumed until the user changes it or says it looks right. Save sends the version
 * it read, so two editors never undo each other. For someone else's agent the form is theirs to change, and saving
 * makes their own copy.
 */
export function SetupTab({ subject, field, save, notice, onDirty }: AgentTabProps) {
  // The definition the form started from, and its version: what Undo goes back to, and what a save changes.
  const [start, setStart] = useState(() => ({ form: formOf(subject), version: versionOf(subject) }));
  const [form, setForm] = useState(start.form);
  const initial = start.form;
  // A newer version (a change made elsewhere) shows at once while the form has no changes of its own. With changes it
  // keeps them, and saving them meets the conflict rather than undoing the newer one.
  const version = versionOf(subject);
  if (version !== start.version && !changed(form, start.form)) {
    const next = { form: formOf(subject), version };
    setStart(next);
    setForm(next.form);
  }
  const [servers, setServers] = useState<AgentServerInfo[] | null>(null);
  const [serversError, setServersError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const catalog = useCatalog();
  const ids = useId();
  const box = useRef<HTMLFormElement>(null);

  useEffect(() => {
    let live = true;
    readServers().then(
      (list) => live && setServers(list),
      (e: unknown) => live && setServersError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  // A Change on a draft card: that field in view, and focused. One this tab does not show goes to the instructions,
  // which say how it runs.
  useEffect(() => {
    if (!field) return;
    const at = (name: string) => box.current?.querySelector<HTMLElement>(`[data-field="${CSS.escape(name)}"]`);
    const target = at(SHOWN_WITH[field] ?? field) ?? at("instructions");
    target?.scrollIntoView({ block: "center" });
    (target?.querySelector<HTMLElement>("input, textarea") ?? target?.querySelector<HTMLElement>(".model-trigger"))?.focus({ preventScroll: true });
  }, [field]);

  const dirty = changed(form, initial);
  // The page's header holds Turn on and off while there are changes: a new version would start the form again.
  useEffect(() => onDirty?.(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty?.(false), [onDirty]);
  const set = <K extends keyof Form>(key: K, value: Form[K], confirms = key) =>
    setForm((current) => ({ ...current, [key]: value, assumed: confirmed(current.assumed, confirms) }));
  const confirmed = (assumed: string[], key: string) => withoutAssumed(assumed, SETUP_ASSUMED[key] ?? [key]);
  const assumedBadge = (key: string) =>
    isAssumed(form.assumed, SETUP_ASSUMED[key] ?? [key]) && (
      <AssumedBadge onConfirm={() => setForm((current) => ({ ...current, assumed: confirmed(current.assumed, key) }))} />
    );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // Without the server list (it could not be read), the form saves what it has: only the table needs it.
    if (saving || (!servers && !serversError)) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await save(inputOf(form), start.version);
      if (subject.kind === "own") {
        // The form goes on from what was saved.
        const next = { form: formOf({ kind: "own", agent: saved }), version: saved.version };
        setStart(next);
        setForm(next.form);
      }
      notice({
        agentId: saved.id,
        text:
          subject.kind === "shared"
            ? `Saved your own copy, @${saved.name}, turned off. It runs with your sign-ins; the original stays as it is.`
            : subject.kind === "new"
              ? `Made @${saved.name}. Bring it into a chat, and call it there with @${saved.name}.`
              : `Saved · version ${saved.version}.`,
      });
    } catch (e) {
      const message = errorMessage(e);
      if (subject.kind === "own" && isConflict(e)) {
        // The newer version shows in place of this one: the user makes their change again on it.
        setForm(start.form);
        notice({ agentId: subject.agent.id, text: CONFLICT_NOTICE, error: true });
        await reloadAgents();
      } else setError(message);
    } finally {
      setSaving(false);
    }
  };

  const pickModel = (model: string, level?: ModelThinkingLevel) => {
    const efforts = catalog.models.find((info) => info.id === model)?.efforts ?? [];
    // A model that reasons gets an effort: the one asked for, else the one it had if the model takes it, else medium.
    const effort = !efforts.length
      ? undefined
      : level && efforts.includes(level)
        ? level
        : form.effort && efforts.includes(form.effort)
          ? form.effort
          : efforts.includes("medium")
            ? "medium"
            : efforts[0];
    setForm((current) => ({ ...current, model, effort: model === AUTO_MODEL ? undefined : effort, assumed: confirmed(current.assumed, "model") }));
  };

  const name = form.name.trim().toLowerCase();
  const own = servers ? usable(form, servers) : new Set<string>();
  const inShared = servers ? sharable(form, servers) : new Set<string>();
  const toggle = (column: "servers" | "sharedServers", server: string, on: boolean) => {
    if (!servers) return;
    setForm((current) => {
      const next = new Set(column === "servers" ? usable(current, servers) : sharable(current, servers));
      if (on) next.add(server);
      else next.delete(server);
      // Taking a server from the agent takes it from shared chats too.
      const shared = column === "servers" && !on ? new Set([...sharable(current, servers)].filter((each) => each !== server)) : undefined;
      return {
        ...current,
        [column]: next,
        ...(shared && { sharedServers: shared }),
        assumed: confirmed(current.assumed, "servers"),
      };
    });
  };

  return (
    <form className="agent-form" ref={box} onSubmit={submit}>
      {subject.kind === "shared" && <SharedNote subject={subject} />}
      {subject.kind === "own" && subject.agent.copiedFrom && (
        <p className="skills-note">
          Your copy of an agent someone shared (their version {subject.agent.copiedFrom.version}). It runs with your sign-ins; theirs stays as it was.
        </p>
      )}
      <Field id={`${ids}-name`} field="name" label="Name" badge={assumedBadge("name")} hint={name ? `called as @${name}` : "called as @name"}>
        <input
          id={`${ids}-name`}
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="research"
          maxLength={24}
          autoComplete="off"
          spellCheck={false}
          required
        />
      </Field>
      <Field id={`${ids}-job`} field="job" label="Job line" badge={assumedBadge("job")} hint="One line: the people bar and the @ list show it">
        <input
          id={`${ids}-job`}
          value={form.job}
          onChange={(e) => set("job", e.target.value)}
          maxLength={MAX_AGENT_JOB}
          placeholder="Finds and checks data before anyone builds on it"
          required
        />
      </Field>
      <Field
        id={`${ids}-instructions`}
        field="instructions"
        label="Instructions"
        badge={assumedBadge("instructions")}
        hint="Markdown: numbered steps, then the rules it follows"
      >
        <textarea
          id={`${ids}-instructions`}
          rows={9}
          value={form.instructions}
          onChange={(e) => set("instructions", e.target.value)}
          maxLength={MAX_AGENT_INSTRUCTIONS}
          placeholder={
            "1. Look up the sources first.\n2. Say which table each number comes from.\n\nDon't build pages yourself: hand charts to @builder."
          }
          required
        />
      </Field>
      <div className="agent-form-row" data-field="avatar">
        <Field id={`${ids}-avatar`} field="avatar" label="Badge" badge={assumedBadge("avatar")} hint={`Up to ${MAX_AGENT_AVATAR} letters`}>
          <span className="agent-badge-edit">
            <AgentAvatar badge={{ avatar: form.avatar.trim() || defaultAvatar(name), color: form.color || "slate" }} />
            <input
              id={`${ids}-avatar`}
              value={form.avatar}
              onChange={(e) => set("avatar", e.target.value)}
              placeholder={defaultAvatar(name)}
              size={4}
              autoComplete="off"
            />
          </span>
        </Field>
        <fieldset className="agent-colors" data-field="color">
          <legend>Colour</legend>
          {AGENT_COLORS.map((color) => (
            <label key={color} className="agent-color" title={color} style={{ "--tone": `var(--agent-${color})` } as CSSProperties}>
              <input
                type="radio"
                name={`${ids}-color`}
                value={color}
                checked={form.color === color}
                onChange={() => set("color", color, "avatar")}
                aria-label={color}
              />
            </label>
          ))}
        </fieldset>
      </div>
      <div className="agent-field" data-field="model">
        <span className="agent-label">
          Model and effort {assumedBadge("model")}
          <small>{form.model === AUTO_MODEL ? "The chat's own, as it is when the agent answers" : "Its own, whichever model the chat is on"}</small>
        </span>
        <div className="agent-model">
          <ModelPicker
            model={form.model}
            thinkingLevel={form.effort}
            auto={form.model === AUTO_MODEL}
            disabled={false}
            onChange={pickModel}
            autoLabel={CHAT_MODEL}
          />
        </div>
      </div>
      <div className="agent-field" data-field="servers">
        <span className="agent-label">
          Servers {assumedBadge("servers")}
          <small>"This agent" is what it may use when you ask; "Shared chats" is what anyone else in a shared chat can make it read.</small>
        </span>
        <ServersTable servers={servers} error={serversError} own={own} shared={inShared} name={name} onToggle={toggle} />
      </div>
      <div className="agent-field" data-field="reviewBeforePosting">
        <label className="skill-toggle agent-review">
          <input type="checkbox" checked={form.review} onChange={(e) => setForm({ ...form, review: e.target.checked })} />
          <span>
            Review before posting
            <small>
              In a shared chat, a reply built on a server it does not share with the chat shows first as a draft only you see: post it, edit it or
              discard it.
            </small>
          </span>
        </label>
      </div>
      <div className="agent-field" data-field="speaksUp">
        <span className="agent-label">
          Speaking up
          <small>
            In a chat whose owner allows it, it may post when a conversation pauses on something close to its job, or offer to pick up a question
            nobody answered: a few times a day at most, only reading, and anyone in the chat can mute it.
          </small>
        </span>
        <label className="skill-toggle">
          <input type="checkbox" checked={form.speaksUp} onChange={(e) => set("speaksUp", e.target.checked)} />
          May speak up unprompted
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="agent-form-actions">
        <button type="submit" className="primary" disabled={saving || (!servers && !serversError) || (subject.kind !== "new" && !dirty)}>
          {saving ? "Saving…" : subject.kind === "new" ? "Make the agent" : subject.kind === "shared" ? "Save as my copy" : "Save"}
        </button>
        {dirty && subject.kind !== "new" && (
          <button type="button" disabled={saving} onClick={() => setForm(initial)}>
            Undo changes
          </button>
        )}
      </div>
      {subject.kind === "own" && <UsedIn agentId={subject.agent.id} version={subject.agent.version} />}
    </form>
  );
}

/** A labelled field, with what the model guessed (`badge`) and a line on what it is (`hint`). */
function Field({
  id,
  field,
  label,
  badge,
  hint,
  children,
}: {
  id: string;
  field: string;
  label: string;
  badge?: ReactNode;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="agent-field" data-field={field}>
      <label className="agent-label" htmlFor={id}>
        {label} {badge}
        {hint && <small>{hint}</small>}
      </label>
      {children}
    </div>
  );
}

/**
 * The servers table: each of the deployment's MCP servers with whether it signs in each user, and two switches, for
 * the agent itself and for shared chats. A server that signs in as the owner and is on for shared chats says that the
 * chat sees what the agent reads from it.
 */
function ServersTable({
  servers,
  error,
  own,
  shared,
  name,
  onToggle,
}: {
  servers: AgentServerInfo[] | null;
  error: string | null;
  own: Set<string>;
  shared: Set<string>;
  name: string;
  onToggle: (column: "servers" | "sharedServers", server: string, on: boolean) => void;
}) {
  if (error) return <p className="form-error">Could not read the servers: {error}</p>;
  if (!servers) return <p className="skills-note">Reading the servers…</p>;
  if (!servers.length) return <p className="skills-note">This deployment has no MCP servers: the agent works with what it is told and its tools.</p>;
  return (
    <table className="agent-servers">
      <thead>
        <tr>
          <th scope="col">Server</th>
          <th scope="col">This agent</th>
          <th scope="col">Shared chats</th>
        </tr>
      </thead>
      <tbody>
        {servers.map((server) => {
          const mine = own.has(server.name);
          const theirs = shared.has(server.name) && mine;
          return (
            <tr key={server.name}>
              <th scope="row">
                <span className="agent-server-name">{server.name}</span>
                <small>{server.signsIn ? (server.signedIn ? "signed in as you" : "signs in as you · not yet") : "no sign-in"}</small>
                {server.signsIn && theirs && (
                  <small className="agent-server-warn">
                    Anyone in a shared chat can make @{name || "it"} read this as you, and sees what it reads.
                  </small>
                )}
              </th>
              <td>
                <Switch label={`${server.name} for this agent`} on={mine} onChange={(on) => onToggle("servers", server.name, on)} />
              </td>
              <td>
                <Switch
                  label={`${server.name} in shared chats`}
                  on={theirs}
                  disabled={!mine}
                  onChange={(on) => onToggle("sharedServers", server.name, on)}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Switch({ label, on, disabled, onChange }: { label: string; on: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="skill-toggle agent-switch" title={label}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
    </label>
  );
}

/** For someone else's agent: whose it is, that it runs as them, and what a change does; then its latest turns. */
function SharedNote({ subject }: { subject: Extract<AgentSubject, { kind: "shared" }> }) {
  const { agent } = subject;
  return (
    <div className="agent-shared-note">
      <p>
        <strong>
          @{agent.name} is {agent.ownerName}’s
        </strong>
        , shared in {subject.chatTitle ? `“${subject.chatTitle}”` : "this chat"}. It runs as {agent.ownerName}, with their sign-ins. Change anything
        below and save to make your own copy: it is saved turned off in your agents, runs with your sign-ins, and the original stays as it is.
      </p>
      {agent.turns.length > 0 && <Turns turns={agent.turns} />}
    </div>
  );
}

const TURN_STATUS: Record<AgentTurnView["status"], string> = {
  queued: "waiting",
  running: "working",
  done: "answered",
  failed: "failed",
  stopped: "stopped",
};

function Turns({ turns }: { turns: readonly AgentTurnView[] }) {
  const [now] = useState(Date.now);
  return (
    <details className="agent-turns">
      <summary>Latest turns in this chat · {turns.length}</summary>
      <ul>
        {turns.slice(0, 10).map((turn) => (
          <li key={turn.id}>
            <span>{turn.calledBy.schedule ? "On its schedule" : `For ${turn.calledBy.agentId ? "@" : ""}${turn.calledBy.name}`}</span>
            <small>
              {TURN_STATUS[turn.status]} · {sentLabel(turn.endedAt ?? turn.startedAt ?? turn.createdAt, now)}
            </small>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * The form's footer: where the agent is kept, its version and how many chats it is in, and for each of those chats a
 * switch that shares it with the people there (read-only, with a copy of their own).
 */
function UsedIn({ agentId, version }: { agentId: string; version: number }) {
  const [chats, setChats] = useState<AgentChatUse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.agentChats(agentId).then(
      (list) => live && setChats(list),
      (e: unknown) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [agentId]);
  const share = async (chatId: string, shared: boolean) => {
    setError(null);
    setChats((list) => list?.map((use) => (use.chatId === chatId ? { ...use, shared } : use)) ?? list);
    try {
      await api.shareChatAgent(chatId, agentId, shared);
    } catch (e) {
      setError(errorMessage(e));
      setChats(await api.agentChats(agentId).catch(() => null));
    }
  };
  return (
    <footer className="agent-foot">
      <p>
        Saved in your user directory · version {version} · used in {chats ? plural(chats.length, "chat") : "…"}
      </p>
      {chats && chats.length > 0 && (
        <ul className="agent-chats">
          {chats.map((use) => (
            <li key={use.chatId}>
              <a
                href={`/c/${use.chatId}`}
                onClick={(event) => {
                  if (opensElsewhere(event)) return;
                  event.preventDefault();
                  goTo(`/c/${use.chatId}`);
                }}
              >
                {use.title}
              </a>
              <label className="skill-toggle" title="The people in this chat can open it read-only, and make their own copy">
                <input type="checkbox" checked={use.shared} onChange={(e) => void share(use.chatId, e.target.checked)} />
                <small>Shared with the people in it</small>
              </label>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="form-error">{error}</p>}
    </footer>
  );
}
