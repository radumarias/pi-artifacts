import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AgentDefinition } from "../../shared/agents.ts";
import type { AgentRunDetail, AgentRunList, AgentRunView, RunDelivery, RunItemView } from "../../shared/runs.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";
import { Markdown } from "../chat/Markdown.tsx";
import { sentLabel } from "../chat/SentTime.tsx";
import { formatCost } from "../chat/spend.ts";
import { StepRun, StepsProvider } from "../chat/Steps.tsx";
import type { StepItem } from "../chat/stepRuns.ts";
import { RUNS_EVENT } from "../chat/useChat.ts";
import { opensElsewhere } from "../layout.tsx";
import type { AgentTabProps } from "./AgentPage.tsx";
import { runsLabel } from "./glance.ts";
import { agentPath } from "./nav.ts";
import { anyRunning, deliveryLabel, itemsLabel, itemStatusLabel, runStatusLabel, took, whyLabel } from "./runs.ts";

/** How often the tab reads again while a run is going. */
const POLL_MS = 3_000;

/** A link inside the app: it follows the page's navigate, and opens in a new tab or window as asked. */
function AppLink({ path, navigate, className, children }: { path: string; navigate: (path: string) => void; className?: string; children: ReactNode }) {
  return (
    <a
      href={path}
      className={className}
      onClick={(event) => {
        if (opensElsewhere(event)) return;
        event.preventDefault();
        navigate(path);
      }}
    >
      {children}
    </a>
  );
}

/**
 * Read `load` now, again when `key` changes, every POLL_MS while `polling` says so, and when this agent's home chat
 * says its runs changed (RUNS_EVENT, while that chat is open somewhere in this window).
 */
function useRead<T>(load: () => Promise<T>, agentId: string, key: string, polling: (value: T) => boolean) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const again = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    load().then(
      (read) => {
        if (!live) return;
        setValue(read);
        setError(null);
      },
      (e: unknown) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  useEffect(() => {
    const changed = (event: Event) => (event as CustomEvent<string>).detail === agentId && again();
    addEventListener(RUNS_EVENT, changed);
    return () => removeEventListener(RUNS_EVENT, changed);
  }, [agentId, again]);
  const poll = value !== null && polling(value);
  useEffect(() => {
    if (!poll) return;
    const timer = setTimeout(again, POLL_MS);
    return () => clearTimeout(timer);
  }, [poll, tick, again]);
  return { value, error, again };
}

/**
 * The Runs tab: when the agent runs next, Test it, and its runs, newest first; a run opens on what it sent and how it
 * got there, item by item, down to each item's full trace. Only for the user's own agents.
 */
export function RunsTab({ subject, place, navigate }: AgentTabProps) {
  if (subject.kind !== "own" || !place || !navigate) {
    return <p className="skills-note agent-runs-note">{subject.kind === "new" ? "Save the agent first: its runs show here." : "Only its owner sees an agent's runs."}</p>;
  }
  return place.run === undefined ? (
    <RunList agent={subject.agent} chat={place.chat} navigate={navigate} />
  ) : (
    <RunPage agent={subject.agent} dueAt={place.run} chat={place.chat} navigate={navigate} />
  );
}

function RunList({ agent, chat, navigate }: { agent: AgentDefinition; chat?: string; navigate: (path: string) => void }) {
  const { value, error, again } = useRead<AgentRunList>(() => api.agentRuns(agent.id), agent.id, agent.id, (read) => anyRunning(read.runs));
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const runs = runsLabel(agent.trigger);
  const test = async () => {
    setTesting(true);
    setTestError(null);
    try {
      const { dueAt } = await api.testAgent(agent.id);
      navigate(agentPath({ id: agent.id, tab: "runs", chat, run: dueAt }));
    } catch (e) {
      setTestError(errorMessage(e));
      again();
    } finally {
      setTesting(false);
    }
  };
  const now = Date.now();
  return (
    <section className="agent-runs">
      <div className="agent-runs-head">
        <div className="agent-runs-when">
          <strong>{runs ? runs.value : "Runs only when asked"}</strong>
          {runs?.note && <small>{runs.note}</small>}
          {value?.nextRunAt && <small>Next run {aheadLabel(value.nextRunAt, now)}</small>}
          {runs && !agent.enabled && <small>Off: it runs again once you turn it on.</small>}
        </div>
        <div className="agent-runs-actions">
          {value?.homeChatId && (
            <AppLink path={`/c/${value.homeChatId}`} navigate={navigate} className="button-link">
              Open its chat
            </AppLink>
          )}
          <button type="button" className="primary" disabled={testing} onClick={() => void test()}>
            {testing ? "Starting…" : "Test it"}
          </button>
        </div>
      </div>
      <p className="skills-note">Test it runs it now on today's data: nothing is sent or changed, and what it would have sent shows in the run.</p>
      {testError && <p className="form-error">{testError}</p>}
      {error && <p className="form-error">Could not read its runs: {error}</p>}
      {value === null && !error && <p className="skills-note">Reading its runs…</p>}
      {value && !value.runs.length && <p className="skills-note">No runs yet.</p>}
      {value && value.runs.length > 0 && (
        <ol className="run-list">
          {value.runs.map((run) => (
            <li key={run.dueAt}>
              <AppLink path={agentPath({ id: agent.id, tab: "runs", chat, run: run.dueAt })} navigate={navigate} className="run-row">
                <RunPill run={run} />
                <span className="run-row-text">
                  <span className="run-row-when">
                    {sentLabel(run.startedAt, now)} · {whyLabel(run.why)}
                    {itemsLabel(run.items) && ` · ${itemsLabel(run.items)}`}
                  </span>
                  {run.summary && <span className="run-row-summary">{run.summary}</span>}
                </span>
                {run.cost > 0 && <span className="run-row-cost">{formatCost(run.cost)}</span>}
              </AppLink>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** A time ahead, as the runs list says it: "today at 07:00", "Mon at 07:00", or the date. */
function aheadLabel(at: number, now: number): string {
  const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = new Date(at).toDateString();
  if (day === new Date(now).toDateString()) return `today at ${time}`;
  if (day === new Date(now + 86_400_000).toDateString()) return `tomorrow at ${time}`;
  if (at - now < 6 * 86_400_000) return `${new Date(at).toLocaleDateString([], { weekday: "long" })} at ${time}`;
  return `${new Date(at).toLocaleDateString([], { month: "short", day: "numeric" })} at ${time}`;
}

function RunPill({ run }: { run: Pick<AgentRunView, "status" | "test"> }) {
  const state = runStatusLabel(run);
  return (
    <span className="run-pills">
      <span className={`pill run-state ${state.tone}`}>{state.text}</span>
      {run.test && <span className="pill run-test">Test</span>}
    </span>
  );
}

function RunPage({ agent, dueAt, chat, navigate }: { agent: AgentDefinition; dueAt: number; chat?: string; navigate: (path: string) => void }) {
  const { value: run, error } = useRead<AgentRunDetail>(
    () => api.agentRun(agent.id, dueAt),
    agent.id,
    `${agent.id}:${dueAt}`,
    (read) => read.status === "running",
  );
  const back = (
    <AppLink path={agentPath({ id: agent.id, tab: "runs", chat })} navigate={navigate} className="agent-back">
      ← All runs
    </AppLink>
  );
  if (!run) return <section className="agent-runs">{back}<p className={error ? "form-error" : "skills-note"}>{error ? `Could not read this run: ${error}` : "Reading the run…"}</p></section>;
  const scoped = run.itemsList.length > 1 || Boolean(run.itemsList[0]?.label);
  return (
    <section className="agent-runs run-detail">
      {back}
      <header className="run-detail-head">
        <RunPill run={run} />
        <h3>{new Date(run.startedAt).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</h3>
        <small>
          {whyLabel(run.why)} · {run.when}
          {took(run.startedAt, run.endedAt) && ` · took ${took(run.startedAt, run.endedAt)}`}
          {run.cost > 0 && ` · ${formatCost(run.cost)}`}
        </small>
      </header>
      {run.test && <p className="skills-note">A test: nothing was sent or changed. Below is what it would have sent.</p>}
      {run.status === "needs_sign_in" && run.needsSignIn && (
        <p className="form-error">
          It waits for you to sign in to {run.needsSignIn.join(", ")}. Sign in from a chat (ask pi to connect it); the run goes on by itself after.
        </p>
      )}
      {run.status === "failed" && run.summary && <p className="form-error">{run.summary}</p>}

      <h4 className="run-section">What it sent</h4>
      {run.deliveries.length ? (
        <ul className="run-deliveries">
          {run.deliveries.map((delivery, index) => (
            <Delivery key={index} delivery={delivery} />
          ))}
        </ul>
      ) : (
        <p className="skills-note">{run.status === "running" ? "Nothing yet: it sends once every item is done." : "Nothing: no item got to a step that sends."}</p>
      )}

      <h4 className="run-section">How it got there</h4>
      {scoped && <p className="skills-note">{itemsLabel(run.items) || `${run.itemsList.length} item`}</p>}
      <ol className="run-items">
        {run.itemsList.map((item) => (
          <RunItem key={item.item} agentId={agent.id} dueAt={run.dueAt} item={item} scoped={scoped} />
        ))}
      </ol>

      {(run.used.servers.length > 0 || run.used.skills.length > 0 || run.used.models.length > 0) && (
        <dl className="run-used">
          {run.used.servers.length > 0 && (
            <div>
              <dt>Read</dt>
              <dd>{run.used.servers.join(", ")}</dd>
            </div>
          )}
          {run.used.skills.length > 0 && (
            <div>
              <dt>Skills</dt>
              <dd>{run.used.skills.join(", ")}</dd>
            </div>
          )}
          {run.used.models.length > 0 && (
            <div>
              <dt>Models</dt>
              <dd>{run.used.models.join(", ")}</dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}

function Delivery({ delivery }: { delivery: RunDelivery }) {
  const tone = delivery.status === "sent" ? "on" : delivery.status === "recorded" ? "draft" : delivery.status === "failed" ? "error" : "off";
  return (
    <li className="run-delivery">
      <div className="run-delivery-line">
        <span>{deliveryLabel(delivery)}</span>
        <span className={`pill run-state ${tone}`}>{{ sent: "Sent", recorded: "Recorded", refused: "Not sent", failed: "Failed" }[delivery.status]}</span>
      </div>
      {delivery.detail && <small>{delivery.detail}</small>}
      {delivery.text && (
        <div className="bubble markdown run-report">
          <Markdown text={delivery.text} />
        </div>
      )}
    </li>
  );
}

function RunItem({ agentId, dueAt, item, scoped }: { agentId: string; dueAt: number; item: RunItemView; scoped: boolean }) {
  const [trace, setTrace] = useState(false);
  return (
    <li className={`run-item ${item.status}`}>
      {scoped && (
        <div className="run-item-head">
          <strong>{item.label}</strong>
          <span className="pill">{itemStatusLabel(item.status)}</span>
        </div>
      )}
      <ol className="run-steps">
        {item.steps.map((step, index) => (
          <li key={index} className={step.ok ? "run-step" : "run-step stopped"}>
            <span className="run-step-mark" aria-label={step.ok ? "Done" : "Stopped"}>
              {step.ok ? "✓" : "•"}
            </span>
            <span className="run-step-text">
              <span>{step.label}</span>
              {step.detail && <small>{step.detail}</small>}
            </span>
            <span className="run-step-time">
              {step.ms >= 100 && took(0, step.ms)}
              {step.cost ? ` · ${formatCost(step.cost)}` : ""}
            </span>
          </li>
        ))}
        {item.status === "running" && <li className="run-step running">Running…</li>}
      </ol>
      {item.reason && item.status !== "acted" && <p className={item.status === "failed" ? "form-error" : "skills-note"}>{item.reason}</p>}
      {item.session && (
        <button type="button" className="link-button" aria-expanded={trace} onClick={() => setTrace(!trace)}>
          {trace ? "Hide its full trace" : "Show its full trace"}
        </button>
      )}
      {trace && <RunTrace agentId={agentId} dueAt={dueAt} item={item.item} />}
    </li>
  );
}

/** One item's session as it ran: what it was given, its steps (as the chat shows them) and what it answered. */
function RunTrace({ agentId, dueAt, item }: { agentId: string; dueAt: number; item: string }) {
  const [entries, setEntries] = useState<EntryRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.agentRunTrace(agentId, dueAt, item).then(
      ({ entries }) => live && setEntries(entries),
      (e: unknown) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [agentId, dueAt, item]);
  if (error) return <p className="form-error">Could not read its trace: {error}</p>;
  if (!entries) return <p className="skills-note">Reading its trace…</p>;
  if (!entries.length) return <p className="skills-note">Its session has nothing yet.</p>;
  return (
    <div className="run-trace">
      <StepsProvider entries={entries} tools={[]} busy={false}>
        {entries.map((entry) => (
          <TraceEntry key={entry.id} entry={entry} />
        ))}
      </StepsProvider>
    </div>
  );
}

function TraceEntry({ entry }: { entry: EntryRecord }) {
  const message = entry.model?.[0];
  if (message?.role === "assistant") {
    const answer = message as AssistantMessage;
    const items: StepItem[] = answer.content.flatMap((block, i): StepItem[] => {
      if (block?.type === "toolCall") return [{ kind: "tool", key: block.id, call: block, streaming: false }];
      if (block?.type === "thinking" && !block.redacted && block.thinking.trim()) return [{ kind: "thought", key: `${entry.id}:${i}`, text: block.thinking }];
      return [];
    });
    const text = answer.content.flatMap((block) => (block?.type === "text" && block.text ? [block.text] : [])).join("\n\n");
    return (
      <>
        {items.length > 0 && <StepRun items={items} />}
        {text && (
          <div className="bubble markdown">
            <Markdown text={text} />
          </div>
        )}
      </>
    );
  }
  if (message?.role === "user") {
    const said = message as UserMessage;
    const text = typeof said.content === "string" ? said.content : said.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n\n");
    if (!text) return null;
    return (
      <details className="run-trace-input">
        <summary>{firstLineOf(text)}</summary>
        <pre>{text}</pre>
      </details>
    );
  }
  return null;
}

function firstLineOf(text: string): string {
  const line = text.split("\n").find((part) => part.trim()) ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}
