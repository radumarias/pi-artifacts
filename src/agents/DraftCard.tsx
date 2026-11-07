import { useState, type MouseEvent } from "react";
import type { AgentDefinition, AgentProposedDetails } from "../../shared/agents.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";
import { Markdown } from "../chat/Markdown.tsx";
import { AgentAvatar } from "../chat/people.tsx";
import { opensElsewhere } from "../layout.tsx";
import { glanceRows, instructionSteps, runsLabel, stateLabel } from "./glance.ts";
import { agentPath, goTo } from "./nav.ts";
import { putAgent, reloadAgents, useAgents } from "./store.ts";

/** This deployment runs no Test it: its route answered 404 (the note that says so re-renders the card). */
let untestable = false;

/**
 * Where the model drafted an agent (agent_propose), in place of a plain step: its badge, name and job, whether it is
 * on, the instructions as numbered steps, and the "at a glance" rows (scope, runs, reads, tells, knows), each with a
 * Change that opens the agent's page at that field and an Assumed badge where the model guessed. Test it runs it on
 * today's data, nothing sent; Turn on turns it on as the owner read it, and brings it into this chat. Only the chat's
 * owner has the draft: anyone else sees that pi drafted it for them.
 */
export function DraftCard({ details, chatId, mine }: { details: AgentProposedDetails; chatId: string; mine: boolean }) {
  const { agents } = useAgents();
  const agent = mine ? agents?.find((known) => known.id === details.agentId) : undefined;
  if (!mine) {
    return (
      <div className="agent-card compact">
        <p>
          pi drafted an agent, <strong>@{details.name}</strong>, for the chat's owner to review.
        </p>
      </div>
    );
  }
  if (!agent) {
    return (
      <div className="agent-card compact">
        <p>{agents === null ? `Loading the draft of @${details.name}…` : `The draft of @${details.name} was deleted.`}</p>
      </div>
    );
  }
  return <Card agent={agent} chatId={chatId} />;
}

function Card({ agent, chatId }: { agent: AgentDefinition; chatId: string }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const state = stateLabel(agent);
  const steps = instructionSteps(agent.instructions);
  const rows = glanceRows(agent);
  const runs = runsLabel(agent.trigger);
  const scope = agent.scope?.list;
  const when = [runs && `${runs.value}${runs.note ? ` (${runs.note})` : ""}`, scope && `for each item of ${scope.server} ${scope.tool}`]
    .filter(Boolean)
    .join(", ");
  const open = (field?: string) => (event: MouseEvent) => {
    if (opensElsewhere(event)) return;
    event.preventDefault();
    goTo(agentPath({ id: agent.id, field, chat: chatId }));
  };

  const turnOn = async () => {
    setBusy(true);
    setNote(null);
    try {
      putAgent(await api.setAgentEnabled(agent, true));
      // Drafted for this chat: it joins it, so it can be called here at once.
      const joined = await api.addChatAgent(chatId, agent.id).then(
        () => null,
        (e: unknown) => errorMessage(e),
      );
      setNote(
        joined === null
          ? { text: `@${agent.name} is on and in this chat: call it with @${agent.name}.` }
          : { text: `@${agent.name} is on, but it could not join this chat: ${joined}`, error: true },
      );
    } catch (e) {
      setNote({ text: errorMessage(e), error: true });
      void reloadAgents();
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    setNote(null);
    try {
      await api.testAgent(agent.id);
      setNote({ text: "Testing it on today's data: nothing is sent or changed. Its result shows under its runs." });
    } catch (e) {
      if ((e as { status?: number }).status === 404) {
        untestable = true;
        setNote({ text: "Testing an agent is not available here yet." });
      } else setNote({ text: errorMessage(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="agent-card" aria-label={`Agent @${agent.name}`}>
      <header className="agent-card-head">
        <AgentAvatar badge={agent} />
        <div className="agent-card-title">
          <a href={agentPath({ id: agent.id, chat: chatId })} onClick={open()}>
            <strong>{agent.name}</strong>
          </a>
          <span>{agent.job}</span>
        </div>
        <span className={`pill agent-state ${state.tone}`}>{state.text}</span>
        <div className="agent-card-actions">
          {!untestable && (
            <button type="button" disabled={busy} onClick={() => void test()}>
              Test it
            </button>
          )}
          {!agent.enabled && (
            <button type="button" className="primary" disabled={busy} onClick={() => void turnOn()}>
              Turn on
            </button>
          )}
        </div>
      </header>
      {when && <p className="agent-card-when">{when}.</p>}
      <div className="agent-card-steps">
        {steps ? (
          <>
            <ol>
              {steps.steps.map((step, i) => (
                <li key={i}>
                  <Markdown text={step} />
                </li>
              ))}
            </ol>
            {steps.rest && (
              <details>
                <summary>And its rules</summary>
                <Markdown text={steps.rest} />
              </details>
            )}
          </>
        ) : (
          <Markdown text={agent.instructions} />
        )}
      </div>
      <dl className="agent-glance">
        {rows.map((row) => (
          <div key={row.key} className={row.assumed ? "agent-glance-row assumed" : "agent-glance-row"}>
            <dt>{row.label}</dt>
            <dd>
              <span className="agent-glance-value">
                {row.value}
                {row.assumed && <span className="pill assumed">Assumed</span>}
              </span>
              {row.note && <small>{row.note}</small>}
            </dd>
            <a className="agent-glance-change" href={agentPath({ id: agent.id, field: row.field, chat: chatId })} onClick={open(row.field)}>
              Change
            </a>
          </div>
        ))}
      </dl>
      {note && (
        <p className={note.error ? "form-error" : "skills-note"} role="status">
          {note.text}
        </p>
      )}
    </article>
  );
}
