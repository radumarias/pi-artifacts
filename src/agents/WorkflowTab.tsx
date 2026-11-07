import { useEffect, useId, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  inputOf,
  MAX_WATCH_MINUTES,
  MIN_WATCH_MINUTES,
  STEP_KINDS,
  WEEKDAYS,
  type AgentDefinition,
  type AgentInput,
  type AgentStep,
  type AgentTrigger,
  type LookStep,
  type StepInput,
  type Weekday,
} from "../../shared/agents.ts";
import { conditionProblem } from "../../shared/conditions.ts";
import { STEP_LABELS } from "../../shared/runs.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";
import type { AgentTabProps } from "./AgentPage.tsx";
import { runsLabel } from "./glance.ts";
import { putAgent } from "./store.ts";
import { moveItem, newStep, stepSummary, withKeys, withoutKeys, type Keyed } from "./workflow.ts";

const DAY_LABELS: Record<Weekday, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const VIEWER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

type When = "asked" | "schedule" | "watch";

/** The tab's form: the trigger as its three ways, the scope's list read, and the steps with keys of their own. */
interface Form {
  when: When;
  at: string;
  tz: string;
  days: Weekday[];
  watch: LookStep;
  everyMinutes: number;
  condition: string;
  each: boolean;
  list: LookStep;
  steps: Keyed[];
}

const EMPTY_LOOK: LookStep = { kind: "look", server: "", tool: "", input: {} };

function formOf(agent: Pick<AgentDefinition, "trigger" | "scope" | "workflow">): Form {
  const trigger = agent.trigger;
  return {
    when: trigger ? trigger.kind : "asked",
    at: trigger?.kind === "schedule" ? trigger.at : "07:00",
    tz: trigger?.kind === "schedule" ? trigger.tz : VIEWER_ZONE,
    days: trigger?.kind === "schedule" ? (trigger.days ?? [...WEEKDAYS]) : [...WEEKDAYS],
    watch: trigger?.kind === "watch" ? trigger.step : EMPTY_LOOK,
    everyMinutes: trigger?.kind === "watch" ? trigger.everyMinutes : 60,
    condition: trigger?.kind === "watch" ? trigger.when : "",
    each: Boolean(agent.scope),
    list: agent.scope?.list ?? EMPTY_LOOK,
    steps: withKeys(agent.workflow ?? []),
  };
}

function triggerOf(form: Form): AgentTrigger | undefined {
  if (form.when === "schedule") return { kind: "schedule", at: form.at, tz: form.tz, ...(form.days.length < 7 && { days: form.days }) };
  if (form.when === "watch") return { kind: "watch", step: form.watch, everyMinutes: form.everyMinutes, when: form.condition };
  return undefined;
}

/**
 * The Workflow tab: when the agent runs on its own (a time, or a watch), whether it runs once for each item of a list,
 * and its steps, which the app runs one by one: only "Work out" calls the model. Steps can be edited, added, removed
 * and reordered (drag, or Alt+Up and Alt+Down), or compiled again from the instructions. Someone else's agent shows
 * read-only.
 */
export function WorkflowTab({ subject, save, notice, onDirty }: AgentTabProps) {
  if (subject.kind === "new") return <p className="skills-note agent-runs-note">Save the agent first: its workflow is made from its instructions.</p>;
  return <WorkflowForm agent={subject.agent} readOnly={subject.kind === "shared"} save={save} notice={notice} onDirty={onDirty} />;
}

function WorkflowForm({
  agent,
  readOnly,
  save,
  notice,
  onDirty,
}: {
  agent: Pick<AgentDefinition, "id" | "trigger" | "scope" | "workflow" | "name"> & Partial<AgentDefinition>;
  readOnly: boolean;
} & Pick<AgentTabProps, "save" | "notice" | "onDirty">) {
  const [form, setForm] = useState(() => formOf(agent));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => onDirty?.(dirty), [dirty, onDirty]);
  const change = (next: Partial<Form>) => {
    setForm((current) => ({ ...current, ...next }));
    setDirty(true);
  };
  const markInvalid = (id: string, bad: boolean) =>
    setInvalid((current) => {
      if (current.has(id) === bad) return current;
      const next = new Set(current);
      if (bad) next.add(id);
      else next.delete(id);
      return next;
    });
  const conditionError = form.when === "watch" && form.condition.trim() ? conditionProblem(form.condition) : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (readOnly || !("version" in agent)) return;
    setSaving(true);
    setError(null);
    try {
      const fields: AgentInput = {
        ...inputOf(agent as AgentDefinition),
        trigger: triggerOf(form),
        scope: form.each ? { list: form.list, each: true } : undefined,
        workflow: form.steps.length ? withoutKeys(form.steps) : undefined,
      };
      await save(fields);
      setDirty(false);
      notice({ agentId: agent.id, text: "Saved its workflow." });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const compile = async () => {
    setSaving(true);
    setError(null);
    try {
      putAgent(await api.compileAgent(agent.id));
      notice({ agentId: agent.id, text: "Made its steps again from its instructions." });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const schedule = runsLabel(triggerOf(form));
  return (
    <form className="agent-form workflow-form" onSubmit={submit}>
      <fieldset className="workflow-section" disabled={readOnly}>
        <legend className="agent-label">When it runs on its own</legend>
        <div className="workflow-when" role="radiogroup" aria-label="When it runs">
          {(
            [
              ["asked", "Only when asked"],
              ["schedule", "At a time"],
              ["watch", "When something changes"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="workflow-choice">
              <input type="radio" name="when" checked={form.when === value} onChange={() => change({ when: value })} />
              {label}
            </label>
          ))}
        </div>
        {form.when === "schedule" && (
          <div className="agent-form-row">
            <Field label="Time">
              {(id) => <input id={id} type="time" value={form.at} required onChange={(e) => change({ at: e.target.value })} />}
            </Field>
            <Field label="Time zone">{(id) => <input id={id} value={form.tz} required onChange={(e) => change({ tz: e.target.value })} />}</Field>
            <div className="agent-field">
              <span className="agent-label">Days</span>
              <div className="workflow-days">
                {WEEKDAYS.map((day) => (
                  <label key={day} className="workflow-day">
                    <input
                      type="checkbox"
                      checked={form.days.includes(day)}
                      onChange={(e) => change({ days: e.target.checked ? WEEKDAYS.filter((d) => d === day || form.days.includes(d)) : form.days.filter((d) => d !== day) })}
                    />
                    {DAY_LABELS[day]}
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}
        {form.when === "watch" && (
          <>
            <LookFields look={form.watch} onChange={(watch) => change({ watch })} id="watch" markInvalid={markInvalid} />
            <div className="agent-form-row">
              <Field label="Check every (minutes)">
                {(id) => (
                  <input
                    id={id}
                    type="number"
                    min={MIN_WATCH_MINUTES}
                    max={MAX_WATCH_MINUTES}
                    value={form.everyMinutes}
                    onChange={(e) => change({ everyMinutes: Number(e.target.value) })}
                  />
                )}
              </Field>
              <Field label="Runs when" hint={`over its result as ${form.watch.as || "its tool's name"}, and previous: the one before`} grow>
                {(id) => (
                  <input id={id} value={form.condition} placeholder="price.last > 100" required onChange={(e) => change({ condition: e.target.value })} />
                )}
              </Field>
            </div>
            {conditionError && <p className="form-error">{conditionError}</p>}
          </>
        )}
        {schedule && form.when !== "asked" && (
          <p className="skills-note">
            {schedule.value}
            {schedule.note && ` · ${schedule.note}`}
          </p>
        )}
      </fieldset>

      <fieldset className="workflow-section" disabled={readOnly}>
        <legend className="agent-label">For each</legend>
        <label className="workflow-choice">
          <input type="checkbox" checked={form.each} onChange={(e) => change({ each: e.target.checked })} />
          Run once for each item of a list (each region, each client), each in a session of its own
        </label>
        {form.each && <LookFields look={form.list} onChange={(list) => change({ list })} id="scope" markInvalid={markInvalid} noName />}
      </fieldset>

      <fieldset className="workflow-section" disabled={readOnly}>
        <legend className="agent-label">
          Steps
          <small>The app runs them in order. Only “Work out” calls the model; a condition that does not hold ends the run for today, at no cost.</small>
        </legend>
        <StepList steps={form.steps} onChange={(steps) => change({ steps })} markInvalid={markInvalid} readOnly={readOnly} />
        {!form.steps.length && <p className="skills-note">No steps yet: a run works out its instructions in one step and tells you in its chat.</p>}
      </fieldset>

      {error && <p className="form-error">{error}</p>}
      {!readOnly && (
        <div className="agent-form-actions">
          <button type="submit" className="primary" disabled={saving || !dirty || invalid.size > 0 || Boolean(conditionError)}>
            {saving ? "Saving…" : "Save workflow"}
          </button>
          {dirty && (
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setForm(formOf(agent));
                setInvalid(new Set());
                setDirty(false);
              }}
            >
              Undo changes
            </button>
          )}
          <button type="button" disabled={saving || dirty} title={dirty ? "Save or undo your changes first" : undefined} onClick={() => void compile()}>
            Make the steps again from its instructions
          </button>
        </div>
      )}
    </form>
  );
}

function Field({ label, hint, grow, children }: { label: string; hint?: string; grow?: boolean; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className={grow ? "agent-field grow" : "agent-field"}>
      <label className="agent-label" htmlFor={id}>
        {label}
        {hint && <small>{hint}</small>}
      </label>
      {children(id)}
    </div>
  );
}

/** A tool input as JSON text: told up only when it reads, and marked invalid (keeping save off) while it does not. */
function JsonField({ id, value, onChange, markInvalid }: { id: string; value: StepInput; onChange: (value: StepInput) => void; markInvalid: (id: string, bad: boolean) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 1));
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => () => markInvalid(id, false), [id, markInvalid]);
  return (
    <Field label="Input" hint="JSON; {{name.path}} puts in an earlier result, {{item}} the current item">
      {(htmlId) => (
        <>
          <textarea
            id={htmlId}
            rows={2}
            spellCheck={false}
            className="workflow-json"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              try {
                const parsed: unknown = JSON.parse(e.target.value || "{}");
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("An input is a JSON object, as {}.");
                setProblem(null);
                markInvalid(id, false);
                onChange(parsed as StepInput);
              } catch (error) {
                setProblem(error instanceof SyntaxError ? "Not JSON yet." : errorMessage(error));
                markInvalid(id, true);
              }
            }}
          />
          {problem && <small className="form-error">{problem}</small>}
        </>
      )}
    </Field>
  );
}

function LookFields({
  look,
  onChange,
  id,
  markInvalid,
  noName,
}: {
  look: LookStep;
  onChange: (look: LookStep) => void;
  id: string;
  markInvalid: (id: string, bad: boolean) => void;
  noName?: boolean;
}) {
  return (
    <div className="agent-form-row">
      <Field label="Server">{(htmlId) => <input id={htmlId} value={look.server} required onChange={(e) => onChange({ ...look, server: e.target.value })} />}</Field>
      <Field label="Tool">{(htmlId) => <input id={htmlId} value={look.tool} required onChange={(e) => onChange({ ...look, tool: e.target.value })} />}</Field>
      {!noName && (
        <Field label="Name its result">
          {(htmlId) => (
            <input
              id={htmlId}
              value={look.as ?? ""}
              placeholder={look.tool || "sales"}
              onChange={(e) => {
                const { as: _, ...rest } = look;
                onChange(e.target.value ? { ...rest, as: e.target.value } : rest);
              }}
            />
          )}
        </Field>
      )}
      <JsonField id={`${id}:input`} value={look.input} onChange={(input) => onChange({ ...look, input })} markInvalid={markInvalid} />
    </div>
  );
}

/** Steps in order, each a card that opens to edit; reordered by drag or Alt+Up and Alt+Down; an if holds two lists. */
function StepList({
  steps,
  onChange,
  markInvalid,
  readOnly,
}: {
  steps: Keyed[];
  onChange: (steps: Keyed[]) => void;
  markInvalid: (id: string, bad: boolean) => void;
  readOnly: boolean;
}) {
  const dragging = useRef<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [adding, setAdding] = useState<AgentStep["kind"]>("look");
  const move = (from: number, to: number) => {
    if (to < 0 || to >= steps.length || from === to) return;
    onChange(moveItem(steps, from, to));
  };
  const keyMove = (index: number) => (event: KeyboardEvent) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const to = index + (event.key === "ArrowUp" ? -1 : 1);
    move(index, to);
    // Focus follows the card it moved.
    requestAnimationFrame(() => (event.currentTarget.parentElement?.children[to]?.querySelector("summary") as HTMLElement | null)?.focus());
  };
  return (
    <>
      <ol className="workflow-steps">
        {steps.map((step, index) => (
          <li
            key={step.key}
            className={over === index ? "workflow-step over" : "workflow-step"}
            draggable={!readOnly}
            onDragStart={(event: DragEvent) => {
              dragging.current = index;
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => {
              if (dragging.current === null) return;
              event.preventDefault();
              setOver(index);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(event) => {
              event.preventDefault();
              if (dragging.current !== null) move(dragging.current, index);
              dragging.current = null;
              setOver(null);
            }}
            onDragEnd={() => {
              dragging.current = null;
              setOver(null);
            }}
            onKeyDown={readOnly ? undefined : keyMove(index)}
          >
            <details>
              <summary title={readOnly ? undefined : "Drag, or Alt+Up and Alt+Down, to move it"}>
                <span className="workflow-step-handle" aria-hidden="true">
                  ⋮⋮
                </span>
                <span className="workflow-step-kind">{STEP_LABELS[step.step.kind]}</span>
                <span className="workflow-step-summary">{stepSummary(step.step)}</span>
              </summary>
              <StepFields
                step={step}
                onChange={(next) => onChange(steps.map((each) => (each.key === step.key ? next : each)))}
                markInvalid={markInvalid}
                readOnly={readOnly}
              />
              {!readOnly && (
                <div className="workflow-step-actions">
                  <button type="button" disabled={index === 0} onClick={() => move(index, index - 1)}>
                    Move up
                  </button>
                  <button type="button" disabled={index === steps.length - 1} onClick={() => move(index, index + 1)}>
                    Move down
                  </button>
                  <button type="button" className="danger" onClick={() => onChange(steps.filter((each) => each.key !== step.key))}>
                    Remove
                  </button>
                </div>
              )}
            </details>
          </li>
        ))}
      </ol>
      {!readOnly && (
        <div className="workflow-add">
          <select aria-label="Kind of step to add" value={adding} onChange={(e) => setAdding(e.target.value as AgentStep["kind"])}>
            {STEP_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {STEP_LABELS[kind]}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => onChange([...steps, ...withKeys([newStep(adding)])])}>
            Add step
          </button>
        </div>
      )}
    </>
  );
}

/** The fields of one step, by its kind. */
function StepFields({ step, onChange, markInvalid, readOnly }: { step: Keyed; onChange: (step: Keyed) => void; markInvalid: (id: string, bad: boolean) => void; readOnly: boolean }) {
  const set = (fields: Partial<AgentStep>) => onChange({ ...step, step: { ...step.step, ...fields } as AgentStep });
  const s = step.step;
  switch (s.kind) {
    case "look":
      return <LookFields look={s} onChange={(look) => onChange({ ...step, step: look })} id={step.key} markInvalid={markInvalid} />;
    case "work":
      return (
        <div className="agent-form-row">
          <Field label="What to work out" grow>
            {(id) => <textarea id={id} rows={3} value={s.prompt} required onChange={(e) => set({ prompt: e.target.value })} />}
          </Field>
          <Field label="With the skill" hint="optional">
            {(id) => <input id={id} value={s.skill ?? ""} onChange={(e) => onChange({ ...step, step: withOptional(s, "skill", e.target.value) })} />}
          </Field>
        </div>
      );
    case "onlyIf":
    case "if": {
      const problem = s.condition.trim() ? conditionProblem(s.condition) : null;
      return (
        <>
          <Field label={s.kind === "if" ? "If" : "Only if"} hint="over the results by their names: sales.total vs sales.lastYear < -5%" grow>
            {(id) => <input id={id} value={s.condition} required onChange={(e) => set({ condition: e.target.value })} />}
          </Field>
          {problem && <p className="form-error">{problem}</p>}
          {step.then && (
            <div className="workflow-branch">
              <span className="agent-label">Then</span>
              <StepList steps={step.then} onChange={(then) => onChange({ ...step, then })} markInvalid={markInvalid} readOnly={readOnly} />
              <span className="agent-label">Otherwise</span>
              <StepList steps={step.else ?? []} onChange={(otherwise) => onChange({ ...step, else: otherwise })} markInvalid={markInvalid} readOnly={readOnly} />
            </div>
          )}
        </>
      );
    }
    case "do":
      return (
        <>
          <p className="skills-note">A write: it waits for your approval, which comes later. Until then a run says what it would do.</p>
          <div className="agent-form-row">
            <Field label="Server">{(id) => <input id={id} value={s.server} required onChange={(e) => set({ server: e.target.value })} />}</Field>
            <Field label="Tool">{(id) => <input id={id} value={s.tool} required onChange={(e) => set({ tool: e.target.value })} />}</Field>
            <JsonField id={`${step.key}:input`} value={s.input} onChange={(input) => set({ input })} markInvalid={markInvalid} />
          </div>
        </>
      );
    case "tell":
      return (
        <div className="agent-form-row">
          <Field label="To" hint={'"owner" for you in its chat, or the title of one of your chats it is in'} grow>
            {(id) => (
              <input
                id={id}
                value={s.to.join(", ")}
                required
                onChange={(e) =>
                  set({
                    to: e.target.value
                      .split(",")
                      .map((to) => to.trim())
                      .filter(Boolean),
                  })
                }
              />
            )}
          </Field>
          <Field label="How">
            {(id) => (
              <select id={id} value={typeof s.via === "string" ? s.via : "chat"} onChange={(e) => set({ via: e.target.value as "chat" | "notify" })}>
                <option value="chat">Post in chat</option>
                <option value="notify">Notify</option>
              </select>
            )}
          </Field>
        </div>
      );
    case "page":
      return (
        <div className="agent-form-row">
          <Field label="Page (artifact id)">{(id) => <input id={id} value={s.artifactId} required onChange={(e) => set({ artifactId: e.target.value })} />}</Field>
          <Field label="How">
            {(id) => (
              <select id={id} value={s.edit} onChange={(e) => set({ edit: e.target.value as "findings" | "rebuild" })}>
                <option value="findings">Put the report in its findings block</option>
                <option value="rebuild">Rebuild it with today's data</option>
              </select>
            )}
          </Field>
        </div>
      );
    case "handOver":
      return (
        <Field label="Hand the report to" hint="another of your agents, by name">
          {(id) => <input id={id} value={s.agent} required onChange={(e) => set({ agent: e.target.value.replace(/^@/, "") })} />}
        </Field>
      );
  }
}

/** `step` with an optional text field set, or left out when empty. */
function withOptional<T extends AgentStep, K extends keyof T & string>(step: T, key: K, value: string): T {
  const { [key]: _, ...rest } = step;
  return (value ? { ...rest, [key]: value } : rest) as T;
}
