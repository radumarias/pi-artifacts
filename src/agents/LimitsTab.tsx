import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AUTONOMY_LABELS, type AgentDefinition, type AgentInput, type AgentServerInfo, type AutonomyLevel } from "../../shared/agents.ts";
import { DEFAULT_APPROVAL_HOURS, MAX_APPROVAL_HOURS, type CallLogView, type CallOutcome, type GuardrailRule } from "../../shared/limits.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";
import { Icon } from "../Icon.tsx";
import { sentLabel } from "../chat/SentTime.tsx";
import type { AgentSubject, AgentTabProps } from "./AgentPage.tsx";
import { RuleList } from "./limits/RuleList.tsx";
import { readServers, reloadAgents } from "./store.ts";

/** What each level lets the agent do on its own, a line each. */
const LEVEL_MEANINGS: Record<AutonomyLevel, string> = {
  1: "Read, work out, post to its own chat and notify you; no changes.",
  2: "Also propose changes, as cards with the exact call; you press Run.",
  3: "Also queue changes that wait for your approval and expire.",
  4: "Carry out changes itself, within the rules below; every call is logged.",
};
const LEVELS = [1, 2, 3, 4] as const satisfies readonly AutonomyLevel[];

/** The tab's fields, as typed: the hours as text, so a field being typed into can be empty. */
interface Form {
  autonomy: AutonomyLevel;
  guardrails: GuardrailRule[];
  hours: string;
}

function formOf(agent: AgentDefinition): Form {
  return { autonomy: agent.autonomy, guardrails: agent.guardrails ?? [], hours: String(agent.approvalHours ?? DEFAULT_APPROVAL_HOURS) };
}

const changed = (a: Form, b: Form) =>
  a.autonomy !== b.autonomy || a.hours !== b.hours || JSON.stringify(a.guardrails) !== JSON.stringify(b.guardrails);

/**
 * The Limits tab: how far the agent may go on its own (its autonomy level), the rules on the calls it makes that change
 * data, and how long what it queues waits for approval; below, the user's rules for all their agents (saved on their
 * own) and the agent's latest calls. Only the agent's owner sees and sets its limits.
 */
export function LimitsTab(props: AgentTabProps) {
  const { subject } = props;
  if (subject.kind === "new") {
    return (
      <div className="agent-form">
        <p className="skills-note">Limits come once the agent is saved: make it in Setup first, then say here how far it may go on its own.</p>
      </div>
    );
  }
  if (subject.kind === "shared") {
    return (
      <div className="agent-form">
        <div className="agent-shared-note">
          <p>
            <strong>
              @{subject.agent.name}’s limits are {subject.agent.ownerName}’s
            </strong>
            : how far it may go on its own, and the rules on what it changes. A copy of your own has limits of its own, which you set here once it is
            yours.
          </p>
        </div>
      </div>
    );
  }
  return <OwnLimits {...props} subject={subject} />;
}

function OwnLimits({ subject, field, save, notice, onDirty }: AgentTabProps & { subject: Extract<AgentSubject, { kind: "own" }> }) {
  const { agent } = subject;
  // The limits the form started from, and their version: what Undo goes back to, and what a save changes.
  const [start, setStart] = useState(() => ({ form: formOf(agent), version: agent.version }));
  const [form, setForm] = useState(start.form);
  // A newer version shows at once while the form has no changes of its own; with changes, saving meets the conflict.
  if (agent.version !== start.version && !changed(form, start.form)) {
    const next = { form: formOf(agent), version: agent.version };
    setStart(next);
    setForm(next.form);
  }
  const [servers, setServers] = useState<AgentServerInfo[] | null>(null);
  const [serversError, setServersError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
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

  // A Change on a draft card (its autonomy, say): that field in view.
  useEffect(() => {
    if (!field) return;
    const target = box.current?.querySelector<HTMLElement>(`[data-field="${CSS.escape(field)}"]`);
    target?.scrollIntoView({ block: "center" });
    target?.querySelector<HTMLElement>("input, select, button")?.focus({ preventScroll: true });
  }, [field]);

  const dirty = changed(form, start.form);
  useEffect(() => onDirty?.(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty?.(false), [onDirty]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || editing || !dirty) return;
    const hours = Number(form.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > MAX_APPROVAL_HOURS) {
      setError(`Actions wait 1 to ${MAX_APPROVAL_HOURS} hours for approval.`);
      return;
    }
    setSaving(true);
    setError(null);
    // The page adds the fields this tab does not edit (KEPT in AgentPage.tsx), so only the limits go from here.
    const fields = {
      autonomy: form.autonomy,
      guardrails: form.guardrails,
      ...(hours !== DEFAULT_APPROVAL_HOURS && { approvalHours: hours }),
    } as AgentInput;
    try {
      const saved = await save(fields, start.version);
      const next = { form: formOf(saved), version: saved.version };
      setStart(next);
      setForm(next.form);
      notice({ agentId: saved.id, text: `Saved · version ${saved.version}.` });
    } catch (e) {
      const message = errorMessage(e);
      if (/changed since you read it/.test(message)) {
        setForm(start.form);
        notice({
          agentId: agent.id,
          text: "Someone changed this agent since you opened it, so it was reloaded with their changes. Make yours again.",
          error: true,
        });
        await reloadAgents();
      } else setError(message);
    } finally {
      setSaving(false);
    }
  };

  // Its rules may be on the servers it may use: those it lists, else every one.
  const allowed = servers && (agent.servers ? servers.filter((server) => agent.servers!.includes(server.name)) : servers);
  return (
    <div className="limits-tab">
      <form className="agent-form" ref={box} onSubmit={submit}>
        <fieldset className="limit-levels" data-field="autonomy">
          <legend className="agent-label">
            Autonomy — how far @{agent.name} may go on its own
            <small>In a chat, a turn you gave it yourself runs its changes (within the rules); anyone else’s turn only proposes.</small>
          </legend>
          <div className="limit-level-options">
            {LEVELS.map((level) => (
              <label key={level} className={form.autonomy === level ? "limit-level active" : "limit-level"}>
                <input
                  type="radio"
                  name={`${ids}-autonomy`}
                  value={level}
                  checked={form.autonomy === level}
                  onChange={() => setForm((current) => ({ ...current, autonomy: level }))}
                />
                <strong>
                  {level} {AUTONOMY_LABELS[level]}
                </strong>
                <small>{LEVEL_MEANINGS[level]}</small>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="agent-field" data-field="guardrails">
          <span className="agent-label">
            Rules
            <small>
              On the calls @{agent.name} makes that change data, besides your rules for all your agents. The strictest rule that fires wins.
            </small>
          </span>
          <RuleList
            rules={form.guardrails}
            onChange={(guardrails) => setForm((current) => ({ ...current, guardrails }))}
            servers={allowed}
            serversError={serversError}
            empty={`No rules of its own: @${agent.name} goes as far as its level lets it.`}
            onEditing={setEditing}
          />
        </div>
        <div className="agent-field" data-field="approvalHours">
          <label className="agent-label limit-hours" htmlFor={`${ids}-hours`}>
            <span>
              Actions wait for approval for{" "}
              <input
                id={`${ids}-hours`}
                type="number"
                min={1}
                max={MAX_APPROVAL_HOURS}
                step={1}
                value={form.hours}
                onChange={(e) => setForm((current) => ({ ...current, hours: e.target.value }))}
              />{" "}
              hours
            </span>
            <small>Then they expire, and nothing runs. Up to {MAX_APPROVAL_HOURS} hours (a week).</small>
          </label>
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="agent-form-actions">
          <button
            type="submit"
            className="primary"
            disabled={saving || editing || !dirty}
            title={editing ? "Finish or cancel the rule you are editing first" : undefined}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {dirty && (
            <button type="button" disabled={saving} onClick={() => setForm(start.form)}>
              Undo changes
            </button>
          )}
        </div>
      </form>
      <Section title="Rules for all your agents" hint="pi, every agent of yours and your pages, besides each one’s own rules.">
        <AllRules servers={servers} serversError={serversError} />
      </Section>
      <Section title="Recent calls" hint={`The calls @${agent.name} made that change data: what ran, and what the rules held or refused.`}>
        <CallLog agentId={agent.id} />
      </Section>
    </div>
  );
}

/** A card under the tab's form that opens and closes; what it holds is read only once it opens. */
function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section className="agent-form limits-section">
      <button type="button" className="limits-section-head" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <span>
          <strong>{title}</strong>
          <small>{hint}</small>
        </span>
        <Icon size={16} box={16}>
          <path d="M4 6l4 4 4-4" />
        </Icon>
      </button>
      {open && <div id={id}>{children}</div>}
    </section>
  );
}

/** The user's rules for all their agents, edited and saved on their own (GET and PUT /api/limits/rules). */
function AllRules({ servers, serversError }: { servers: AgentServerInfo[] | null; serversError: string | null }) {
  const [start, setStart] = useState<GuardrailRule[] | null>(null);
  const [rules, setRules] = useState<GuardrailRule[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    let live = true;
    api.guardrails().then(
      (list) => {
        if (!live) return;
        setStart(list);
        setRules(list);
      },
      (e: unknown) => live && setLoadError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  if (loadError) return <p className="form-error">Could not read your rules: {loadError}</p>;
  if (!start) return <p className="skills-note">Reading your rules…</p>;
  const dirty = JSON.stringify(rules) !== JSON.stringify(start);
  const saveAll = async () => {
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      const saved = await api.saveGuardrails(rules);
      setStart(saved);
      setRules(saved);
      setNote("Saved: they apply to every agent from its next call.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="limits-all">
      <RuleList
        rules={rules}
        onChange={(next) => {
          setNote(null);
          setRules(next);
        }}
        servers={servers}
        serversError={serversError}
        empty="No rules for all your agents yet."
        onEditing={setEditing}
      />
      {error && <p className="form-error">{error}</p>}
      {note && (
        <p className="skills-note" role="status">
          {note}
        </p>
      )}
      <div className="agent-form-actions">
        <button
          type="button"
          className="primary"
          disabled={saving || editing || !dirty}
          title={editing ? "Finish or cancel the rule you are editing first" : undefined}
          onClick={() => void saveAll()}
        >
          {saving ? "Saving…" : "Save rules for all agents"}
        </button>
        {dirty && (
          <button type="button" disabled={saving} onClick={() => setRules(start)}>
            Undo changes
          </button>
        )}
      </div>
    </div>
  );
}

const OUTCOME_TONES: Record<CallOutcome, string> = { ran: "live", warned: "review", failed: "error", refused: "error", held: "held" };

/** The agent's latest calls that change data, newest first: when, which tool, what came of it, and why. */
function CallLog({ agentId }: { agentId: string }) {
  const [calls, setCalls] = useState<CallLogView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const load = useCallback(() => {
    setError(null);
    setNow(Date.now());
    api.callLog(agentId, 50).then(setCalls, (e: unknown) => setError(errorMessage(e)));
  }, [agentId]);
  useEffect(load, [load]);
  if (error) return <p className="form-error">Could not read its calls: {error}</p>;
  if (!calls) return <p className="skills-note">Reading its calls…</p>;
  return (
    <div className="limit-calls">
      {calls.length === 0 ? (
        <p className="skills-note">No calls that change data yet.</p>
      ) : (
        <ul>
          {calls.map((call) => (
            <li key={call.id}>
              <span className="limit-call-when">{sentLabel(call.at, now)}</span>
              <code className="limit-call-tool">
                {call.server}.{call.tool}
              </code>
              <span className={`pill limit-outcome ${OUTCOME_TONES[call.outcome]}`}>{call.outcome}</span>
              {call.detail && <span className="limit-call-detail">{call.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="link-button" onClick={load}>
        Read again
      </button>
    </div>
  );
}
